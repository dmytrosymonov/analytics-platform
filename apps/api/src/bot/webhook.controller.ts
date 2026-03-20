import { FastifyInstance } from 'fastify';
import { bot } from './bot.service';

export async function telegramWebhookRoute(app: FastifyInstance) {
  app.post('/telegram', async (request, reply) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret) {
      const token = request.headers['x-telegram-bot-api-secret-token'];
      if (token !== secret) return reply.status(403).send({ error: 'Forbidden' });
    }

    try {
      await bot.handleUpdate(request.body as any);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      return reply.status(200).send({ ok: true }); // Always 200 to Telegram
    }
  });
}
