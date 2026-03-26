import axios from 'axios';
import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { logger } from '../../lib/logger';
import { CurrencyService, CurrencyRates } from '../../lib/currency.service';
import { prisma } from '../../lib/prisma';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const DEFAULT_BASE_URL    = 'https://api.gto.ua/api/private';
const DEFAULT_V3_BASE_URL = 'https://api.gto.ua/api/v3';
const MAX_DETAIL_ORDERS   = 300; // max per period to avoid overloading API
const PARALLEL_REQUESTS   = 8;

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

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const r2  = (n: number) => Math.round(n * 100) / 100;

// ─── Connector ────────────────────────────────────────────────────────────────
export class GTOConnector implements SourceConnector {
  readonly sourceType = 'gto';

  private httpClient(baseUrl: string, apiKey: string, timeout: number) {
    return axios.create({ baseURL: baseUrl, params: { apikey: apiKey }, timeout });
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
    const v3BaseUrl    = await this.getV3BaseUrl();

    // Currency rates (cached daily in Redis)
    let rates: CurrencyRates | null = null;
    try { rates = await CurrencyService.getRates(api_key, v3BaseUrl); }
    catch (e: any) { logger.warn({ err: e.message }, 'Currency rates unavailable'); }

    const http     = this.httpClient(baseUrl, api_key, timeout);
    const sem      = new Semaphore(PARALLEL_REQUESTS);
    const warnings: string[] = [];
    if (!rates) warnings.push('Currency rates unavailable — amounts in original currencies');

    // ── Date ranges ────────────────────────────────────────────────────────
    // period.end = start of today (UTC), period.start = start of yesterday
    const today      = new Date(period.end);
    const yesterday  = new Date(period.start);
    const last7dFrom = new Date(today.getTime() - 7 * 86400000);
    const next7dTo   = new Date(today.getTime() + 7 * 86400000);

    // Summer months relative to today
    const year = today.getMonth() >= 9 ? today.getFullYear() + 1 : today.getFullYear();

    // ── Helpers ────────────────────────────────────────────────────────────
    const fetchList = async (
      path: string,
      params: Record<string, unknown>,
    ): Promise<any[]> => {
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          const resp = await http.get(path, { params: { ...params, per_page: 1000 } });
          const data = resp.data;
          if (Array.isArray(data)) return data;
          if (data?.data && Array.isArray(data.data)) return data.data;
          return [];
        } catch (err: any) {
          if (attempt === retryCount) { logger.warn({ path, err: err.message }, 'fetchList failed'); return []; }
          await sleep(retryBackoff * Math.pow(2, attempt) * 1000);
        }
      }
      return [];
    };

    const fetchDetail = async (orderId: number): Promise<any | null> => {
      const release = await sem.acquire();
      try {
        const resp = await http.get('/order_data', { params: { order_id: orderId } });
        return resp.data?.data ?? resp.data ?? null;
      } catch { return null; }
      finally { release(); }
    };

    // ── Fetch all order lists in parallel ──────────────────────────────────
    logger.info('GTO: fetching order lists for all periods...');
    const [
      ordersYesterday,
      ordersLast7d,
      ordersUpcoming,
      ordersJune,
      ordersJuly,
      ordersAugust,
    ] = await Promise.all([
      // Section 1 — yesterday (by created_at)
      fetchList('/orders_list', { date_from: fmt(yesterday), date_to: fmt(today), sort_by: 'created_at' }),
      // Section 2 — last 7 days (by created_at)
      fetchList('/orders_list', { date_from: fmt(last7dFrom), date_to: fmt(today), sort_by: 'created_at' }),
      // Section 3 — upcoming tours (start date = next 7 days, confirmed only)
      fetchList('/orders_list', { date_from: fmt(today), date_to: fmt(next7dTo), sort_by: 'date_start', status: 'CNF' }),
      // Section 4 — summer months by date_start (confirmed only)
      fetchList('/orders_list', { date_from: `${year}-06-01`, date_to: `${year}-06-30`, sort_by: 'date_start', status: 'CNF' }),
      fetchList('/orders_list', { date_from: `${year}-07-01`, date_to: `${year}-07-31`, sort_by: 'date_start', status: 'CNF' }),
      fetchList('/orders_list', { date_from: `${year}-08-01`, date_to: `${year}-08-31`, sort_by: 'date_start', status: 'CNF' }),
    ]);

    // ── Collect unique order IDs to fetch details for ──────────────────────
    // Priority: yesterday first (small, need all), then upcoming, last7d, summer (larger, limit)
    const detailIds = new Set<number>();
    const addIds = (list: any[], limit = MAX_DETAIL_ORDERS) => {
      let n = 0;
      for (const o of list) {
        if (n >= limit) break;
        if (o.order_id && !detailIds.has(o.order_id)) { detailIds.add(o.order_id); n++; }
      }
    };
    addIds(ordersYesterday, 200);
    addIds(ordersUpcoming, 200);
    addIds(ordersLast7d, MAX_DETAIL_ORDERS);
    addIds(ordersJune, MAX_DETAIL_ORDERS);
    addIds(ordersJuly, MAX_DETAIL_ORDERS);
    addIds(ordersAugust, MAX_DETAIL_ORDERS);

    logger.info({ total: detailIds.size }, 'GTO: fetching order details...');

    // Fetch all details in parallel with semaphore
    const detailMap = new Map<number, any>();
    await Promise.all([...detailIds].map(id =>
      fetchDetail(id).then(d => { if (d) detailMap.set(id, d); })
    ));

    logger.info({ fetched: detailMap.size }, 'GTO: order details fetched');

    // ── Compute sections ───────────────────────────────────────────────────
    const s1 = this.computeSalesSection(ordersYesterday, detailMap, rates);
    const s2 = this.computeSalesSection(ordersLast7d, detailMap, rates);
    const s3 = this.computeUpcomingSection(ordersUpcoming, detailMap, rates);
    const s4 = {
      year,
      june:   this.computeSummerMonth('Июнь',   ordersJune,   detailMap, rates),
      july:   this.computeSummerMonth('Июль',   ordersJuly,   detailMap, rates),
      august: this.computeSummerMonth('Август', ordersAugust, detailMap, rates),
    };

    return {
      success: true,
      data: {
        sourceId:    'gto',
        sourceName:  'GTO Sales API',
        fetchedAt:   new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd:   period.end.toISOString(),
        timezone:    settings['timezone'] || 'Europe/Kiev',
        currency:    { base: 'EUR', ratesDate: rates?.fetchedAt?.slice(0, 10) ?? null },
        metrics: {
          computed: {
            currency_note: rates
              ? `All amounts in EUR (rates date: ${rates.fetchedAt.slice(0, 10)})`
              : 'Currency rates unavailable',
            section1_yesterday:     { period: { from: fmt(yesterday), to: fmt(today) }, ...s1 },
            section2_last_7_days:   { period: { from: fmt(last7dFrom), to: fmt(today) }, ...s2 },
            section3_upcoming_tours: { period: { from: fmt(today), to: fmt(next7dTo) }, ...s3 },
            section4_summer:        s4,
          },
        },
        warnings,
      },
    };
  }

  // ── Metric extraction from one order ──────────────────────────────────────
  private extractOrder(
    orderSummary: any,
    detail: any | null,
    rates: CurrencyRates | null,
  ) {
    if (!detail) return null;

    const toEur = (amount: number, currency: string) =>
      rates ? CurrencyService.toEur(amount, currency || 'UAH', rates) : amount;

    // Tourists
    const tourists = Array.isArray(detail.tourist) ? detail.tourist.length : 0;

    // Destinations (primary country)
    const countries: string[] = [];
    if (Array.isArray(detail.country)) {
      for (const c of detail.country) if (c.name) countries.push(c.name);
    }

    // Currency of order
    const orderCurrency = detail.currency || orderSummary?.currency || 'UAH';

    // Financials: sell = total_amount; cost = sum of price_buy across hotels + services
    const priceEur = toEur(parseFloat(detail.total_amount) || 0, orderCurrency);

    let costEur = 0;
    const hotels   = Array.isArray(detail.hotel)   ? detail.hotel   : [];
    const services = Array.isArray(detail.service) ? detail.service : [];

    // Hotels: trust hotel.currency (hotels are reliably priced in EUR internationally)
    for (const h of hotels) {
      const priceBuy = parseFloat(h.price_buy) || 0;
      if (priceBuy > 0) costEur += toEur(priceBuy, h.currency || orderCurrency);
    }

    // Services: GTO sometimes labels service.currency='EUR' but price_buy is actually in UAH.
    // Sanity check: if converting with service.currency gives a cost > entire order revenue,
    // the currency label is wrong → fall back to order currency.
    for (const s of services) {
      const priceBuy = parseFloat(s.price_buy) || 0;
      if (priceBuy <= 0) continue;
      const convertedWithServiceCurrency = toEur(priceBuy, s.currency || orderCurrency);
      if (convertedWithServiceCurrency > priceEur && priceEur > 0) {
        // Currency label is unreliable — use order currency instead
        costEur += toEur(priceBuy, orderCurrency);
      } else {
        costEur += convertedWithServiceCurrency;
      }
    }

    const profitEur = priceEur - costEur;
    const profitPct = priceEur > 0 ? Math.round(profitEur / priceEur * 100) : 0;

    // Product classification
    // Hotel: has hotel[] entries with status != CNX
    const activeHotels   = hotels.filter((h: any) => h.status !== 'CNX');
    const hasHotel       = activeHotels.length > 0;
    // Flight: service[] with flight_details OR service_type_name containing avia/air
    const activeServices = services.filter((s: any) => s.status !== 'CNX');
    const hasFlight      = activeServices.some((s: any) =>
      (s.flight_details?.segment?.length > 0) ||
      (s.service_type_name || s.type || '').toLowerCase().match(/avia|авіа|авиа|air|flight/),
    );
    const hasInsurance   = activeServices.some((s: any) =>
      (s.service_type_name || s.type || s.name || '').toLowerCase().match(/insur|страх/),
    );
    const hasTransfer    = activeServices.some((s: any) =>
      (s.service_type_name || s.type || '').toLowerCase().match(/transfer|трансф/),
    );

    let productType: 'package' | 'hotel' | 'flight' | 'transfer' | 'other';
    if (hasHotel && hasFlight)     productType = 'package';
    else if (hasHotel)             productType = 'hotel';
    else if (hasFlight)            productType = 'flight';
    else if (hasTransfer)          productType = 'transfer';
    else                           productType = 'other';

    // Suppliers (unique)
    const suppliers = new Set<string>();
    for (const h of activeHotels) {
      const name = h.supplier_name || h.service_supplier_name;
      if (name) suppliers.add(name);
    }
    for (const s of activeServices) {
      const name = s.supplier_name || s.service_supplier_name;
      if (name) suppliers.add(name);
    }

    // Agent
    const agentName = detail.agent_name || orderSummary?.company_name || '';

    return {
      orderId:     detail.order_id || orderSummary?.order_id,
      status:      orderSummary?.status || detail.status,
      tourists,
      countries,
      priceEur,
      costEur,
      profitEur,
      profitPct,
      productType,
      hasInsurance,
      agentName,
      suppliers: [...suppliers],
    };
  }

  // ── Section 1 & 2: Sales stats ────────────────────────────────────────────
  private computeSalesSection(
    orders: any[],
    detailMap: Map<number, any>,
    rates: CurrencyRates | null,
  ) {
    const confirmed = orders.filter(o => o.status === 'CNF');
    const cancelled = orders.filter(o => o.status === 'CNX');
    const pending   = orders.filter(o => !['CNF', 'CNX'].includes(o.status));

    let totalTourists = 0, revenueEur = 0, costEur = 0, profitEur = 0;
    const destinations: Record<string, number>  = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0, insurance: 0 };
    const agents:    Record<string, { orders: number; revenue: number }> = {};
    const suppliers: Record<string, { orders: number; revenue: number }> = {};
    const orderValues: Array<{ orderId: any; priceEur: number; profitEur: number; profitPct: number }> = [];

    for (const o of confirmed) {
      const detail = detailMap.get(o.order_id);
      const m = this.extractOrder(o, detail, rates);
      if (!m) {
        // No detail available — use summary data only
        revenueEur += 0; // can't compute without detail
        continue;
      }
      totalTourists += m.tourists;
      revenueEur    += m.priceEur;
      costEur       += m.costEur;
      profitEur     += m.profitEur;

      for (const c of m.countries) destinations[c] = (destinations[c] || 0) + 1;

      products[m.productType]++;
      if (m.hasInsurance) products.insurance++;

      if (m.agentName) {
        if (!agents[m.agentName]) agents[m.agentName] = { orders: 0, revenue: 0 };
        agents[m.agentName].orders++;
        agents[m.agentName].revenue += m.priceEur;
      }
      for (const sup of m.suppliers) {
        if (!suppliers[sup]) suppliers[sup] = { orders: 0, revenue: 0 };
        suppliers[sup].orders++;
        suppliers[sup].revenue += m.priceEur;
      }
      orderValues.push({ orderId: m.orderId, priceEur: m.priceEur, profitEur: m.profitEur, profitPct: m.profitPct });
    }

    // Sort helpers
    const topList = <T extends Record<string, number>>(
      rec: Record<string, { orders: number; revenue: number }>,
      key: 'orders' | 'revenue',
      n = 5,
    ) => Object.entries(rec)
      .sort((a, b) => b[1][key] - a[1][key])
      .slice(0, n)
      .map(([name, d]) => ({ name, orders: d.orders, revenue_eur: r2(d.revenue) }));

    // Anomalies
    const anomalies: string[] = [];
    const avgPrice = orderValues.length > 0 ? revenueEur / orderValues.length : 0;
    for (const ov of orderValues) {
      if (ov.priceEur > avgPrice * 3 && ov.priceEur > 2000) {
        anomalies.push(`Заказ #${ov.orderId}: ${r2(ov.priceEur)} EUR (в ${Math.round(ov.priceEur / (avgPrice || 1))}x выше среднего)`);
      }
    }
    if (orders.length > 0 && cancelled.length / orders.length > 0.3)
      anomalies.push(`Высокий % отмен: ${Math.round(cancelled.length / orders.length * 100)}%`);

    // Most expensive / profitable
    const byPrice   = [...orderValues].sort((a, b) => b.priceEur - a.priceEur);
    const byProfit  = [...orderValues].sort((a, b) => b.profitEur - a.profitEur);
    const byProfPct = [...orderValues].filter(o => o.priceEur > 200).sort((a, b) => b.profitPct - a.profitPct);

    const profitPct = revenueEur > 0 ? Math.round(profitEur / revenueEur * 100) : 0;

    return {
      orders: {
        total:              orders.length,
        confirmed:          confirmed.length,
        cancelled:          cancelled.length,
        pending:            pending.length,
        cancellation_rate_pct: orders.length > 0 ? Math.round(cancelled.length / orders.length * 100) : 0,
      },
      tourists: totalTourists,
      financials: {
        note:          'Revenue, cost and profit are calculated for CONFIRMED (CNF) orders only. Cancelled orders are excluded.',
        revenue_eur:   r2(revenueEur),
        cost_eur:      r2(costEur),
        profit_eur:    r2(profitEur),
        profit_pct:    profitPct,
        avg_order_eur: confirmed.length > 0 ? r2(revenueEur / confirmed.length) : 0,
      },
      top_destinations: Object.entries(destinations)
        .sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([country, count]) => ({ country, orders: count })),
      product_breakdown: products,
      top_agents_by_orders:   topList(agents, 'orders', 5),
      top_agents_by_revenue:  topList(agents, 'revenue', 5),
      top_suppliers_by_orders:   topList(suppliers, 'orders', 5),
      top_suppliers_by_revenue:  topList(suppliers, 'revenue', 5),
      most_expensive_order:     byPrice[0]   ? { order_id: byPrice[0].orderId,   price_eur: r2(byPrice[0].priceEur) }     : null,
      most_profitable_abs:      byProfit[0]  ? { order_id: byProfit[0].orderId,  profit_eur: r2(byProfit[0].profitEur) }   : null,
      most_profitable_rel:      byProfPct[0] ? { order_id: byProfPct[0].orderId, profit_pct: byProfPct[0].profitPct }      : null,
      anomalies: anomalies.slice(0, 5),
      data_available: orders.length > 0,
    };
  }

  // ── Section 3: Upcoming tours ─────────────────────────────────────────────
  private computeUpcomingSection(
    orders: any[],
    detailMap: Map<number, any>,
    rates: CurrencyRates | null,
  ) {
    let tourists = 0, revenueEur = 0;
    const destinations: Record<string, number> = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0 };

    for (const o of orders) {
      const m = this.extractOrder(o, detailMap.get(o.order_id), rates);
      if (!m) continue;
      tourists    += m.tourists;
      revenueEur  += m.priceEur;
      for (const c of m.countries) destinations[c] = (destinations[c] || 0) + 1;
      if (m.productType in products) (products as any)[m.productType]++;
    }

    return {
      confirmed_orders: orders.length,
      tourists,
      revenue_eur: r2(revenueEur),
      top_destinations: Object.entries(destinations)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([country, n]) => ({ country, orders: n })),
      product_breakdown: products,
      data_available: orders.length > 0,
    };
  }

  // ── Section 4: Summer month ───────────────────────────────────────────────
  private computeSummerMonth(
    label: string,
    orders: any[],
    detailMap: Map<number, any>,
    rates: CurrencyRates | null,
  ) {
    let tourists = 0, revenueEur = 0, costEur = 0;

    for (const o of orders) {
      const m = this.extractOrder(o, detailMap.get(o.order_id), rates);
      if (!m) continue;
      tourists   += m.tourists;
      revenueEur += m.priceEur;
      costEur    += m.costEur;
    }

    const profitEur = revenueEur - costEur;

    return {
      label,
      confirmed_orders: orders.length,
      tourists,
      revenue_eur: r2(revenueEur),
      cost_eur:    r2(costEur),
      profit_eur:  r2(profitEur),
      profit_pct:  revenueEur > 0 ? Math.round(profitEur / revenueEur * 100) : 0,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private async getV3BaseUrl(): Promise<string> {
    try {
      const s = await prisma.systemSetting.findUnique({ where: { key: 'gto.v3_base_url' } });
      return (s?.value || DEFAULT_V3_BASE_URL).replace(/\/$/, '');
    } catch { return DEFAULT_V3_BASE_URL; }
  }
}
