import axios from 'axios';
import { redis } from './redis';
import { logger } from './logger';

export interface CurrencyRates {
  base: 'EUR';
  rates: Record<string, number>; // code → units per 1 EUR
  fetchedAt: string;
  source: string;
}

const CACHE_KEY_PREFIX = 'gto:currency_rates:';
const CACHE_TTL = 86400; // 24 hours

export class CurrencyService {
  /**
   * Returns exchange rates with EUR as base.
   * Rates are cached in Redis per calendar day.
   * On first call of the day: fetches fresh rates from GTO v3 API.
   */
  static async getRates(apiKey: string, v3BaseUrl: string): Promise<CurrencyRates> {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `${CACHE_KEY_PREFIX}${today}`;

    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      return JSON.parse(cached) as CurrencyRates;
    }

    logger.info({ v3BaseUrl }, 'Fetching fresh currency rates from GTO v3');

    try {
      const resp = await axios.get(`${v3BaseUrl}/currency_rates`, {
        params: { apikey: apiKey },
        timeout: 10000,
      });

      const rates = this.parseResponse(resp.data);
      logger.info({ ratesCount: Object.keys(rates.rates).length }, 'Currency rates fetched successfully');

      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(rates));
      return rates;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to fetch currency rates from GTO v3');
      throw err;
    }
  }

  /**
   * Parse GTO v3 /currency_rates response.
   *
   * GTO v3 returns cross-rates as an array of:
   *   { currency_from, currency_to, value_from, value_to }
   * e.g. { currency_from:"EUR", currency_to:"UAH", value_from:100, value_to:5178 }
   * meaning 100 EUR = 5178 UAH → 1 EUR = 51.78 UAH
   *
   * We build a directed graph of all known rates and do BFS from EUR
   * to derive rates for all currencies in terms of "units per 1 EUR".
   */
  private static parseResponse(data: unknown): CurrencyRates {
    const obj = data as any;
    const items: any[] = Array.isArray(obj) ? obj : (Array.isArray(obj?.data) ? obj.data : []);

    // Build graph: graph[A][B] = rate  (1 A = rate B)
    const graph: Record<string, Record<string, number>> = {};

    const addEdge = (from: string, to: string, rate: number) => {
      if (!graph[from]) graph[from] = {};
      if (!graph[to]) graph[to] = {};
      graph[from][to] = rate;
      graph[to][from] = 1 / rate; // reverse edge
    };

    for (const item of items) {
      const from = String(item.currency_from || '').toUpperCase();
      const to   = String(item.currency_to   || '').toUpperCase();
      const vf   = parseFloat(item.value_from) || 0;
      const vt   = parseFloat(item.value_to)   || 0;
      if (!from || !to || vf === 0) continue;
      addEdge(from, to, vt / vf); // 1 FROM = (vt/vf) TO
    }

    logger.debug({ graph }, 'Currency rate graph from GTO v3');

    // BFS from EUR to find all reachable currencies
    // rates[CODE] = how many CODE per 1 EUR
    const rates: Record<string, number> = { EUR: 1 };
    const queue = ['EUR'];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentRate = rates[current]; // units of `current` per 1 EUR
      const neighbors = graph[current] || {};

      for (const [neighbor, edgeRate] of Object.entries(neighbors)) {
        if (rates[neighbor] !== undefined) continue;
        // 1 EUR = currentRate CURRENT, 1 CURRENT = edgeRate NEIGHBOR
        // → 1 EUR = currentRate * edgeRate NEIGHBOR
        rates[neighbor] = currentRate * edgeRate;
        queue.push(neighbor);
      }
    }

    logger.info({ rates, currencies: Object.keys(rates) }, 'Currency rates normalized to EUR base');

    return {
      base: 'EUR',
      rates,
      fetchedAt: new Date().toISOString(),
      source: 'gto_v3',
    };
  }

  /**
   * Convert amount from any currency to EUR.
   * rates.rates[CODE] = units of CODE per 1 EUR
   * So: EUR = amount / rates[fromCode]
   */
  static toEur(amount: number, fromCode: string, rates: CurrencyRates): number {
    if (!fromCode || fromCode.toUpperCase() === 'EUR') return Math.round(amount * 100) / 100;
    const rate = rates.rates[fromCode.toUpperCase()];
    if (!rate || rate === 0) {
      logger.warn({ fromCode }, 'Unknown currency, returning amount unconverted');
      return Math.round(amount * 100) / 100;
    }
    return Math.round((amount / rate) * 100) / 100;
  }

  /**
   * Convert a map of { currency: amount } to EUR totals.
   */
  static totalToEur(byCurrency: Record<string, number>, rates: CurrencyRates): number {
    return Object.entries(byCurrency).reduce((sum, [code, amount]) => {
      return sum + this.toEur(amount, code, rates);
    }, 0);
  }

  /** Invalidate today's cache (force refresh on next call) */
  static async invalidateCache(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await redis.del(`${CACHE_KEY_PREFIX}${today}`);
  }
}
