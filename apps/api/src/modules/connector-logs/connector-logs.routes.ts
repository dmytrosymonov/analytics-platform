import { FastifyPluginAsync } from 'fastify';
import { redis } from '../../lib/redis';
import { HttpLogEntry } from '../../lib/http';

const REDIS_KEY = 'http:logs';

export const connectorLogsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/connector-logs
  // Query params: connector, type (req|res|err), limit (default 200, max 1000)
  app.get('/', {
    preHandler: [(app as any).authenticate],
    handler: async (request, reply) => {
      const { connector, type, limit: limitStr } = request.query as Record<string, string>;
      const limit = Math.min(parseInt(limitStr || '200', 10), 1000);

      const raw = await redis.lrange(REDIS_KEY, 0, 999);
      let entries: HttpLogEntry[] = raw.map(r => {
        try { return JSON.parse(r) as HttpLogEntry; } catch { return null as any; }
      }).filter(Boolean);

      if (connector) entries = entries.filter(e => e.connector === connector);
      if (type)      entries = entries.filter(e => e.type === type);

      return reply.send({ success: true, data: entries.slice(0, limit), total: entries.length });
    },
  });

  // DELETE /api/v1/connector-logs — clear all logs
  app.delete('/', {
    preHandler: [(app as any).authenticate],
    handler: async (_request, reply) => {
      await redis.del(REDIS_KEY);
      return reply.send({ success: true });
    },
  });
};
