import fs from 'fs/promises';
import path from 'path';
import { redis } from './redis';
import { logger } from './logger';

const LOG_DIR  = process.env.HTTP_LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'connector-http.ndjson');

export const HTTP_LOG_REDIS_KEY = 'http:logs';

// Atomically: read all items + clear the list in one round-trip
const DRAIN_SCRIPT = `
  local items = redis.call('LRANGE', KEYS[1], 0, -1)
  redis.call('DEL', KEYS[1])
  return items
`;

/**
 * Moves all pending log entries from Redis → disk (NDJSON append).
 * Returns the number of entries written.
 */
export async function drainLogs(): Promise<number> {
  const raw = await redis.eval(DRAIN_SCRIPT, 1, HTTP_LOG_REDIS_KEY) as string[];
  if (!raw || raw.length === 0) return 0;

  // LPUSH = newest first in Redis; reverse so file stays chronological (oldest at top)
  const lines = raw.slice().reverse().join('\n') + '\n';

  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(LOG_FILE, lines, 'utf-8');

  return raw.length;
}

/**
 * Reads all log entries from disk. Returns them newest-first.
 */
export async function readLogsFromDisk(): Promise<object[]> {
  try {
    const content = await fs.readFile(LOG_FILE, 'utf-8');
    const entries = content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    return entries.reverse(); // newest first for the UI
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Clears all logs — both Redis buffer and the disk file.
 */
export async function clearAllLogs(): Promise<void> {
  await redis.del(HTTP_LOG_REDIS_KEY);
  try {
    await fs.writeFile(LOG_FILE, '', 'utf-8');
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Starts a periodic drain loop. Call once on app startup.
 */
export function startLogDrain(intervalMs = 30_000): void {
  const run = async () => {
    try {
      const count = await drainLogs();
      if (count > 0) logger.debug({ count, file: LOG_FILE }, 'HTTP logs drained to disk');
    } catch (err) {
      logger.warn({ err }, 'HTTP log drain failed');
    }
  };

  // Run immediately on start, then on interval
  void run();
  setInterval(run, intervalMs);
  logger.info({ intervalMs, file: LOG_FILE }, 'HTTP log drain started');
}
