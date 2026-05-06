import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getDailyLookerWindow,
  getGtoLookerSyncStatus,
  syncGtoLookerOrders,
} from '../../services/gto-looker-sync.service';

export async function lookerRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/gto-orders/status', auth, async (_request, reply) => {
    const data = await getGtoLookerSyncStatus();
    return reply.send({ success: true, data });
  });

  app.get('/gto-orders/default-window', auth, async (_request, reply) => {
    return reply.send({ success: true, data: getDailyLookerWindow() });
  });

  app.post('/gto-orders/sync', auth, async (request, reply) => {
    const body = z.object({
      mode: z.enum(['daily', 'manual', 'backfill']).default('manual'),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(request.body);

    const actor = request.user as any;
    const result = await syncGtoLookerOrders({
      mode: body.mode,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      triggeredBy: actor?.email || actor?.sub || 'admin',
    });

    return reply.send({ success: true, data: result });
  });
}
