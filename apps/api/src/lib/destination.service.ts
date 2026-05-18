import { redis } from './redis';
import { logger } from './logger';
import { createHttpClient } from './http';

export interface DestinationDictionary {
  idToName: Record<string, string>;
  fetchedAt: string;
  source: string;
}

const DESTINATIONS_CACHE_KEY = 'gto:destinations:v3';
const DESTINATIONS_CACHE_TTL = 86400 * 30;

function normalizeId(value: unknown): string {
  return String(value || '').trim();
}

function normalizeName(value: unknown): string {
  return String(value || '').trim();
}

export class DestinationService {
  static async getDestinationDictionary(apiKey: string, v3BaseUrl: string): Promise<DestinationDictionary> {
    const cached = await redis.get(DESTINATIONS_CACHE_KEY).catch(() => null);
    if (cached) {
      return JSON.parse(cached) as DestinationDictionary;
    }

    logger.info({ v3BaseUrl }, 'Fetching destinations from GTO v3');

    const client = createHttpClient({ baseURL: v3BaseUrl, params: { apikey: apiKey }, timeout: 10000 }, 'gto-destinations');
    const resp = await client.get('/destinations');
    const items: Record<string, unknown>[] = Array.isArray(resp.data)
      ? resp.data as Record<string, unknown>[]
      : (Array.isArray((resp.data as any)?.data) ? (resp.data as any).data : []);

    const idToName = Object.fromEntries(
      items
        .map((item) => [normalizeId(item.id), normalizeName(item.name)])
        .filter(([id, name]) => Boolean(id && name)),
    );

    const result: DestinationDictionary = {
      idToName,
      fetchedAt: new Date().toISOString(),
      source: 'gto_v3',
    };

    await redis.setex(DESTINATIONS_CACHE_KEY, DESTINATIONS_CACHE_TTL, JSON.stringify(result));
    return result;
  }
}
