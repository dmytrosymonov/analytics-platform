import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';

export async function settingRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/', auth, async (request, reply) => {
    const settings = await prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
    return reply.send({ success: true, data: settings });
  });

  app.patch('/', auth, async (request, reply) => {
    const actor = (request.user as any);
    const body = z.record(z.string()).parse(request.body);

    for (const [key, value] of Object.entries(body)) {
      await prisma.systemSetting.upsert({
        where: { key },
        create: { key, value, updatedBy: actor.sub },
        update: { value, updatedBy: actor.sub },
      });
    }

    return reply.send({ success: true });
  });
}
