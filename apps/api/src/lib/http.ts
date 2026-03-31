import axios, { AxiosInstance, CreateAxiosDefaults, InternalAxiosRequestConfig } from 'axios';
import { logger } from './logger';
import { redis } from './redis';

const REDIS_KEY  = 'http:logs';
const MAX_ENTRIES = 1000;

export interface HttpLogEntry {
  id: string;
  ts: string;
  connector: string;
  type: 'req' | 'res' | 'err';
  method?: string;
  url?: string;
  params?: Record<string, any>;
  status?: number;
  ms?: number;
  items?: number;
  error?: string;
  responseData?: string;
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

function redactHeaders(headers?: Record<string, any>): Record<string, any> | undefined {
  if (!headers) return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? '***' : v;
  }
  return out;
}

/**
 * Creates an Axios instance with request/response interceptors that log:
 * - Request: method, url, params (sensitive values redacted)
 * - Response: status, duration ms, item count for array responses
 * - Errors: status, duration ms, error message
 *
 * Logs at `debug` level on success, `warn` on HTTP errors.
 * Set LOG_LEVEL=debug to see request/response logs.
 */
export function createHttpClient(
  config: CreateAxiosDefaults,
  connectorName: string,
): AxiosInstance {
  const client = axios.create(config);
  const log = logger.child({ connector: connectorName });

  client.interceptors.request.use((req: InternalAxiosRequestConfig) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    (req as any)._logId  = id;
    (req as any)._startMs = Date.now();
    const entry: HttpLogEntry = {
      id,
      ts: new Date().toISOString(),
      connector: connectorName,
      type: 'req',
      method: req.method?.toUpperCase(),
      url: req.url,
      params: redactParams(req.params as Record<string, any>),
    };
    log.debug(entry, 'http request');
    void pushLog(entry);
    return req;
  });

  client.interceptors.response.use(
    (res) => {
      const ms = Date.now() - ((res.config as any)._startMs ?? Date.now());
      const items = Array.isArray(res.data) ? res.data.length
        : Array.isArray(res.data?.data) ? res.data.data.length
        : undefined;
      const entry: HttpLogEntry = {
        id: `${(res.config as any)._logId}-r`,
        ts: new Date().toISOString(),
        connector: connectorName,
        type: 'res',
        method: res.config.method?.toUpperCase(),
        url: res.config.url,
        status: res.status,
        ms,
        items,
      };
      log.debug(entry, 'http response');
      void pushLog(entry);
      return res;
    },
    (err) => {
      const ms = err.config ? Date.now() - ((err.config as any)._startMs ?? Date.now()) : undefined;
      const entry: HttpLogEntry = {
        id: `${(err.config as any)?._logId ?? Date.now()}-e`,
        ts: new Date().toISOString(),
        connector: connectorName,
        type: 'err',
        method: err.config?.method?.toUpperCase(),
        url: err.config?.url,
        params: redactParams(err.config?.params),
        status: err.response?.status,
        ms,
        error: err.message,
        responseData: err.response?.data
          ? JSON.stringify(err.response.data).slice(0, 300)
          : undefined,
      };
      log.warn(entry, 'http error');
      void pushLog(entry);
      return Promise.reject(err);
    },
  );

  return client;
}
