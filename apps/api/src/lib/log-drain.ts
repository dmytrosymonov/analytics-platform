import fs from 'fs/promises';
import path from 'path';
import { redis } from './redis';
import { logger } from './logger';

const LOG_DIR         = process.env.HTTP_LOG_DIR || path.join(process.cwd(), 'logs');
const RETENTION_DAYS  = 14;

export const HTTP_LOG_REDIS_KEY = 'http:logs';

// Atomically: read all items + clear the list in one round-trip
const DRAIN_SCRIPT = `
  local items = redis.call('LRANGE', KEYS[1], 0, -1)
  redis.call('DEL', KEYS[1])
  return items
`;

function dailyFile(date = new Date()): string {
  return path.join(LOG_DIR, `connector-http-${date.toISOString().slice(0, 10)}.ndjson`);
}

async function deleteOldFiles(): Promise<void> {
  let files: string[];
  try {
    files = await fs.readdir(LOG_DIR);
  } catch {
    return; // directory doesn't exist yet
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  for (const file of files) {
    if (!file.startsWith('connector-http-') || !file.endsWith('.ndjson')) continue;
    const dateStr = file.slice('connector-http-'.length, -'.ndjson'.length); // YYYY-MM-DD
    if (new Date(dateStr) < cutoff) {
      await fs.unlink(path.join(LOG_DIR, file)).catch(() => {});
      logger.debug({ file }, 'Deleted old HTTP log file');
    }
  }
}

/**
 * Atomically moves all log entries from Redis → today's NDJSON file.
 * Deletes files older than RETENTION_DAYS.
 * Returns number of entries written.
 */
export async function drainLogs(): Promise<number> {
  const raw = await redis.eval(DRAIN_SCRIPT, 1, HTTP_LOG_REDIS_KEY) as string[];
  if (!raw || raw.length === 0) return 0;

  // LPUSH = newest first; reverse so file stays chronological (oldest at top)
  const lines = raw.slice().reverse().join('\n') + '\n';

  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(dailyFile(), lines, 'utf-8');

  await deleteOldFiles();

  return raw.length;
}

/**
 * Reads all log entries from the last RETENTION_DAYS daily files.
 * Returns them newest-first.
 */
export async function readLogsFromDisk(): Promise<object[]> {
  let files: string[];
  try {
    files = await fs.readdir(LOG_DIR);
  } catch {
    return [];
  }

  const logFiles = files
    .filter(f => f.startsWith('connector-http-') && f.endsWith('.ndjson'))
    .sort(); // alphabetical = chronological (YYYY-MM-DD)

  const all: object[] = [];
  for (const file of logFiles) {
    const content = await fs.readFile(path.join(LOG_DIR, file), 'utf-8').catch(() => '');
    const entries = content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    all.push(...entries);
  }

  return all.reverse(); // newest first for the UI
}

/**
 * Clears all logs — Redis buffer + all daily files.
 */
export async function clearAllLogs(): Promise<void> {
  await redis.del(HTTP_LOG_REDIS_KEY);

  let files: string[];
  try {
    files = await fs.readdir(LOG_DIR);
  } catch {
    return;
  }

  for (const file of files) {
    if (file.startsWith('connector-http-') && file.endsWith('.ndjson')) {
      await fs.unlink(path.join(LOG_DIR, file)).catch(() => {});
    }
  }
}

/**
 * Starts a periodic drain loop. Call once on app startup.
 */
export function startLogDrain(intervalMs = 30_000): void {
  const run = async () => {
    try {
      const count = await drainLogs();
      if (count > 0) logger.debug({ count }, 'HTTP logs drained to disk');
    } catch (err) {
      logger.warn({ err }, 'HTTP log drain failed');
    }
  };

  void run();
  setInterval(run, intervalMs);
  logger.info({ intervalMs, retentionDays: RETENTION_DAYS, dir: LOG_DIR }, 'HTTP log drain started');
}
