import axios from 'axios';
import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { logger } from '../../lib/logger';

class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(count: number) { this.count = count; }

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.count > 0) {
        this.count--;
        resolve(() => this.release());
      } else {
        this.queue.push(() => { this.count--; resolve(() => this.release()); });
      }
    });
  }

  private release() {
    this.count++;
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.count--;
      next();
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class GTOConnector implements SourceConnector {
  readonly sourceType = 'gto';

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { api_key, base_url } = credentials as any;
    if (!api_key || !base_url) return false;
    try {
      const resp = await axios.get(`${base_url}/api/private/openapi`, {
        headers: { 'X-Api-Key': api_key },
        timeout: 10000,
      });
      return resp.status < 400;
    } catch {
      return false;
    }
  }

  async fetchData(credentials: Record<string, unknown>, settings: Record<string, string>, period: { start: Date; end: Date }): Promise<ConnectorResult> {
    const { api_key, base_url } = credentials as any;
    const timeout = parseInt(settings['request_timeout_seconds'] || '30') * 1000;
    const retryCount = parseInt(settings['retry_count'] || '3');
    const retryBackoff = parseInt(settings['retry_backoff_seconds'] || '2');
    const maxParallel = parseInt(settings['max_parallel_requests'] || '5');
    const semaphore = new Semaphore(maxParallel);

    const periodParams = {
      date_from: period.start.toISOString().slice(0, 10),
      date_to: period.end.toISOString().slice(0, 10),
    };

    const endpoints = [
      { name: 'orders', path: '/api/private/orders', params: periodParams },
      { name: 'payments', path: '/api/private/payments', params: periodParams },
    ];

    const warnings: string[] = [];
    const metrics: Record<string, unknown> = {};

    await Promise.all(endpoints.map(async (ep) => {
      const release = await semaphore.acquire();
      try {
        const data = await this.fetchWithRetry(base_url, ep.path, ep.params, api_key, timeout, retryCount, retryBackoff);
        metrics[ep.name] = data;
      } catch (err: any) {
        warnings.push(`Failed to fetch ${ep.name}: ${err.message}`);
        metrics[ep.name] = null;
      } finally {
        release();
      }
    }));

    const computed = this.computeAnalytics(metrics, period);

    return {
      success: true,
      data: {
        sourceId: 'gto',
        sourceName: 'GTO Sales API',
        fetchedAt: new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        timezone: settings['timezone'] || 'UTC',
        metrics: { raw: metrics, computed },
        rawSampleSize: Object.values(metrics).filter(Boolean).length,
        warnings,
      },
    };
  }

  private async fetchWithRetry(baseUrl: string, path: string, params: any, apiKey: string, timeout: number, retryCount: number, backoffSec: number): Promise<unknown> {
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const resp = await axios.get(`${baseUrl}${path}`, {
          params,
          headers: { 'X-Api-Key': apiKey },
          timeout,
        });
        return resp.data;
      } catch (err: any) {
        if (attempt === retryCount) throw err;
        await sleep(backoffSec * Math.pow(2, attempt) * 1000);
      }
    }
  }

  private computeAnalytics(metrics: Record<string, unknown>, period: { start: Date; end: Date }) {
    const orders = Array.isArray(metrics['orders']) ? metrics['orders'] as any[] : [];
    const payments = Array.isArray(metrics['payments']) ? metrics['payments'] as any[] : [];
    const totalRevenue = payments.reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
    return {
      total_orders: orders.length,
      total_revenue: totalRevenue,
      avg_order_value: orders.length > 0 ? totalRevenue / orders.length : 0,
      period_days: Math.ceil((period.end.getTime() - period.start.getTime()) / 86400000),
      data_available: orders.length > 0 || payments.length > 0,
    };
  }
}
