import { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma';

export async function auditRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/logs', auth, async (request, reply) => {
    const q = request.query as any;
    const page = parseInt(q.page || '1');
    const limit = parseInt(q.limit || '50');

    const where: any = {};
    if (q.action) where.action = { contains: q.action };
    if (q.entityType) where.entityType = q.entityType;
    if (q.actorId) where.actorId = q.actorId;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.auditLog.count({ where }),
    ]);

    return reply.send({ success: true, data: logs, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  });
}
