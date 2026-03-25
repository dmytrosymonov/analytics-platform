import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { startBot, getBotStatus } from '../../bot/bot.service';
import { logger } from '../../lib/logger';

export async function settingRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get('/', auth, async (request, reply) => {
    const settings = await prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
    const botStatus = getBotStatus();
    return reply.send({ success: true, data: settings, meta: { botStatus } });
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

  // Start or restart the Telegram bot with token from DB
  app.post('/reload-bot', auth, async (request, reply) => {
    try {
      await startBot();
      return reply.send({ success: true, message: 'Bot started successfully' });
    } catch (err: any) {
      logger.error({ err }, 'Failed to start bot');
      return reply.status(400).send({ success: false, error: { message: err.message } });
    }
  });

  app.get('/bot-status', auth, async (request, reply) => {
    return reply.send({ success: true, data: getBotStatus() });
  });
}
