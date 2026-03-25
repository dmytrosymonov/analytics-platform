import axios from 'axios';
import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { logger } from '../../lib/logger';
import { CurrencyService, CurrencyRates } from '../../lib/currency.service';
import { prisma } from '../../lib/prisma';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const DEFAULT_BASE_URL   = 'https://api.gto.ua/api/private';
const DEFAULT_V3_BASE_URL = 'https://api.gto.ua/api/v3';

export class GTOConnector implements SourceConnector {
  readonly sourceType = 'gto';

  private client(baseUrl: string, apiKey: string, timeout: number) {
    return axios.create({
      baseURL: baseUrl,
      params: { apikey: apiKey },
      timeout,
    });
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { api_key, base_url } = credentials as any;
    if (!api_key) return false;
    const url = (base_url || DEFAULT_BASE_URL).replace(/\/$/, '');
    try {
      const resp = await axios.get(`${url}/orders_list`, {
        params: { apikey: api_key, per_page: 1 },
        timeout: 10000,
      });
      return resp.status < 400;
    } catch {
      return false;
    }
  }

  async fetchData(
    credentials: Record<string, unknown>,
    settings: Record<string, string>,
    period: { start: Date; end: Date }
  ): Promise<ConnectorResult> {
    const { api_key, base_url } = credentials as any;
    const baseUrl   = (base_url || DEFAULT_BASE_URL).replace(/\/$/, '');
    const timeout   = parseInt(settings['request_timeout_seconds'] || '30') * 1000;
    const retryCount    = parseInt(settings['retry_count'] || '3');
    const retryBackoff  = parseInt(settings['retry_backoff_seconds'] || '2');

    // GTO v3 base URL — from system settings or default
    const v3BaseUrl = await this.getV3BaseUrl();

    // Fetch currency rates (cached daily in Redis)
    let rates: CurrencyRates | null = null;
    try {
      rates = await CurrencyService.getRates(api_key, v3BaseUrl);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Currency rates unavailable, amounts will not be converted to EUR');
    }

    const http = this.client(baseUrl, api_key, timeout);

    const dateFrom = period.start.toISOString().slice(0, 10);
    const dateTo   = period.end.toISOString().slice(0, 10);

    const warnings: string[] = [];
    if (!rates) warnings.push('Currency rates unavailable — amounts shown in original currencies');

    const fetchEndpoint = async (path: string, params: Record<string, unknown>): Promise<any[]> => {
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          const resp = await http.get(path, { params: { ...params, per_page: 1000 } });
          const data = resp.data;
          if (Array.isArray(data)) return data;
          if (data && Array.isArray(data.data)) return data.data;
          return [];
        } catch (err: any) {
          if (attempt === retryCount) throw err;
          await sleep(retryBackoff * Math.pow(2, attempt) * 1000);
        }
      }
      return [];
    };

    const [orders, paymentsIn, paymentsOut, invoicesIn, invoicesOut] = await Promise.all([
      fetchEndpoint('/orders_list', { date_from: dateFrom, date_to: dateTo, sort_by: 'created_at' })
        .catch(e => { warnings.push(`orders_list: ${e.message}`); return []; }),
      fetchEndpoint('/payments_list', { type: 'in', date_from: dateFrom, date_to: dateTo })
        .catch(e => { warnings.push(`payments_list(in): ${e.message}`); return []; }),
      fetchEndpoint('/payments_list', { type: 'out', date_from: dateFrom, date_to: dateTo })
        .catch(e => { warnings.push(`payments_list(out): ${e.message}`); return []; }),
      fetchEndpoint('/invoices_list', { type: 'in', date_from: dateFrom, date_to: dateTo })
        .catch(e => { warnings.push(`invoices_list(in): ${e.message}`); return []; }),
      fetchEndpoint('/invoices_list', { type: 'out', date_from: dateFrom, date_to: dateTo })
        .catch(e => { warnings.push(`invoices_list(out): ${e.message}`); return []; }),
    ]);

    const computed = this.computeAnalytics(
      { orders, paymentsIn, paymentsOut, invoicesIn, invoicesOut },
      period,
      rates,
    );

    return {
      success: true,
      data: {
        sourceId: 'gto',
        sourceName: 'GTO Sales API',
        fetchedAt: new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        timezone: settings['timezone'] || 'Europe/Kiev',
        currency: {
          base: 'EUR',
          ratesDate: rates?.fetchedAt?.slice(0, 10) ?? null,
          ratesAvailable: !!rates,
        },
        metrics: {
          // Raw data intentionally omitted from LLM payload to save tokens.
          // Only computed (EUR-normalized) metrics go to ChatGPT.
          computed,
        },
        warnings,
      },
    };
  }

  private async getV3BaseUrl(): Promise<string> {
    try {
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'gto.v3_base_url' } });
      return (setting?.value || DEFAULT_V3_BASE_URL).replace(/\/$/, '');
    } catch {
      return DEFAULT_V3_BASE_URL;
    }
  }

  private computeAnalytics(
    data: { orders: any[]; paymentsIn: any[]; paymentsOut: any[]; invoicesIn: any[]; invoicesOut: any[] },
    period: { start: Date; end: Date },
    rates: CurrencyRates | null,
  ) {
    const { orders, paymentsIn, paymentsOut, invoicesIn, invoicesOut } = data;

    const toEur = (amount: number, currency: string): number => {
      if (!rates) return amount;
      return CurrencyService.toEur(amount, currency || 'EUR', rates);
    };

    // Orders by status
    const confirmedOrders = orders.filter(o => o.status === 'CNF');
    const cancelledOrders = orders.filter(o => o.status === 'CNX');
    const pendingOrders   = orders.filter(o => !['CNF', 'CNX'].includes(o.status));

    // Payments (exclude revoked)
    const activePaymentsIn  = paymentsIn.filter(p => !p.is_revoked);
    const activePaymentsOut = paymentsOut.filter(p => !p.is_revoked);

    // Revenue in EUR
    let incomingEur = 0;
    let outgoingEur = 0;
    const paymentsDetail: Array<{ date: string; amountEur: number; currency: string; form: string }> = [];

    for (const p of activePaymentsIn) {
      const currency = p.currency_code || p.balance_currency_code || 'UAH';
      const amountEur = toEur(parseFloat(p.amount) || 0, currency);
      incomingEur += amountEur;
      paymentsDetail.push({ date: p.date, amountEur, currency, form: p.payment_form || '' });
    }
    for (const p of activePaymentsOut) {
      const currency = p.currency_code || p.balance_currency_code || 'UAH';
      outgoingEur += toEur(parseFloat(p.amount) || 0, currency);
    }

    // Invoices in EUR
    const activeInvoicesIn  = invoicesIn.filter(i => !i.is_revoked);
    const activeInvoicesOut = invoicesOut.filter(i => !i.is_revoked);
    let invoicedEur = 0;
    for (const i of activeInvoicesIn) {
      invoicedEur += toEur(parseFloat(i.amount) || 0, i.currency || 'UAH');
    }

    // Top companies by order count
    const companyCounts: Record<string, number> = {};
    for (const o of confirmedOrders) {
      if (o.company_name) companyCounts[o.company_name] = (companyCounts[o.company_name] || 0) + 1;
    }
    const topCompanies = Object.entries(companyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, orders: count }));

    // Orders by day
    const ordersByDay: Record<string, number> = {};
    for (const o of orders) {
      const day = (o.created_at || '').slice(0, 10);
      if (day) ordersByDay[day] = (ordersByDay[day] || 0) + 1;
    }

    const periodDays = Math.max(1, Math.ceil((period.end.getTime() - period.start.getTime()) / 86400000));

    return {
      currency_note: rates
        ? `All monetary values in EUR (rates from ${rates.fetchedAt.slice(0, 10)})`
        : 'Currency rates unavailable — values in original currencies',
      period_days: periodDays,
      orders: {
        total: orders.length,
        confirmed: confirmedOrders.length,
        cancelled: cancelledOrders.length,
        pending: pendingOrders.length,
        cancellation_rate_pct: orders.length > 0 ? Math.round(cancelledOrders.length / orders.length * 100) : 0,
        avg_per_day: Math.round(orders.length / periodDays * 10) / 10,
        by_day: ordersByDay,
        top_companies: topCompanies,
      },
      payments: {
        incoming_eur: Math.round(incomingEur * 100) / 100,
        outgoing_eur: Math.round(outgoingEur * 100) / 100,
        net_eur: Math.round((incomingEur - outgoingEur) * 100) / 100,
        incoming_count: activePaymentsIn.length,
        outgoing_count: activePaymentsOut.length,
        avg_payment_eur: activePaymentsIn.length > 0
          ? Math.round(incomingEur / activePaymentsIn.length * 100) / 100
          : 0,
        daily_detail: paymentsDetail,
      },
      invoices: {
        issued_count: activeInvoicesIn.length,
        issued_amount_eur: Math.round(invoicedEur * 100) / 100,
        outgoing_count: activeInvoicesOut.length,
      },
      data_available: orders.length > 0 || activePaymentsIn.length > 0,
    };
  }
}
