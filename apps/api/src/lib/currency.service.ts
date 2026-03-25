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
   * Normalizes to EUR base regardless of what the API returns.
   *
   * GTO v3 may return:
   *   - Array of { code, rate, ... } where rate = units of currency per some base
   *   - Object { rates: { CODE: number } }
   * We detect the base by checking EUR rate:
   *   - If EUR rate == 1 → EUR is already base
   *   - Otherwise → divide all rates by EUR rate to make EUR the base
   */
  private static parseResponse(data: unknown): CurrencyRates {
    let rawRates: Record<string, number> = {};

    if (Array.isArray(data)) {
      for (const item of data) {
        const code = item.code || item.currency_code || item.iso;
        const rate = parseFloat(item.rate || item.value || item.exchange_rate || '0');
        if (code && rate > 0) rawRates[code.toUpperCase()] = rate;
      }
    } else if (data && typeof data === 'object') {
      const obj = data as any;
      const inner = obj.rates || obj.data || obj.currencies || obj;
      if (typeof inner === 'object' && !Array.isArray(inner)) {
        for (const [code, rate] of Object.entries(inner)) {
          const r = parseFloat(String(rate));
          if (r > 0) rawRates[code.toUpperCase()] = r;
        }
      }
    }

    logger.debug({ rawRates }, 'Raw currency rates from GTO v3');

    // Normalize: make EUR the base
    const eurRate = rawRates['EUR'];
    if (!eurRate || eurRate === 1) {
      // EUR is already base (or EUR not present — assume rates are per EUR)
      rawRates['EUR'] = 1;
    } else {
      // Base is something else (e.g., UAH). Normalize so EUR=1
      const normalized: Record<string, number> = { EUR: 1 };
      for (const [code, rate] of Object.entries(rawRates)) {
        if (code !== 'EUR') {
          normalized[code] = rate / eurRate;
        }
      }
      rawRates = normalized;
    }

    return {
      base: 'EUR',
      rates: rawRates,
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
