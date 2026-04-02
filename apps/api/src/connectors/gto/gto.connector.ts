import axios from 'axios';
import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { logger } from '../../lib/logger';
import { createHttpClient } from '../../lib/http';
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

const r2  = (n: number) => Math.round(n * 100) / 100;

const COUNTRY_EMOJI: Record<string, string> = {
  'Spain': '🇪🇸', 'Испания': '🇪🇸', 'Іспанія': '🇪🇸',
  'Turkey': '🇹🇷', 'Турция': '🇹🇷', 'Туреччина': '🇹🇷',
  'Egypt': '🇪🇬', 'Египет': '🇪🇬', 'Єгипет': '🇪🇬',
  'Greece': '🇬🇷', 'Греция': '🇬🇷', 'Греція': '🇬🇷',
  'Italy': '🇮🇹', 'Италия': '🇮🇹', 'Італія': '🇮🇹',
  'UAE': '🇦🇪', 'ОАЭ': '🇦🇪', 'ОАЕ': '🇦🇪', 'United Arab Emirates': '🇦🇪',
  'Thailand': '🇹🇭', 'Таиланд': '🇹🇭', 'Таїланд': '🇹🇭',
  'Cyprus': '🇨🇾', 'Кипр': '🇨🇾', 'Кіпр': '🇨🇾',
  'Montenegro': '🇲🇪', 'Черногория': '🇲🇪', 'Чорногорія': '🇲🇪',
  'Croatia': '🇭🇷', 'Хорватия': '🇭🇷', 'Хорватія': '🇭🇷',
  'France': '🇫🇷', 'Франция': '🇫🇷', 'Франція': '🇫🇷',
  'Germany': '🇩🇪', 'Германия': '🇩🇪', 'Німеччина': '🇩🇪',
  'Czech Republic': '🇨🇿', 'Чехия': '🇨🇿', 'Чехія': '🇨🇿', 'Czechia': '🇨🇿',
  'Austria': '🇦🇹', 'Австрия': '🇦🇹', 'Австрія': '🇦🇹',
  'Bulgaria': '🇧🇬', 'Болгария': '🇧🇬', 'Болгарія': '🇧🇬',
  'Portugal': '🇵🇹', 'Португалия': '🇵🇹', 'Португалія': '🇵🇹',
  'Georgia': '🇬🇪', 'Грузия': '🇬🇪', 'Грузія': '🇬🇪',
  'Armenia': '🇦🇲', 'Армения': '🇦🇲', 'Вірменія': '🇦🇲',
  'Israel': '🇮🇱', 'Израиль': '🇮🇱', 'Ізраїль': '🇮🇱',
  'Morocco': '🇲🇦', 'Марокко': '🇲🇦',
  'Maldives': '🇲🇻', 'Мальдивы': '🇲🇻', 'Мальдіви': '🇲🇻',
  'Sri Lanka': '🇱🇰', 'Шри-Ланка': '🇱🇰',
  'Vietnam': '🇻🇳', 'Вьетнам': '🇻🇳', 'В\'єтнам': '🇻🇳',
  'India': '🇮🇳', 'Индия': '🇮🇳', 'Індія': '🇮🇳',
  'Indonesia': '🇮🇩', 'Индонезия': '🇮🇩', 'Індонезія': '🇮🇩',
  'Kazakhstan': '🇰🇿', 'Казахстан': '🇰🇿',
  'Poland': '🇵🇱', 'Польша': '🇵🇱', 'Польща': '🇵🇱',
  'Hungary': '🇭🇺', 'Венгрия': '🇭🇺', 'Угорщина': '🇭🇺',
  'Netherlands': '🇳🇱', 'Нидерланды': '🇳🇱', 'Нідерланди': '🇳🇱',
  'Belgium': '🇧🇪', 'Бельгия': '🇧🇪', 'Бельгія': '🇧🇪',
  'Switzerland': '🇨🇭', 'Швейцария': '🇨🇭', 'Швейцарія': '🇨🇭',
  'Sweden': '🇸🇪', 'Швеция': '🇸🇪', 'Швеція': '🇸🇪',
  'Norway': '🇳🇴', 'Норвегия': '🇳🇴', 'Норвегія': '🇳🇴',
  'Albania': '🇦🇱', 'Албания': '🇦🇱', 'Албанія': '🇦🇱',
  'Malta': '🇲🇹', 'Мальта': '🇲🇹',
  'Tunisia': '🇹🇳', 'Тунис': '🇹🇳', 'Туніс': '🇹🇳',
  'Jordan': '🇯🇴', 'Иордания': '🇯🇴', 'Йорданія': '🇯🇴',
  'Mexico': '🇲🇽', 'Мексика': '🇲🇽',
  'Japan': '🇯🇵', 'Япония': '🇯🇵', 'Японія': '🇯🇵',
  'China': '🇨🇳', 'Китай': '🇨🇳',
  'USA': '🇺🇸', 'США': '🇺🇸',
};
const countryEmoji = (name: string) => COUNTRY_EMOJI[name] ?? '';
const RU_MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function shiftDateString(dateStr: string, offsetDays: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Connector ────────────────────────────────────────────────────────────────
export class GTOConnector implements SourceConnector {
  readonly sourceType = 'gto';
  private readonly ignoredAgentNames = new Set(['GTO for Test-Goodwin']);

  private normalizeAgentName(name: string) {
    return (name || '').replace(/\s*\[.*?\]/g, '').trim();
  }

  private isIgnoredAgent(name: string) {
    return this.ignoredAgentNames.has(name);
  }

  private monthBucketLabel(dateStr?: string | null) {
    if (!dateStr) return null;
    const match = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!year || !month || month < 1 || month > 12) return null;
    return `${RU_MONTHS[month - 1]} ${year}`;
  }

  private salesLeadDays(createdAt?: string | null, startDate?: string | null) {
    if (!createdAt || !startDate) return null;
    const createdMatch = String(createdAt).match(/(\d{4})-(\d{2})-(\d{2})/);
    const startMatch = String(startDate).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!createdMatch || !startMatch) return null;
    const createdUtc = Date.UTC(Number(createdMatch[1]), Number(createdMatch[2]) - 1, Number(createdMatch[3]));
    const startUtc = Date.UTC(Number(startMatch[1]), Number(startMatch[2]) - 1, Number(startMatch[3]));
    return Math.round((startUtc - createdUtc) / 86400000);
  }

  private httpClient(baseUrl: string, apiKey: string, timeout: number) {
    return createHttpClient({ baseURL: baseUrl, params: { apikey: apiKey }, timeout }, 'gto');
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { api_key, base_url } = credentials as any;
    if (!api_key) return false;
    const url = (base_url || DEFAULT_BASE_URL).replace(/\/$/, '');
    try {
      const client = createHttpClient({ baseURL: url, params: { apikey: api_key }, timeout: 10000 }, 'gto');
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
    const v3BaseUrl    = await this.getV3BaseUrl();

    // Currency rates (cached daily in Redis)
    let rates: CurrencyRates | null = null;
    try { rates = await CurrencyService.getRates(api_key, v3BaseUrl); }
    catch (e: any) { logger.warn({ err: e.message }, 'Currency rates unavailable'); }

    const http     = this.httpClient(baseUrl, api_key, timeout);
    const sem      = new Semaphore(PARALLEL_REQUESTS);
    const warnings: string[] = [];
    if (!rates) warnings.push('Currency rates unavailable — amounts in original currencies');

    // ── Date ranges (timezone-aware) ──────────────────────────────────────
    // Anchor all relative windows to the requested report period, not server "now".
    // This keeps manual /generate runs and scheduled runs consistent.
    const tz = settings['timezone'] || 'Europe/Kiev';
    const formatTzDate = (date: Date): string => date.toLocaleDateString('sv-SE', { timeZone: tz });

    // GTO /orders_list treats date_to as inclusive.
    // Anchor all report windows to the last day included in the requested run.
    const reportDayStr   = shiftDateString(formatTzDate(period.end), -1);
    const dailyFromStr   = reportDayStr;
    const dailyToStr     = reportDayStr;
    const last7dStr      = shiftDateString(reportDayStr, -7);
    const prevWindowFrom = shiftDateString(reportDayStr, -15);
    const prevWindowTo   = shiftDateString(reportDayStr, -8);
    const next7dStr      = shiftDateString(reportDayStr, 7);
    const next30dStr     = shiftDateString(reportDayStr, 30);
    const prevUpcomingFrom = shiftDateString(reportDayStr, -8);
    const prevUpcomingTo   = shiftDateString(reportDayStr, -1);

    // Summer months (next upcoming June/July/August relative to today in TZ)
    const todayYear  = parseInt(reportDayStr.slice(0, 4), 10);
    const todayMonth = parseInt(reportDayStr.slice(5, 7), 10);
    const year = todayMonth >= 10 ? todayYear + 1 : todayYear;

    // ── Helpers ────────────────────────────────────────────────────────────
    const fetchList = async (
      path: string,
      params: Record<string, unknown>,
    ): Promise<any[]> => {
      const PER_PAGE = 1000;
      const MAX_PAGES = 20; // safety: never fetch more than 20 000 orders per query
      const allItems: any[] = [];
      let page = 1;
      for (;;) {
        let pageData: any[] = [];
        let rawTotal: number | null = null; // total count from API if provided
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          try {
            const resp = await http.get(path, { params: { ...params, per_page: PER_PAGE, page } });
            const data = resp.data;
            if (Array.isArray(data)) { pageData = data; break; }
            if (data?.data && Array.isArray(data.data)) {
              pageData = data.data;
              // GTO may return total count in meta fields — capture it for logging
              rawTotal = data.total ?? data.meta?.total ?? data.count ?? null;
              break;
            }
            logger.warn({ path, page, dataKeys: data ? Object.keys(data) : null }, 'fetchList: unexpected response format');
            break;
          } catch (err: any) {
            if (attempt === retryCount) { logger.warn({ path, err: err.message }, 'fetchList failed'); break; }
            await sleep(retryBackoff * Math.pow(2, attempt) * 1000);
          }
        }
        allItems.push(...pageData);
        logger.debug({
          path,
          page,
          pageItems:  pageData.length,
          totalSoFar: allItems.length,
          apiTotal:   rawTotal,
          full:       pageData.length === PER_PAGE,
        }, 'GTO fetchList page');
        if (pageData.length < PER_PAGE) break; // last page reached
        if (page >= MAX_PAGES) {
          logger.warn({ path, pages: page, total: allItems.length }, 'GTO fetchList: MAX_PAGES limit reached, truncating');
          break;
        }
        page++;
      }
      if (page > 1) {
        logger.info({ path, pages: page, total: allItems.length }, 'GTO fetchList: multi-page fetch complete');
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
      // Section 1 — yesterday (by created_at, in business timezone)
      fetchList('/orders_list', { date_from: dailyFromStr, date_to: dailyToStr, sort_by: 'created_at' }),
      // Section 2 — last 7 days (by created_at)
      fetchList('/orders_list', { date_from: last7dStr, date_to: reportDayStr, sort_by: 'created_at' }),
      // Section 2 comparison — previous 7 days (days 8-14 ago, by created_at)
      fetchList('/orders_list', { date_from: prevWindowFrom, date_to: prevWindowTo, sort_by: 'created_at' }),
      // Section 3a — upcoming tours (start date = next 7 days, confirmed only)
      fetchList('/orders_list', { date_from: reportDayStr, date_to: next7dStr, sort_by: 'date_start', status: 'CNF' }),
      // Section 3a comparison — tours started in past 7 days (confirmed only)
      fetchList('/orders_list', { date_from: prevUpcomingFrom, date_to: prevUpcomingTo, sort_by: 'date_start', status: 'CNF' }),
      // Section 3b — upcoming 30 days (confirmed only)
      fetchList('/orders_list', { date_from: reportDayStr, date_to: next30dStr, sort_by: 'date_start', status: 'CNF' }),
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
    // Yesterday: fetch ALL details without limit — accuracy of section 1 is critical.
    // Other sections: cap to avoid overloading the API.
    addIds(ordersYesterday, Infinity);
    addIds(ordersUpcoming, MAX_DETAIL_ORDERS);
    addIds(ordersPrevUpcoming, MAX_DETAIL_ORDERS);
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
        flag: countryEmoji(country),
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
              period: { from: dailyFromStr, to: dailyToStr },
              ...s1,
            },
            section2_last_7_days: {
              period: { from: last7dStr, to: reportDayStr },
              ...s2,
              vs_prev_7_days: {
                period: { from: prevWindowFrom, to: prevWindowTo },
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
              period: { from: reportDayStr, to: next7dStr },
              ...s3,
            },
            section3_upcoming_30days: {
              period: { from: reportDayStr, to: next30dStr },
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
    const cleanSupName = (n: string) => (n || '').replace(/\s*\[.*?\]/g, '').trim();

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
    const hotels = Array.isArray(detail.hotel) ? detail.hotel : [];
    const services = Array.isArray(detail.service) ? detail.service : [];
    const confirmedHotels = hotels.filter((h: any) => h.status === 'CNF');
    const confirmedServices = services.filter((s: any) => s.status === 'CNF');
    const pendingServices = services.filter((s: any) => s.status && s.status !== 'CNF' && s.status !== 'CNX');
    const eurTransferSuppliers = new Set(['suntransfers']);

    // Hotels: price_buy in hotel.currency.
    // Sanity: if price_buy > price_sell → currency label wrong → use UAH.
    // supplierCosts: tracks cost per supplier name for accurate reporting
    const supplierCosts: Record<string, number> = {};

    for (const h of confirmedHotels) {
      const priceBuy  = parseFloat(h.price_buy) || 0;
      const priceSell = parseFloat(h.price)     || 0;
      if (priceBuy <= 0) continue;
      const hCurrency     = h.currency || orderCurrency;
      const costConverted = toEur(priceBuy,  hCurrency);
      const sellConverted = toEur(priceSell, hCurrency);
      const costUah       = toEur(priceBuy, 'UAH');
      // Sanity check 1: if cost > sell → currency mislabeled → try UAH
      // Sanity check 2: if a SINGLE hotel item exceeds total order revenue → currency mislabeled
      //   (both values wrong but same ratio, so check 1 alone doesn't catch it)
      const hCost = (sellConverted > 0 && costConverted > sellConverted) ||
                    (priceEur > 0 && costConverted > priceEur)
        ? costUah
        : costConverted;
      costEur += hCost;
      const supName = cleanSupName(h.supplier_name || h.service_supplier_name || '');
      if (supName) supplierCosts[supName] = (supplierCosts[supName] || 0) + hCost;
    }

    // Services:
    // • transfer  — supplier-specific currency rules:
    //               some suppliers (for example SunTransfers) store buy price in EUR even if
    //               service.currency is UAH; others (for example ITRAVEX) use real UAH values
    // • airticket — price_buy currency determined by supplier name tag [UAH/EUR/KZT/…];
    //               if cost > sell * 2 → mislabeled, fallback to UAH
    // • insurance / other — price_buy in service.currency;
    //               if price_buy > price_sell → price_buy is actually in UAH
    for (const s of confirmedServices) {
      const priceBuy  = parseFloat(s.price_buy) || 0;
      const priceSell = parseFloat(s.price)     || 0;
      if (priceBuy <= 0) continue;

      let serviceCostEur: number;

      if (s.type === 'transfer') {
        const transferSupplier = cleanSupName(s.supplier_name || s.service_supplier_name || '').toLowerCase();
        const transferCurrency = eurTransferSuppliers.has(transferSupplier)
          ? 'EUR'
          : (s.currency || orderCurrency);
        const transferCostConverted = toEur(priceBuy, transferCurrency);
        const transferSellConverted = toEur(priceSell, transferCurrency);
        const transferCostUah = toEur(priceBuy, 'UAH');
        // If transfer cost explodes relative to its sell price or the whole order,
        // prefer UAH as the safer fallback for mislabeled rows.
        serviceCostEur = transferCurrency !== 'UAH' && (
          (transferSellConverted > 0 && transferCostConverted > transferSellConverted * 2) ||
          (priceEur > 0 && transferCostConverted > priceEur)
        )
          ? transferCostUah
          : transferCostConverted;

      } else if (s.type === 'airticket') {
        const buyCurr = supplierTagCurrency(s.supplier_id) || s.currency || orderCurrency;
        const airkCostConverted = toEur(priceBuy, buyCurr);
        const airkSellConverted = toEur(priceSell, buyCurr);
        const airkCostUah       = toEur(priceBuy, 'UAH');
        // Sanity 1: cost > 2x sell (existing). Sanity 2: single ticket > total order revenue
        serviceCostEur = (airkSellConverted > 0 && airkCostConverted > airkSellConverted * 2) ||
                         (priceEur > 0 && airkCostConverted > priceEur)
          ? airkCostUah
          : airkCostConverted;

      } else {
        const sCurrency     = s.currency || orderCurrency;
        const costConverted = toEur(priceBuy,  sCurrency);
        const sellConverted = toEur(priceSell, sCurrency);
        const costUah       = toEur(priceBuy, 'UAH');
        // Sanity 1: cost > sell. Sanity 2: single service > total order revenue
        serviceCostEur = (sellConverted > 0 && costConverted > sellConverted) ||
                         (priceEur > 0 && costConverted > priceEur)
          ? costUah
          : costConverted;
      }

      costEur += serviceCostEur;
      const supName = cleanSupName(s.supplier_name || s.service_supplier_name || '');
      if (supName) supplierCosts[supName] = (supplierCosts[supName] || 0) + serviceCostEur;
    }

    const profitEur = priceEur - costEur;
    const profitPct = priceEur > 0 ? Math.round(profitEur / priceEur * 100) : 0;

    // Diagnostics: log breakdown when cost exceeds revenue (helps find currency bugs)
    if (costEur > priceEur && priceEur > 0) {
      logger.warn({
        orderId: orderSummary?.order_id,
        priceEur: r2(priceEur),
        costEur:  r2(costEur),
        profitPct,
        balanceAmount:   detail.balance_amount,
        balanceCurrency: detail.balance_currency,
        pendingServices: pendingServices.map((s: any) => ({
          type: s.type,
          supplier: cleanSupName(s.supplier_name || ''),
          status: s.status,
          currency: s.currency || orderCurrency,
          price_buy: s.price_buy,
          price_sell: s.price,
        })),
        hotels: confirmedHotels.map((h: any) => ({
          supplier: cleanSupName(h.supplier_name || ''),
          status: h.status,
          currency: h.currency || orderCurrency,
          price_buy:  h.price_buy,
          price_sell: h.price,
          costEur: r2(toEur(parseFloat(h.price_buy) || 0, h.currency || orderCurrency)),
          costUah: r2(toEur(parseFloat(h.price_buy) || 0, 'UAH')),
        })),
        services: confirmedServices.map((s: any) => ({
          type:     s.type,
          supplier: cleanSupName(s.supplier_name || ''),
          status: s.status,
          currency: s.currency || orderCurrency,
          price_buy:  s.price_buy,
          price_sell: s.price,
          costEur: r2(toEur(parseFloat(s.price_buy) || 0, s.currency || orderCurrency)),
          costUah: r2(toEur(parseFloat(s.price_buy) || 0, 'UAH')),
        })),
      }, 'GTO cost > revenue: possible currency mislabel');
    }

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

    // Agent (strip bracketed suffixes like "[Поїхали з нами]", "[Клуб Датур]")
    const rawAgent = detail.agent_name || orderSummary?.company_name || '';
    const agentName = this.normalizeAgentName(rawAgent);
    const startDate = detail.date_start || orderSummary?.date_start || null;
    const createdAt = detail.created_at || orderSummary?.created_at || null;
    const leadDays = this.salesLeadDays(createdAt, startDate);

    return {
      orderId:        detail.order_id || orderSummary?.order_id,
      status:         orderSummary?.status || detail.status,
      tourists,
      countries,
      priceEur,
      costEur,
      profitEur,
      profitPct,
      productType,
      hasInsurance,
      agentName,
      startDate,
      createdAt,
      leadDays,
      supplierCosts,  // map: supplier_name → their specific service cost in this order
    };
  }

  // ── Shared top-list helpers ────────────────────────────────────────────────
  private topList(
    rec: Record<string, { orders: number; revenue: number; tourists?: number }>,
    key: 'orders' | 'revenue',
    n = 5,
  ) {
    return Object.entries(rec)
      .sort((a, b) => b[1][key] - a[1][key])
      .slice(0, n)
      .map(([name, d]) => ({ name, orders: d.orders, tourists: d.tourists ?? 0, revenue_eur: r2(d.revenue) }));
  }

  private topSupplierList(
    rec: Record<string, { orders: number; cost: number }>,
    n = 5,
  ) {
    return Object.entries(rec)
      .sort((a, b) => b[1].orders - a[1].orders)
      .slice(0, n)
      .map(([name, d]) => ({ name, orders: d.orders, cost_eur: r2(d.cost) }));
  }

  // ── Section 1 & 2: Sales stats ────────────────────────────────────────────
  private computeSalesSection(
    orders: any[],
    detailMap: Map<number, any>,
    rates: CurrencyRates | null,
  ) {
    const filteredOrders = orders.filter(o => {
      const detail = detailMap.get(o.order_id);
      const agentName = this.normalizeAgentName(detail?.agent_name || o.company_name || '');
      return !this.isIgnoredAgent(agentName);
    });
    const confirmed = filteredOrders.filter(o => o.status === 'CNF');
    const cancelled = filteredOrders.filter(o => o.status === 'CNX');
    const pending   = filteredOrders.filter(o => !['CNF', 'CNX'].includes(o.status));

    // Track how many confirmed orders have details loaded (data coverage)
    let confirmedWithDetails = 0;
    let totalTourists = 0, revenueEur = 0, costEur = 0, profitEur = 0;
    const destinations: Record<string, number>  = {};
    const touristsPerCountry: Record<string, number> = {};
    const products: Record<string, { orders: number; tourists: number }> = {
      package: { orders: 0, tourists: 0 }, hotel: { orders: 0, tourists: 0 },
      flight: { orders: 0, tourists: 0 }, transfer: { orders: 0, tourists: 0 },
      other: { orders: 0, tourists: 0 }, insurance: { orders: 0, tourists: 0 },
    };
    const agents:    Record<string, { orders: number; revenue: number; tourists: number }> = {};
    const suppliers: Record<string, { orders: number; cost: number }> = {};
    const orderValues: Array<{ orderId: any; priceEur: number; costEur: number; profitEur: number; profitPct: number }> = [];
    const allWithDetails = filteredOrders
      .map(o => this.extractOrder(o, detailMap.get(o.order_id), rates))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    const activeWithDetails = allWithDetails.filter(m => m.status !== 'CNX');
    const activeOrders = filteredOrders.filter(o => o.status !== 'CNX');
    let activeTourists = 0;
    let activeRevenueEur = 0;
    let activeCostEur = 0;
    let activeProfitEur = 0;
    const activeDestinations: Record<string, number> = {};
    const activeTouristsPerCountry: Record<string, number> = {};
    const activeProducts: Record<string, { orders: number; tourists: number }> = {
      package: { orders: 0, tourists: 0 }, hotel: { orders: 0, tourists: 0 },
      flight: { orders: 0, tourists: 0 }, transfer: { orders: 0, tourists: 0 },
      other: { orders: 0, tourists: 0 }, insurance: { orders: 0, tourists: 0 },
    };
    const activeAgents: Record<string, { orders: number; revenue: number; tourists: number }> = {};
    const activeSuppliers: Record<string, { orders: number; cost: number }> = {};
    const activeOrderValues: Array<{ orderId: any; priceEur: number; costEur: number; profitEur: number; profitPct: number }> = [];
    const startMonthBuckets: Record<string, { tourists: number; revenue_eur: number; profit_eur: number; lead_days_sum: number; lead_days_count: number }> = {};

    for (const m of allWithDetails) {
      totalTourists += m.tourists;

      for (const c of m.countries) {
        destinations[c] = (destinations[c] || 0) + 1;
        touristsPerCountry[c] = (touristsPerCountry[c] || 0) + m.tourists;
      }

      products[m.productType].orders++;
      products[m.productType].tourists += m.tourists;
      if (m.hasInsurance) { products.insurance.orders++; products.insurance.tourists += m.tourists; }

      if (m.agentName) {
        if (!agents[m.agentName]) agents[m.agentName] = { orders: 0, revenue: 0, tourists: 0 };
        agents[m.agentName].orders++;
        agents[m.agentName].revenue += m.priceEur;
        agents[m.agentName].tourists += m.tourists;
      }
    }

    for (const m of activeWithDetails) {
      activeTourists += m.tourists;
      activeRevenueEur += m.priceEur;
      if (m.status === 'CNF') {
        activeCostEur += m.costEur;
        activeProfitEur += m.profitEur;
      }

      for (const c of m.countries) {
        activeDestinations[c] = (activeDestinations[c] || 0) + 1;
        activeTouristsPerCountry[c] = (activeTouristsPerCountry[c] || 0) + m.tourists;
      }

      activeProducts[m.productType].orders++;
      activeProducts[m.productType].tourists += m.tourists;
      if (m.hasInsurance) { activeProducts.insurance.orders++; activeProducts.insurance.tourists += m.tourists; }

      if (m.agentName) {
        if (!activeAgents[m.agentName]) activeAgents[m.agentName] = { orders: 0, revenue: 0, tourists: 0 };
        activeAgents[m.agentName].orders++;
        activeAgents[m.agentName].revenue += m.priceEur;
        activeAgents[m.agentName].tourists += m.tourists;
      }

      for (const [sup, cost] of Object.entries(m.supplierCosts)) {
        if (!activeSuppliers[sup]) activeSuppliers[sup] = { orders: 0, cost: 0 };
        activeSuppliers[sup].orders++;
        activeSuppliers[sup].cost += cost;
      }

      activeOrderValues.push({
        orderId: m.orderId,
        priceEur: m.priceEur,
        costEur: m.costEur,
        profitEur: m.profitEur,
        profitPct: m.profitPct,
      });

      const monthLabel = this.monthBucketLabel(m.startDate);
      if (monthLabel) {
        if (!startMonthBuckets[monthLabel]) {
          startMonthBuckets[monthLabel] = { tourists: 0, revenue_eur: 0, profit_eur: 0, lead_days_sum: 0, lead_days_count: 0 };
        }
        startMonthBuckets[monthLabel].tourists += m.tourists;
        startMonthBuckets[monthLabel].revenue_eur += m.priceEur;
        if (m.status === 'CNF') startMonthBuckets[monthLabel].profit_eur += m.profitEur;
        if (typeof m.leadDays === 'number' && Number.isFinite(m.leadDays)) {
          startMonthBuckets[monthLabel].lead_days_sum += m.leadDays;
          startMonthBuckets[monthLabel].lead_days_count += 1;
        }
      }
    }

    for (const o of confirmed) {
      const detail = detailMap.get(o.order_id);
      const m = this.extractOrder(o, detail, rates);
      if (!m) continue;

      confirmedWithDetails++;
      revenueEur    += m.priceEur;
      costEur       += m.costEur;
      profitEur     += m.profitEur;
      for (const [sup, cost] of Object.entries(m.supplierCosts)) {
        if (!suppliers[sup]) suppliers[sup] = { orders: 0, cost: 0 };
        suppliers[sup].orders++;
        suppliers[sup].cost += cost;
      }
      orderValues.push({ orderId: m.orderId, priceEur: m.priceEur, costEur: m.costEur, profitEur: m.profitEur, profitPct: m.profitPct });
    }

    // Preserve only negative-margin orders for reporting.
    const allNegativeMargin = orderValues
      .filter(o => o.profitPct < 0)
      .sort((a, b) => a.profitPct - b.profitPct); // worst margin first
    const negative_margin_orders = allNegativeMargin.map(ov => ({
      order_id:   ov.orderId,
      revenue_eur: r2(ov.priceEur),
      cost_eur:    r2(ov.costEur),
      profit_eur:  r2(ov.profitEur),
      profit_pct:  ov.profitPct,
    }));

    // Most expensive / profitable
    const byPrice   = [...orderValues].sort((a, b) => b.priceEur - a.priceEur);
    const byProfit  = [...orderValues].sort((a, b) => b.profitEur - a.profitEur);
    const byProfPct = [...orderValues].filter(o => o.priceEur > 200).sort((a, b) => b.profitPct - a.profitPct);
    const activeByPrice = [...activeOrderValues].sort((a, b) => b.priceEur - a.priceEur);
    const activeNegativeMarginOrders = activeOrderValues
      .filter(o => o.profitPct < 0)
      .sort((a, b) => a.profitPct - b.profitPct)
      .map(ov => ({
        order_id: ov.orderId,
        revenue_eur: r2(ov.priceEur),
        cost_eur: r2(ov.costEur),
        profit_eur: r2(ov.profitEur),
        profit_pct: ov.profitPct,
      }));

    const profitPct = revenueEur > 0 ? Math.round(profitEur / revenueEur * 100) : 0;
    const activeProfitPct = activeRevenueEur > 0 ? Math.round(activeProfitEur / activeRevenueEur * 100) : 0;
    const tourStartMonths = Object.entries(startMonthBuckets)
      .sort((a, b) => b[1].tourists - a[1].tourists)
      .map(([month, data]) => ({
        month,
        tourists: Math.round(data.tourists),
        revenue_eur: r2(data.revenue_eur),
        profit_eur: r2(data.profit_eur),
        avg_lead_days: data.lead_days_count > 0 ? Math.round(data.lead_days_sum / data.lead_days_count) : null,
      }));

    return {
      orders: {
        total:                 filteredOrders.length,
        confirmed:             confirmed.length,
        cancelled:             cancelled.length,
        pending:               pending.length,
        cancellation_rate_pct: filteredOrders.length > 0 ? Math.round(cancelled.length / filteredOrders.length * 100) : 0,
      },
      data_coverage: {
        confirmed_total:       confirmed.length,
        confirmed_with_detail: confirmedWithDetails,
        detail_coverage_pct:   confirmed.length > 0 ? Math.round(confirmedWithDetails / confirmed.length * 100) : 100,
        note: confirmedWithDetails < confirmed.length
          ? `⚠️ Детали загружены только для ${confirmedWithDetails} из ${confirmed.length} подтверждённых заказов`
          : `✅ Все ${confirmed.length} подтверждённых заказов с деталями`,
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
        .sort((a, b) => (touristsPerCountry[b[0]] || 0) - (touristsPerCountry[a[0]] || 0)).slice(0, 8)
        .map(([country, orders]) => ({
          country,
          flag: countryEmoji(country),
          orders,
          tourists: touristsPerCountry[country] || 0,
          pct: totalTourists > 0 ? Math.round((touristsPerCountry[country] || 0) / totalTourists * 100) : 0,
        })),
      product_breakdown: products,
      top_agents_by_orders:      this.topList(agents, 'orders', 5),
      top_agents_by_revenue:     this.topList(agents, 'revenue', 5),
      top_suppliers_by_orders:   this.topSupplierList(suppliers, 5),
      most_expensive_order:  byPrice[0]   ? { order_id: byPrice[0].orderId,   price_eur:  r2(byPrice[0].priceEur) }    : null,
      most_profitable_abs:   byProfit[0]  ? { order_id: byProfit[0].orderId,  profit_eur: r2(byProfit[0].profitEur) }  : null,
      most_profitable_rel:   byProfPct[0] ? { order_id: byProfPct[0].orderId, profit_pct: byProfPct[0].profitPct }     : null,
      anomalies: [],
      negative_margin_orders,          // ALL orders with profit_pct < 0, sorted worst-first
      negative_margin_count: negative_margin_orders.length,
      tour_start_months: tourStartMonths,
      non_cancelled_snapshot: {
        orders_total: activeOrders.length,
        tourists: activeTourists,
        financials: {
          note: 'Revenue, cost and profit calculated for all non-cancelled orders',
          revenue_eur: r2(activeRevenueEur),
          cost_eur: r2(activeCostEur),
          profit_eur: r2(activeProfitEur),
          profit_pct: activeProfitPct,
          avg_order_eur: activeOrders.length > 0 ? r2(activeRevenueEur / activeOrders.length) : 0,
        },
        top_destinations: Object.entries(activeDestinations)
          .sort((a, b) => (activeTouristsPerCountry[b[0]] || 0) - (activeTouristsPerCountry[a[0]] || 0)).slice(0, 8)
          .map(([country, orders]) => ({
            country,
            flag: countryEmoji(country),
            orders,
            tourists: activeTouristsPerCountry[country] || 0,
            pct: activeTourists > 0 ? Math.round((activeTouristsPerCountry[country] || 0) / activeTourists * 100) : 0,
          })),
        product_breakdown: activeProducts,
        top_agents_by_orders: this.topList(activeAgents, 'orders', 5),
        top_suppliers_by_orders: this.topSupplierList(activeSuppliers, 5),
        most_expensive_order: activeByPrice[0]
          ? { order_id: activeByPrice[0].orderId, price_eur: r2(activeByPrice[0].priceEur) }
          : null,
        negative_margin_orders: activeNegativeMarginOrders,
        negative_margin_count: activeNegativeMarginOrders.length,
        tour_start_months: tourStartMonths,
      },
      data_available: filteredOrders.length > 0,
    };
  }

  // ── Section 3: Upcoming tours ─────────────────────────────────────────────
  private computeUpcomingSection(
    orders: any[],
    detailMap: Map<number, any>,
    rates: CurrencyRates | null,
  ) {
    const filteredOrders = orders.filter(o => {
      const detail = detailMap.get(o.order_id);
      const agentName = this.normalizeAgentName(detail?.agent_name || o.company_name || '');
      return !this.isIgnoredAgent(agentName);
    });
    let tourists = 0, revenueEur = 0, costEur = 0, profitEur = 0;
    const destinations: Record<string, number> = {};
    const touristsPerCountry: Record<string, number> = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0, insurance: 0 };
    const agents: Record<string, { orders: number; revenue: number }> = {};

    for (const o of filteredOrders) {
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
      confirmed_orders: filteredOrders.length,
      tourists,
      revenue_eur:  r2(revenueEur),
      cost_eur:     r2(costEur),
      profit_eur:   r2(profitEur),
      profit_pct:   revenueEur > 0 ? Math.round(profitEur / revenueEur * 100) : 0,
      top_destinations: Object.entries(destinations)
        .sort((a, b) => (touristsPerCountry[b[0]] || 0) - (touristsPerCountry[a[0]] || 0)).slice(0, 5)
        .map(([country, orders]) => ({
          country,
          flag: countryEmoji(country),
          orders,
          tourists: touristsPerCountry[country] || 0,
          pct: tourists > 0 ? Math.round((touristsPerCountry[country] || 0) / tourists * 100) : 0,
        })),
      product_breakdown: products,
      top_agents: this.topList(agents, 'orders', 5),
      data_available: filteredOrders.length > 0,
    };
  }

  // ── Section 4: Summer month ───────────────────────────────────────────────
  private computeSummerMonth(
    label: string,
    orders: any[],
    detailMap: Map<number, any>,
    rates: CurrencyRates | null,
  ) {
    const filteredOrders = orders.filter(o => {
      const detail = detailMap.get(o.order_id);
      const agentName = this.normalizeAgentName(detail?.agent_name || o.company_name || '');
      return !this.isIgnoredAgent(agentName);
    });
    let tourists = 0, revenueEur = 0, costEur = 0, profitEur = 0;
    const destinations: Record<string, number> = {};
    const touristsPerCountry: Record<string, number> = {};
    const products = { package: 0, hotel: 0, flight: 0, transfer: 0, other: 0, insurance: 0 };
    const agents: Record<string, { orders: number; revenue: number }> = {};

    for (const o of filteredOrders) {
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
      confirmed_orders: filteredOrders.length,
      tourists,
      revenue_eur:  r2(revenueEur),
      cost_eur:     r2(costEur),
      profit_eur:   r2(profitEurFinal),
      profit_pct:   revenueEur > 0 ? Math.round(profitEurFinal / revenueEur * 100) : 0,
      top_destinations: Object.entries(destinations)
        .sort((a, b) => (touristsPerCountry[b[0]] || 0) - (touristsPerCountry[a[0]] || 0)).slice(0, 5)
        .map(([country, orders]) => ({
          country,
          flag: countryEmoji(country),
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
