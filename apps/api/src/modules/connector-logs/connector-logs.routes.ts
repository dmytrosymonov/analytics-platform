import { FastifyPluginAsync } from 'fastify';
import { redis } from '../../lib/redis';
import { HTTP_LOG_REDIS_KEY, readLogsFromDisk, clearAllLogs, drainLogs } from '../../lib/log-drain';
import { HttpLogEntry } from '../../lib/http';

export const connectorLogsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/connector-logs?connector=gto&type=err&limit=2000
  app.get('/', {
    preHandler: [(app as any).authenticate],
    handler: async (request, reply) => {
      const { connector, type, limit: limitStr } = request.query as Record<string, string>;
      const limit = Math.min(parseInt(limitStr || '2000', 10), 10_000);

      // Flush Redis to disk first so the response includes everything up to now
      await drainLogs().catch(() => {});

      // Read from disk (newest first after readLogsFromDisk)
      const diskEntries = await readLogsFromDisk() as HttpLogEntry[];

      // Also pick up anything that arrived in Redis since the drain above
      const redisRaw = await redis.lrange(HTTP_LOG_REDIS_KEY, 0, -1);
      const redisEntries: HttpLogEntry[] = redisRaw
        .map(r => { try { return JSON.parse(r) as HttpLogEntry; } catch { return null as any; } })
        .filter(Boolean)
        .reverse(); // LPUSH = newest first → reverse for chronological, then we prepend below

      // Combine: disk (newest first) + any stragglers still in Redis
      // Redis stragglers arrived after the drain, so they're the very newest
      let all: HttpLogEntry[] = [...redisEntries, ...diskEntries];

      if (connector) all = all.filter(e => e.connector === connector);
      if (type)      all = all.filter(e => e.type === type);

      return reply.send({ success: true, data: all.slice(0, limit), total: all.length });
    },
  });

  // DELETE /api/v1/connector-logs — clear Redis + disk file
  app.delete('/', {
    preHandler: [(app as any).authenticate],
    handler: async (_request, reply) => {
      await clearAllLogs();
      return reply.send({ success: true });
    },
  });
};
