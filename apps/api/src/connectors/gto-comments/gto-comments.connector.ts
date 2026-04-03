import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { logger } from '../../lib/logger';
import { createHttpClient } from '../../lib/http';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const DEFAULT_BASE_URL = 'https://api.gto.ua/api/private';
const PARALLEL_REQUESTS = 8;

// Per period: fetch details for at most this many orders
const MAX_ORDERS_PER_PERIOD = 120;
// Max comment texts per status per period sent to LLM
const MAX_COMMENTS_PER_STATUS = 60;
// Max urgent comments highlighted
const MAX_URGENT = 8;
// Max text length per comment
const MAX_TEXT_LEN = 220;

const fmt = (d: Date) => d.toISOString().slice(0, 10);

// ─── Semaphore ────────────────────────────────────────────────────────────────
class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];
  constructor(n: number) { this.count = n; }
  acquire(): Promise<() => void> {
    return new Promise(resolve => {
      if (this.count > 0) { this.count--; resolve(() => this.release()); }
      else { this.queue.push(() => { this.count--; resolve(() => this.release()); }); }
    });
  }
  private release() {
    this.count++;
    if (this.queue.length > 0) { const next = this.queue.shift()!; this.count--; next(); }
  }
}

const stripHtml = (s: string) =>
  s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

// Skip auto-generated payment deadline messages and very short/noise
const isUsefulComment = (text: string): boolean => {
  const t = text.trim();
  if (t.length < 8) return false;
  if (/^\+?\d[\d\s()\-]{5,}$/.test(t)) return false;           // phone only
  if (/Повна оплата .{0,80} має бути здійснена/i.test(t)) return false; // auto payment reminder
  if (/Передоплата .{0,80} в розмірі .{0,40} має бути/i.test(t)) return false;
  return true;
};

export class GTOCommentsConnector implements SourceConnector {
  readonly sourceType = 'gto_comments';

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { api_key, base_url } = credentials as any;
    if (!api_key) return false;
    const url = (base_url || DEFAULT_BASE_URL).replace(/\/$/, '');
    try {
      const client = createHttpClient({ baseURL: url, params: { apikey: api_key }, timeout: 10000 }, 'gto-comments');
      const resp = await client.get('/orders_list', { params: { per_page: 1 } });
      return resp.status < 400;
    } catch { return false; }
  }

  async fetchData(
    credentials: Record<string, unknown>,
    settings: Record<string, string>,
    period: { start: Date; end: Date },
  ): Promise<ConnectorResult> {
    const { api_key, base_url } = credentials as any;
    const baseUrl      = (base_url || DEFAULT_BASE_URL).replace(/\/$/, '');
    const timeout      = parseInt(settings['request_timeout_seconds'] || '30') * 1000;
    const retryCount   = parseInt(settings['retry_count'] || '3');
    const retryBackoff = parseInt(settings['retry_backoff_seconds'] || '2');

    const http = createHttpClient({ baseURL: baseUrl, params: { apikey: api_key }, timeout }, 'gto-comments');
    const sem  = new Semaphore(PARALLEL_REQUESTS);

    // ── fetchList (one page, sorted desc by created_at) ────────────────────
    const fetchList = async (dateFrom: Date, dateTo: Date): Promise<any[]> => {
      const allItems: any[] = [];
      let page = 1;
      for (;;) {
        let pageData: any[] = [];
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          try {
            const resp = await http.get('/orders_list', {
              params: { date_from: fmt(dateFrom), date_to: fmt(dateTo), sort_by: 'created_at', per_page: 1000, page },
            });
            const data = resp.data;
            if (Array.isArray(data)) { pageData = data; break; }
            if (data?.data && Array.isArray(data.data)) { pageData = data.data; break; }
            break;
          } catch (err: any) {
            if (attempt === retryCount) { logger.warn({ err: err.message }, 'gto-comments fetchList failed'); break; }
            await sleep(retryBackoff * Math.pow(2, attempt) * 1000);
          }
        }
        allItems.push(...pageData);
        if (pageData.length < 1000) break;
        page++;
      }
      return allItems;
    };

    const fetchDetail = async (orderId: number): Promise<any | null> => {
      const release = await sem.acquire();
      try {
        const resp = await http.get('/order_data', { params: { order_id: orderId } });
        return resp.data?.data ?? resp.data ?? null;
      } catch { return null; }
      finally { release(); }
    };

    // ── Build period data ──────────────────────────────────────────────────
    const buildPeriodData = async (orders: any[], periodLabel: string) => {
      // Take most recent orders up to limit
      const limited = orders.slice(-MAX_ORDERS_PER_PERIOD);
      logger.info({ period: periodLabel, total: orders.length, fetching: limited.length }, 'GTO Comments: fetching details');

      const details = await Promise.all(limited.map(o => fetchDetail(Number(o.order_id))));

      const commentsByStatus: Record<string, string[]> = {
        cnf: [], cnx: [], orq: [], pen: [], other: []
      };
      const urgentComments: Array<{ orderId: string | number; status: string; text: string }> = [];
      const statsCounts: Record<string, number> = {
        cnf_total: 0, cnf_with_comments: 0,
        cnx_total: 0, cnx_with_comments: 0,
        orq_total: 0, orq_with_comments: 0,
        pen_total: 0, pen_with_comments: 0,
        other_total: 0, other_with_comments: 0,
      };

      for (let i = 0; i < limited.length; i++) {
        const order  = limited[i];
        const detail = details[i];
        if (!detail) continue;

        const status = (order.status || detail.status || 'other').toUpperCase();
        const statusKey = ['CNF', 'CNX', 'ORQ', 'PEN'].includes(status) ? status.toLowerCase() : 'other';

        statsCounts[`${statusKey}_total`]++;

        const rawComments: Array<{ type: string; comment: string; created_at: string }> =
          Array.isArray(detail.comment) ? detail.comment : [];

        let hasUsefulComment = false;
        for (const c of rawComments) {
          const text = stripHtml(c.comment || '').slice(0, MAX_TEXT_LEN);
          if (!isUsefulComment(text)) continue;

          hasUsefulComment = true;
          if (commentsByStatus[statusKey].length < MAX_COMMENTS_PER_STATUS) {
            commentsByStatus[statusKey].push(text);
          }

          if (c.type === 'urgent' && urgentComments.length < MAX_URGENT) {
            urgentComments.push({ orderId: order.order_id, status: status, text });
          }
        }

        if (hasUsefulComment) {
          statsCounts[`${statusKey}_with_comments`]++;
        }
      }

      return {
        stats: {
          total_orders:          orders.length,
          cnf_orders:            statsCounts.cnf_total,
          cnf_with_comments:     statsCounts.cnf_with_comments,
          cnx_orders:            statsCounts.cnx_total,
          cnx_with_comments:     statsCounts.cnx_with_comments,
          orq_orders:            statsCounts.orq_total,
          orq_with_comments:     statsCounts.orq_with_comments,
          pen_orders:            statsCounts.pen_total,
          pen_with_comments:     statsCounts.pen_with_comments,
          other_orders:          statsCounts.other_total,
          other_with_comments:   statsCounts.other_with_comments,
        },
        cnf_comments:   commentsByStatus.cnf,
        cnx_comments:   commentsByStatus.cnx,
        orq_comments:   commentsByStatus.orq,
        pen_comments:   commentsByStatus.pen,
        other_comments: commentsByStatus.other,
        urgent_comments: urgentComments,
      };
    };

    logger.info({ periodStart: fmt(period.start), periodEnd: fmt(period.end) }, 'GTO Comments: fetching order lists...');
    const requestedOrders = await fetchList(period.start, period.end);
    const requestedData = await buildPeriodData(requestedOrders, 'requested_period');

    return {
      success: true,
      data: {
        sourceId:    'gto_comments',
        sourceName:  'GTO Comments Analysis',
        fetchedAt:   new Date().toISOString(),
        periodStart: fmt(period.start),
        periodEnd:   fmt(period.end),
        timezone:    settings['timezone'] || 'Europe/Kiev',
        metrics: {
          requested_period: {
            period: { from: fmt(period.start), to: fmt(period.end) },
            ...requestedData,
          },
        },
      },
    };
  }
}
