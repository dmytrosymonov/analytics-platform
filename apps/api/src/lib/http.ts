import axios, { AxiosInstance, CreateAxiosDefaults, InternalAxiosRequestConfig } from 'axios';
import { logger } from './logger';

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
    (req as any)._startMs = Date.now();
    log.debug({
      method: req.method?.toUpperCase(),
      url: req.url,
      params: redactParams(req.params as Record<string, any>),
    }, 'http request');
    return req;
  });

  client.interceptors.response.use(
    (res) => {
      const ms = Date.now() - ((res.config as any)._startMs ?? Date.now());
      log.debug({
        method: res.config.method?.toUpperCase(),
        url: res.config.url,
        status: res.status,
        ms,
        items: Array.isArray(res.data) ? res.data.length
          : Array.isArray(res.data?.data) ? res.data.data.length
          : undefined,
      }, 'http response');
      return res;
    },
    (err) => {
      const ms = err.config ? Date.now() - ((err.config as any)._startMs ?? Date.now()) : undefined;
      log.warn({
        method: err.config?.method?.toUpperCase(),
        url: err.config?.url,
        params: redactParams(err.config?.params),
        headers: redactHeaders(err.config?.headers),
        status: err.response?.status,
        ms,
        error: err.message,
        responseData: err.response?.data
          ? JSON.stringify(err.response.data).slice(0, 200)
          : undefined,
      }, 'http error');
      return Promise.reject(err);
    },
  );

  return client;
}
