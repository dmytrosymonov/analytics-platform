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
    const today       = new Date(period.end);
    const yesterday   = new Date(period.start);
    const last7dFrom  = new Date(today.getTime() - 7 * 86400000);
    const prev14dFrom = new Date(today.getTime() - 14 * 86400000);
    const next7dTo    = new Date(today.getTime() + 7  * 86400000);
    const next30dTo   = new Date(today.getTime() + 30 * 86400000);

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
      ordersPrev7d,
      ordersUpcoming,
      ordersPrevUpcoming,
      ordersUpcoming30d,
      ordersJune,
      ordersJuly,
      ordersAugust,
    ] = await Promise.all([
      // Section 1 — yesterday (by created_at)
      fetchList('/orders_list', { date_from: fmt(yesterday), date_to: fmt(today), sort_by: 'created_at' }),
      // Section 2 — last 7 days (by created_at)
      fetchList('/orders_list', { date_from: fmt(last7dFrom), date_to: fmt(today), sort_by: 'created_at' }),
      // Section 2 comparison — previous 7 days (days 8-14 ago, by created_at)
      fetchList('/orders_list', { date_from: fmt(prev14dFrom), date_to: fmt(last7dFrom), sort_by: 'created_at' }),
      // Section 3a — upcoming tours (start date = next 7 days, confirmed only)
      fetchList('/orders_list', { date_from: fmt(today), date_to: fmt(next7dTo), sort_by: 'date_start', status: 'CNF' }),
      // Section 3a comparison — tours started in past 7 days (confirmed only)
      fetchList('/orders_list', { date_from: fmt(last7dFrom), date_to: fmt(today), sort_by: 'date_start', status: 'CNF' }),
      // Section 3b — upcoming 30 days (confirmed only)
      fetchList('/orders_list', { date_from: fmt(today), date_to: fmt(next30dTo), sort_by: 'date_start', status: 'CNF' }),
      // Section 4 — summer months by date_start (confirmed only)
      fetchList('/orders_list', { date_from: `${year}-06-01`, date_to: `${year}-06-30`, sort_by: 'date_start', status: 'CNF' }),
      fetchList('/orders_list', { date_from: `${year}-07-01`, date_to: `${year}-07-31`, sort_by: 'date_start', status: 'CNF' }),
      fetchList('/orders_list', { date_from: `${year}-08-01`, date_to: `${year}-08-31`, sort_by: 'date_start', status: 'CNF' }),
    ]);

    // ── Collect unique order IDs to fetch details for ──────────────────────
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
    addIds(ordersPrevUpcoming, 200);
    addIds(ordersUpcoming30d, MAX_DETAIL_ORDERS);
    addIds(ordersPrev7d, MAX_DETAIL_ORDERS);
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
    const s1     = this.computeSalesSection(ordersYesterday, detailMap, rates);
    const s2     = this.computeSalesSection(ordersLast7d, detailMap, rates);
    const s2prev = this.computeSalesSection(ordersPrev7d, detailMap, rates);
    const s3     = this.computeUpcomingSection(ordersUpcoming, detailMap, rates);
    const s3prev = this.computeUpcomingSection(ordersPrevUpcoming, detailMap, rates);
    const s3b    = this.computeUpcomingSection(ordersUpcoming30d, detailMap, rates);
    const s4june   = this.computeSummerMonth('Июнь',   ordersJune,   detailMap, rates);
    const s4july   = this.computeSummerMonth('Июль',   ordersJuly,   detailMap, rates);
    const s4august = this.computeSummerMonth('Август', ordersAugust, detailMap, rates);

    // Combined summer destinations (tourists across all 3 months)
    const summerTouristsByCountry: Record<string, number> = {};
    let summerTotalTourists = 0;
    for (const month of [s4june, s4july, s4august]) {
      summerTotalTourists += month.tourists;
      for (const d of month.top_destinations) {
        summerTouristsByCountry[d.country] = (summerTouristsByCountry[d.country] || 0) + d.tourists;
      }
    }
    const summerTopDestinations = Object.entries(summerTouristsByCountry)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([country, tourists]) => ({
        country,
        tourists,
        pct: summerTotalTourists > 0 ? Math.round(tourists / summerTotalTourists * 100) : 0,
      }));

    const s4 = {
      year,
      june:   s4june,
      july:   s4july,
      august: s4august,
      top_destinations_combined: summerTopDestinations,
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
            section1_yesterday: {
              period: { from: fmt(yesterday), to: fmt(today) },
              ...s1,
            },
            section2_last_7_days: {
              period: { from: fmt(last7dFrom), to: fmt(today) },
              ...s2,
              vs_prev_7_days: {
                period: { from: fmt(prev14dFrom), to: fmt(last7dFrom) },
                prev_orders_confirmed: s2prev.orders.confirmed,
                prev_revenue_eur:      s2prev.financials.revenue_eur,
                prev_profit_eur:       s2prev.financials.profit_eur,
                prev_tourists:         s2prev.tourists,
                orders_confirmed_delta: s2.orders.confirmed - s2prev.orders.confirmed,
                revenue_eur_delta:     r2(s2.financials.revenue_eur - s2prev.financials.revenue_eur),
                revenue_eur_delta_pct: s2prev.financials.revenue_eur > 0
                  ? Math.round((s2.financials.revenue_eur - s2prev.financials.revenue_eur) / s2prev.financials.revenue_eur * 100)
                  : null,
                profit_eur_delta:      r2(s2.financials.profit_eur - s2prev.financials.profit_eur),
                profit_eur_delta_pct:  s2prev.financials.profit_eur > 0
                  ? Math.round((s2.financials.profit_eur - s2prev.financials.profit_eur) / s2prev.financials.profit_eur * 100)
                  : null,
                tourists_delta:        s2.tourists - s2prev.tourists,
              },
            },
            section3_upcoming_7days: {
              period: { from: fmt(today), to: fmt(next7dTo) },
              ...s3,
            },
            section3_upcoming_30days: {
              period: { from: fmt(today), to: fmt(next30dTo) },
              ...s3b,
            },
            section4_summer: s4,
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

    // Fallback order currency (used when service currency label is unreliable)
    const orderCurrency = detail.currency || orderSummary?.currency || 'UAH';

    // ── Supplier name lookup (for currency detection) ─────────────────────
    // Some suppliers encode their billing currency in the name: "DRCT [UAH]", "Hotelbeds [EUR]"
    // This is the authoritative source for price_buy currency on airtickets.
    const supplierNameMap = new Map<string, string>();
    for (const s of (Array.isArray(detail.supplier) ? detail.supplier : [])) {
      if (s.id) supplierNameMap.set(String(s.id), s.name || '');
    }
    const supplierTagCurrency = (supplierId: any): string | null => {
      const name = supplierNameMap.get(String(supplierId)) || '';
      const m = name.match(/\[(UAH|EUR|KZT|USD|PLN)\]/i);
      return m ? m[1].toUpperCase() : null;
    };

    // ── Revenue ──────────────────────────────────────────────────────────
    // balance_amount / balance_currency — GTO already converts to agent's preferred
    // currency (usually EUR), more reliable than converting total_amount ourselves.
    const balanceCurrency = detail.balance_currency || orderCurrency;
    const balanceAmount   = parseFloat(detail.balance_amount) || 0;
    const priceEur = balanceAmount > 0
      ? toEur(balanceAmount, balanceCurrency)
      : toEur(parseFloat(detail.total_amount) || 0, orderCurrency);

    // ── Cost ─────────────────────────────────────────────────────────────
    let costEur = 0;
    const hotels   = Array.isArray(detail.hotel)   ? detail.hotel   : [];
    const services = Array.isArray(detail.service) ? detail.service : [];

    // Hotels: price_buy in hotel.currency.
    // Sanity: if price_buy > price_sell → currency label wrong → use UAH.
    for (const h of hotels) {
      const priceBuy  = parseFloat(h.price_buy) || 0;
      const priceSell = parseFloat(h.price)     || 0;
      if (priceBuy <= 0) continue;
      const hCurrency     = h.currency || orderCurrency;
      const costConverted = toEur(priceBuy,  hCurrency);
      const sellConverted = toEur(priceSell, hCurrency);
      costEur += (sellConverted > 0 && costConverted > sellConverted)
        ? toEur(priceBuy, 'UAH')
        : costConverted;
    }

    // Services:
    // • transfer  — price_buy ALWAYS in EUR; no sanity check (value is trusted)
    // • airticket — price_buy currency determined by supplier name tag [UAH/EUR/KZT/…];
    //               falls back to service.currency if no tag found
    // • insurance / other — price_buy in service.currency;
    //               if price_buy > price_sell → price_buy is actually in UAH
    for (const s of services) {
      const priceBuy  = parseFloat(s.price_buy) || 0;
      const priceSell = parseFloat(s.price)     || 0;
      if (priceBuy <= 0) continue;

      let serviceCostEur: number;

      if (s.type === 'transfer') {
        // Transfer: price_buy is always stored in EUR regardless of service.currency.
        // Do NOT apply sanity check — the value is correct even if cost > sell in local currency.
        serviceCostEur = toEur(priceBuy, 'EUR');

      } else if (s.type === 'airticket') {
        // Airticket: trust supplier name tag for the buy currency.
        // e.g. "DRCT [UAH]" means price_buy is in UAH even if order currency is KZT.
        const buyCurr = supplierTagCurrency(s.supplier_id) || s.currency || orderCurrency;
        serviceCostEur = toEur(priceBuy, buyCurr);

      } else {
        // Insurance and other services: price_buy in service.currency.
        // Exception: if price_buy > price_sell → price_buy is in UAH (GTO quirk).
        const sCurrency     = s.currency || orderCurrency;
        const costConverted = toEur(priceBuy,  sCurrency);
        const sellConverted = toEur(priceSell, sCurrency);
        serviceCostEur = (sellConverted > 0 && costConverted > sellConverted)
          ? toEur(priceBuy, 'UAH')   // price_buy is always UAH when label is wrong
          : costConverted;
      }

      costEur += serviceCostEur;
    }

    const profitEur = priceEur - costEur;
    const profitPct = priceEur > 0 ? Math.round(profitEur / priceEur * 100) : 0;

    // Product classification
    const activeHotels   = hotels.filter((h: any) => h.status !== 'CNX');
    const hasHotel       = activeHotels.length > 0;
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

    // Suppliers (unique, clean currency tags from names: "Hotelbeds [EUR]" → "Hotelbeds")
    const cleanSupName = (n: string) => (n || '').replace(/\s*\[.*?\]/g, '').trim();
    const suppliers = new Set<string>();
    for (const h of activeHotels) {
      const name = cleanSupName(h.supplier_name || h.service_supplier_name || '');
      if (name) suppliers.add(name);
    }
    for (const s of activeServices) {
      const name = cleanSupName(s.supplier_name || s.service_supplier_name || '');
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

  // ── Shared top-list helper ────────────────────────────────────────────────
  private topList(
    rec: Record<string, { orders: number; revenue: number }>,
    key: 'orders' | 'revenue',
    n = 5,
  ) {
    return Object.entries(rec)
      .sort((a, b) => b[1][key] - a[1][key])
      .slice(0, n)
      .map(([name, d]) => ({ name, orders: d.orders, revenue_eur: r2(d.revenue) }));
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
    const touristsPerCountry: Record<string, number> = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0, insurance: 0 };
    const agents:    Record<string, { orders: number; revenue: number }> = {};
    const suppliers: Record<string, { orders: number; revenue: number }> = {};
    const orderValues: Array<{ orderId: any; priceEur: number; profitEur: number; profitPct: number }> = [];

    for (const o of confirmed) {
      const detail = detailMap.get(o.order_id);
      const m = this.extractOrder(o, detail, rates);
      if (!m) continue;

      totalTourists += m.tourists;
      revenueEur    += m.priceEur;
      costEur       += m.costEur;
      profitEur     += m.profitEur;

      for (const c of m.countries) {
        destinations[c] = (destinations[c] || 0) + 1;
        touristsPerCountry[c] = (touristsPerCountry[c] || 0) + m.tourists;
      }

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
        total:                 orders.length,
        confirmed:             confirmed.length,
        cancelled:             cancelled.length,
        pending:               pending.length,
        cancellation_rate_pct: orders.length > 0 ? Math.round(cancelled.length / orders.length * 100) : 0,
      },
      tourists: totalTourists,
      financials: {
        note:          'Revenue, cost and profit calculated for CONFIRMED (CNF) orders only',
        revenue_eur:   r2(revenueEur),
        cost_eur:      r2(costEur),
        profit_eur:    r2(profitEur),
        profit_pct:    profitPct,
        avg_order_eur: confirmed.length > 0 ? r2(revenueEur / confirmed.length) : 0,
      },
      top_destinations: Object.entries(destinations)
        .sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([country, orders]) => ({
          country,
          orders,
          tourists: touristsPerCountry[country] || 0,
          pct: totalTourists > 0 ? Math.round((touristsPerCountry[country] || 0) / totalTourists * 100) : 0,
        })),
      product_breakdown: products,
      top_agents_by_orders:      this.topList(agents, 'orders', 5),
      top_agents_by_revenue:     this.topList(agents, 'revenue', 5),
      top_suppliers_by_orders:   this.topList(suppliers, 'orders', 5),
      top_suppliers_by_revenue:  this.topList(suppliers, 'revenue', 5),
      most_expensive_order:  byPrice[0]   ? { order_id: byPrice[0].orderId,   price_eur:  r2(byPrice[0].priceEur) }    : null,
      most_profitable_abs:   byProfit[0]  ? { order_id: byProfit[0].orderId,  profit_eur: r2(byProfit[0].profitEur) }  : null,
      most_profitable_rel:   byProfPct[0] ? { order_id: byProfPct[0].orderId, profit_pct: byProfPct[0].profitPct }     : null,
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
    let tourists = 0, revenueEur = 0, costEur = 0, profitEur = 0;
    const destinations: Record<string, number> = {};
    const touristsPerCountry: Record<string, number> = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0, insurance: 0 };
    const agents: Record<string, { orders: number; revenue: number }> = {};

    for (const o of orders) {
      const m = this.extractOrder(o, detailMap.get(o.order_id), rates);
      if (!m) continue;
      tourists   += m.tourists;
      revenueEur += m.priceEur;
      costEur    += m.costEur;
      profitEur  += m.profitEur;
      for (const c of m.countries) {
        destinations[c] = (destinations[c] || 0) + 1;
        touristsPerCountry[c] = (touristsPerCountry[c] || 0) + m.tourists;
      }
      if (m.productType in products) (products as any)[m.productType]++;
      if (m.hasInsurance) products.insurance++;
      if (m.agentName) {
        if (!agents[m.agentName]) agents[m.agentName] = { orders: 0, revenue: 0 };
        agents[m.agentName].orders++;
        agents[m.agentName].revenue += m.priceEur;
      }
    }

    return {
      confirmed_orders: orders.length,
      tourists,
      revenue_eur:  r2(revenueEur),
      cost_eur:     r2(costEur),
      profit_eur:   r2(profitEur),
      profit_pct:   revenueEur > 0 ? Math.round(profitEur / revenueEur * 100) : 0,
      top_destinations: Object.entries(destinations)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([country, orders]) => ({
          country,
          orders,
          tourists: touristsPerCountry[country] || 0,
          pct: tourists > 0 ? Math.round((touristsPerCountry[country] || 0) / tourists * 100) : 0,
        })),
      product_breakdown: products,
      top_agents: this.topList(agents, 'orders', 5),
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
    let tourists = 0, revenueEur = 0, costEur = 0, profitEur = 0;
    const destinations: Record<string, number> = {};
    const touristsPerCountry: Record<string, number> = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0, insurance: 0 };
    const agents: Record<string, { orders: number; revenue: number }> = {};

    for (const o of orders) {
      const m = this.extractOrder(o, detailMap.get(o.order_id), rates);
      if (!m) continue;
      tourists   += m.tourists;
      revenueEur += m.priceEur;
      costEur    += m.costEur;
      profitEur  += m.profitEur;
      for (const c of m.countries) {
        destinations[c] = (destinations[c] || 0) + 1;
        touristsPerCountry[c] = (touristsPerCountry[c] || 0) + m.tourists;
      }
      if (m.productType in products) (products as any)[m.productType]++;
      if (m.hasInsurance) products.insurance++;
      if (m.agentName) {
        if (!agents[m.agentName]) agents[m.agentName] = { orders: 0, revenue: 0 };
        agents[m.agentName].orders++;
        agents[m.agentName].revenue += m.priceEur;
      }
    }

    const profitEurFinal = revenueEur - costEur;

    return {
      label,
      confirmed_orders: orders.length,
      tourists,
      revenue_eur:  r2(revenueEur),
      cost_eur:     r2(costEur),
      profit_eur:   r2(profitEurFinal),
      profit_pct:   revenueEur > 0 ? Math.round(profitEurFinal / revenueEur * 100) : 0,
      top_destinations: Object.entries(destinations)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([country, orders]) => ({
          country,
          orders,
          tourists: touristsPerCountry[country] || 0,
          pct: tourists > 0 ? Math.round((touristsPerCountry[country] || 0) / tourists * 100) : 0,
        })),
      product_breakdown: products,
      top_agents: this.topList(agents, 'orders', 5),
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
