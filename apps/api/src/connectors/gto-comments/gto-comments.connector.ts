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
    _period: { start: Date; end: Date },
  ): Promise<ConnectorResult> {
    const { api_key, base_url } = credentials as any;
    const baseUrl      = (base_url || DEFAULT_BASE_URL).replace(/\/$/, '');
    const timeout      = parseInt(settings['request_timeout_seconds'] || '30') * 1000;
    const retryCount   = parseInt(settings['retry_count'] || '3');
    const retryBackoff = parseInt(settings['retry_backoff_seconds'] || '2');

    const http = createHttpClient({ baseURL: baseUrl, params: { apikey: api_key }, timeout }, 'gto-comments');
    const sem  = new Semaphore(PARALLEL_REQUESTS);

    // ── Date ranges ────────────────────────────────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday   = new Date(today.getTime() - 86400000);
    const last7dFrom  = new Date(today.getTime() - 7  * 86400000);
    const last30dFrom = new Date(today.getTime() - 30 * 86400000);

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

      const cnfComments: string[] = [];
      const cnxComments: string[] = [];
      const urgentComments: Array<{ orderId: string | number; text: string }> = [];
      let cnfTotal = 0, cnxTotal = 0, cnfWithComments = 0, cnxWithComments = 0;

      for (let i = 0; i < limited.length; i++) {
        const order  = limited[i];
        const detail = details[i];
        if (!detail) continue;

        const status = order.status || detail.status || '';
        if (status === 'CNF') cnfTotal++;
        else if (status === 'CNX') cnxTotal++;

        const rawComments: Array<{ type: string; comment: string; created_at: string }> =
          Array.isArray(detail.comment) ? detail.comment : [];

        for (const c of rawComments) {
          const text = stripHtml(c.comment || '').slice(0, MAX_TEXT_LEN);
          if (!isUsefulComment(text)) continue;

          if (status === 'CNF') {
            if (cnfComments.length < MAX_COMMENTS_PER_STATUS) cnfComments.push(text);
            if (c.type === 'urgent' && urgentComments.length < MAX_URGENT) {
              urgentComments.push({ orderId: order.order_id, text });
            }
            cnfWithComments++;
          } else if (status === 'CNX') {
            if (cnxComments.length < MAX_COMMENTS_PER_STATUS) cnxComments.push(text);
            if (c.type === 'urgent' && urgentComments.length < MAX_URGENT) {
              urgentComments.push({ orderId: order.order_id, text });
            }
            cnxWithComments++;
          }
        }
      }

      return {
        stats: {
          total_orders:        orders.length,
          cnf_orders:          cnfTotal,
          cnx_orders:          cnxTotal,
          cnf_with_comments:   cnfWithComments,
          cnx_with_comments:   cnxWithComments,
        },
        confirmed_comments: cnfComments,   // flat array of comment texts for LLM
        cancelled_comments: cnxComments,
        urgent_comments:    urgentComments,
      };
    };

    // ── Fetch all 4 periods in parallel ────────────────────────────────────
    logger.info('GTO Comments: fetching order lists...');
    const [todayOrders, yesterdayOrders, last7dOrders, last30dOrders] = await Promise.all([
      fetchList(today,       new Date(today.getTime() + 86400000)),
      fetchList(yesterday,   today),
      fetchList(last7dFrom,  today),
      fetchList(last30dFrom, today),
    ]);

    const [todayData, yesterdayData, last7dData, last30dData] = await Promise.all([
      buildPeriodData(todayOrders,    'today'),
      buildPeriodData(yesterdayOrders,'yesterday'),
      buildPeriodData(last7dOrders,   'last_7d'),
      buildPeriodData(last30dOrders,  'last_30d'),
    ]);

    return {
      success: true,
      data: {
        sourceId:    'gto_comments',
        sourceName:  'GTO Comments Analysis',
        fetchedAt:   new Date().toISOString(),
        periodStart: fmt(last30dFrom),
        periodEnd:   fmt(today),
        timezone:    settings['timezone'] || 'Europe/Kiev',
        metrics: {
          today: {
            period: { from: fmt(today), to: fmt(new Date(today.getTime() + 86400000)) },
            ...todayData,
          },
          yesterday: {
            period: { from: fmt(yesterday), to: fmt(today) },
            ...yesterdayData,
          },
          last_7_days: {
            period: { from: fmt(last7dFrom), to: fmt(today) },
            ...last7dData,
          },
          last_30_days: {
            period: { from: fmt(last30dFrom), to: fmt(today) },
            ...last30dData,
          },
        },
      },
    };
  }
}
