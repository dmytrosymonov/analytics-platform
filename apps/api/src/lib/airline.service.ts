import { redis } from './redis';
import { logger } from './logger';
import { createHttpClient } from './http';

export interface AirlineDictionary {
  codeToName: Record<string, string>;
  duplicateCodeWarnings: string[];
  duplicateNameWarnings: string[];
  fetchedAt: string;
  source: string;
}

const AIRLINES_CACHE_KEY = 'gto:airlines:v3';
const AIRLINES_CACHE_TTL = 86400 * 30;

function normalizeCode(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function normalizeName(value: unknown): string {
  return String(value || '').trim();
}

function findAirlineCode(item: Record<string, unknown>): string {
  for (const key of ['code', 'iata', 'iata_code', 'code_iata', 'airline_code']) {
    const code = normalizeCode(item[key]);
    if (code) return code;
  }
  return '';
}

function findAirlineName(item: Record<string, unknown>): string {
  for (const key of ['name', 'title', 'airline_name']) {
    const name = normalizeName(item[key]);
    if (name) return name;
  }
  return '';
}

export class AirlineService {
  static async getAirlineDictionary(apiKey: string, v3BaseUrl: string): Promise<AirlineDictionary> {
    const cached = await redis.get(AIRLINES_CACHE_KEY).catch(() => null);
    if (cached) {
      return JSON.parse(cached) as AirlineDictionary;
    }

    logger.info({ v3BaseUrl }, 'Fetching airlines from GTO v3');

    const client = createHttpClient({ baseURL: v3BaseUrl, params: { apikey: apiKey }, timeout: 10000 }, 'gto-airlines');
    const resp = await client.get('/airlines');
    const items: Record<string, unknown>[] = Array.isArray(resp.data)
      ? resp.data as Record<string, unknown>[]
      : (Array.isArray((resp.data as any)?.data) ? (resp.data as any).data : []);

    const codeToName: Record<string, string> = {};
    const duplicateCodeWarnings = new Set<string>();
    const duplicateNameWarnings = new Set<string>();
    const normalizedNameToCodes = new Map<string, Set<string>>();

    for (const item of items) {
      const code = findAirlineCode(item);
      const name = findAirlineName(item);
      if (!code) continue;

      const existing = codeToName[code];
      if (!existing) {
        codeToName[code] = name;
      } else if (normalizeName(existing).toLocaleLowerCase('en-US') !== normalizeName(name).toLocaleLowerCase('en-US')) {
        if (name) {
          duplicateCodeWarnings.add(`Duplicate airline code ${code}: keeping "${existing}" over "${name}"`);
        }
      }

      const normalizedName = normalizeName(name).toLocaleLowerCase('en-US');
      if (normalizedName) {
        const codes = normalizedNameToCodes.get(normalizedName) || new Set<string>();
        codes.add(code);
        normalizedNameToCodes.set(normalizedName, codes);
      }
    }

    for (const [normalizedName, codes] of normalizedNameToCodes.entries()) {
      if (codes.size > 1) {
        duplicateNameWarnings.add(`Duplicate airline name "${normalizedName}" for codes ${Array.from(codes).sort().join(', ')}`);
      }
    }

    const result: AirlineDictionary = {
      codeToName,
      duplicateCodeWarnings: Array.from(duplicateCodeWarnings).sort(),
      duplicateNameWarnings: Array.from(duplicateNameWarnings).sort(),
      fetchedAt: new Date().toISOString(),
      source: 'gto_v3',
    };

    if (result.duplicateCodeWarnings.length > 0 || result.duplicateNameWarnings.length > 0) {
      logger.warn({
        duplicateCodeWarnings: result.duplicateCodeWarnings,
        duplicateNameWarnings: result.duplicateNameWarnings,
      }, 'Detected duplicate airline entries in GTO v3');
    }

    await redis.setex(AIRLINES_CACHE_KEY, AIRLINES_CACHE_TTL, JSON.stringify(result));
    return result;
  }
}
