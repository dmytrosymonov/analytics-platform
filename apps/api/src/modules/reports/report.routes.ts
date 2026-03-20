import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { fetchQueue } from '../../queue/queues';

export async function reportRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/runs', auth, async (request, reply) => {
    const q = request.query as any;
    const page = parseInt(q.page || '1');
    const limit = parseInt(q.limit || '20');
    const where = q.status ? { status: q.status as any } : {};

    const [runs, total] = await Promise.all([
      prisma.reportRun.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' }, include: { jobs: true } }),
      prisma.reportRun.count({ where }),
    ]);

    return reply.send({ success: true, data: runs, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  });

  app.get('/runs/:id', auth, async (request, reply) => {
    const { id } = request.params as any;
    const run = await prisma.reportRun.findUnique({
      where: { id },
      include: { jobs: { include: { source: true } }, results: { include: { source: true } } },
    });
    if (!run) return reply.status(404).send({ success: false, error: { message: 'Run not found' } });
    return reply.send({ success: true, data: run });
  });

  app.post('/runs', auth, async (request, reply) => {
    const actor = (request.user as any);
    const body = z.object({
      periodStart: z.string(),
      periodEnd: z.string(),
      sourceIds: z.array(z.string()).optional(),
    }).parse(request.body);

    const run = await prisma.reportRun.create({
      data: {
        periodStart: new Date(body.periodStart),
        periodEnd: new Date(body.periodEnd),
        status: 'pending',
        triggerType: 'manual',
        triggeredBy: actor.sub,
      },
    });

    const sources = body.sourceIds
      ? await prisma.dataSource.findMany({ where: { id: { in: body.sourceIds }, isEnabled: true } })
      : await prisma.dataSource.findMany({ where: { isEnabled: true } });

    for (const source of sources) {
      await prisma.reportJob.create({
        data: { runId: run.id, sourceId: source.id, jobType: 'fetch', status: 'pending' },
      });
      await fetchQueue.add('fetch', { runId: run.id, sourceId: source.id }, {
        jobId: `fetch:${run.id}:${source.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    }

    return reply.status(201).send({ success: true, data: run });
  });

  app.get('/runs/:id/results', auth, async (request, reply) => {
    const { id } = request.params as any;
    const results = await prisma.reportResult.findMany({
      where: { runId: id },
      include: { source: true },
    });
    return reply.send({ success: true, data: results });
  });
}
