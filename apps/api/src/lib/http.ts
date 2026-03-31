import axios, { AxiosInstance, CreateAxiosDefaults, InternalAxiosRequestConfig } from 'axios';
import { logger } from './logger';
import { redis } from './redis';

const REDIS_KEY   = 'http:logs';
const MAX_ENTRIES = 1000;
const MAX_SAMPLE_ITEMS = 5;    // how many array items to store as response sample
const MAX_BODY_BYTES  = 4000;  // max JSON length for non-array responses

export interface HttpLogEntry {
  id: string;
  sessionId: string;       // shared across all requests in one createHttpClient() call
  ts: string;
  connector: string;
  type: 'res' | 'err';    // one entry per completed request (req+res merged)
  method?: string;
  url?: string;
  params?: Record<string, any>;
  status?: number;
  ms?: number;
  // Response data
  items?: number;          // total array length
  responseSample?: unknown; // first MAX_SAMPLE_ITEMS items (array) or full/truncated object
  // Error data
  error?: string;
  errorBody?: string;
}

async function pushLog(entry: HttpLogEntry): Promise<void> {
  try {
    await redis.lpush(REDIS_KEY, JSON.stringify(entry));
    await redis.ltrim(REDIS_KEY, 0, MAX_ENTRIES - 1);
  } catch {
    // never block the request pipeline on log errors
  }
}

const REDACT_PARAMS  = new Set(['apikey', 'api_key', 'key', 'token', 'secret', 'password', 'access_token']);
const REDACT_HEADERS = new Set(['authorization', 'x-redmine-api-key', 'x-api-key']);

function redactParams(params?: Record<string, any>): Record<string, any> | undefined {
  if (!params) return undefined;
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) =>
      REDACT_PARAMS.has(k.toLowerCase()) ? [k, '***'] : [k, v],
    ),
  );
}

function extractResponseSample(data: unknown): { items?: number; sample?: unknown } {
  if (Array.isArray(data)) {
    return { items: data.length, sample: data.slice(0, MAX_SAMPLE_ITEMS) };
  }
  // Some APIs wrap array in { data: [...] }
  if (data && typeof data === 'object' && Array.isArray((data as any).data)) {
    const arr = (data as any).data as unknown[];
    return { items: arr.length, sample: arr.slice(0, MAX_SAMPLE_ITEMS) };
  }
  if (data && typeof data === 'object') {
    const str = JSON.stringify(data);
    return { sample: str.length <= MAX_BODY_BYTES ? data : str.slice(0, MAX_BODY_BYTES) + '…[truncated]' };
  }
  return {};
}

/**
 * Creates an Axios instance with request/response interceptors.
 *
 * - One log entry per HTTP call (request + response merged).
 * - All requests from the same client share a sessionId.
 * - Response body sample is stored (first 5 items for arrays, or up to 4KB for objects).
 * - Sensitive params/headers are redacted.
 * - Logs at debug level (success) or warn level (HTTP errors).
 */
export function createHttpClient(
  config: CreateAxiosDefaults,
  connectorName: string,
): AxiosInstance {
  const client = axios.create(config);
  const log = logger.child({ connector: connectorName });
  const sessionId = `${connectorName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  client.interceptors.request.use((req: InternalAxiosRequestConfig) => {
    (req as any)._logId   = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    (req as any)._startMs = Date.now();
    (req as any)._params  = redactParams(req.params as Record<string, any>);
    log.debug({ connector: connectorName, method: req.method?.toUpperCase(), url: req.url }, 'http request');
    return req;
  });

  client.interceptors.response.use(
    (res) => {
      const ms = Date.now() - ((res.config as any)._startMs ?? Date.now());
      const { items, sample } = extractResponseSample(res.data);
      const entry: HttpLogEntry = {
        id:            (res.config as any)._logId,
        sessionId,
        ts:            new Date().toISOString(),
        connector:     connectorName,
        type:          'res',
        method:        res.config.method?.toUpperCase(),
        url:           res.config.url,
        params:        (res.config as any)._params,
        status:        res.status,
        ms,
        items,
        responseSample: sample,
      };
      log.debug({ ...entry, responseSample: undefined }, 'http response');
      void pushLog(entry);
      return res;
    },
    (err) => {
      const ms = err.config ? Date.now() - ((err.config as any)._startMs ?? Date.now()) : undefined;
      const entry: HttpLogEntry = {
        id:        `${(err.config as any)?._logId ?? Date.now()}-e`,
        sessionId,
        ts:        new Date().toISOString(),
        connector: connectorName,
        type:      'err',
        method:    err.config?.method?.toUpperCase(),
        url:       err.config?.url,
        params:    (err.config as any)?._params,
        status:    err.response?.status,
        ms,
        error:     err.message,
        errorBody: err.response?.data
          ? JSON.stringify(err.response.data).slice(0, 500)
          : undefined,
      };
      log.warn(entry, 'http error');
      void pushLog(entry);
      return Promise.reject(err);
    },
  );

  return client;
}
