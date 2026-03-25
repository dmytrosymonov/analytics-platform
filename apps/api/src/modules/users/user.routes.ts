import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { writeAuditLog } from '../../lib/audit';
import { bot } from '../../bot/bot.service';

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['approved', 'deleted'],
  approved: ['blocked', 'deleted'],
  blocked: ['approved', 'deleted'],
  deleted: [],
};

export async function userRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  // Manually add a user by Telegram ID
  app.post('/', auth, async (request, reply) => {
    const actor = (request.user as any);
    const body = z.object({
      telegramId: z.string().regex(/^\d+$/, 'Must be numeric'),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      username: z.string().optional(),
      status: z.enum(['pending', 'approved']).default('approved'),
    }).parse(request.body);

    const existing = await prisma.user.findUnique({ where: { telegramId: BigInt(body.telegramId) } });
    if (existing) {
      return reply.status(409).send({ success: false, error: { message: 'User with this Telegram ID already exists' } });
    }

    const user = await prisma.user.create({
      data: {
        telegramId: BigInt(body.telegramId),
        firstName: body.firstName,
        lastName: body.lastName,
        username: body.username,
        status: body.status,
        globalReportsEnabled: true,
      },
    });

    // Create default preferences for all sources
    const sources = await prisma.dataSource.findMany();
    for (const source of sources) {
      await prisma.userReportPreference.upsert({
        where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
        create: { userId: user.id, sourceId: source.id, reportsEnabled: true },
        update: {},
      });
    }

    await writeAuditLog({
      actorType: 'admin', actorId: actor.sub,
      action: 'user.created_manually', entityType: 'user', entityId: user.id,
      afterState: { telegramId: body.telegramId, status: body.status },
    });

    return reply.status(201).send({ success: true, data: user });
  });

  app.get('/', auth, async (request, reply) => {
    const query = request.query as any;
    const page = parseInt(query.page || '1');
    const limit = parseInt(query.limit || '20');
    const status = query.status;

    const where = status ? { status: status as any } : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    return reply.send({ success: true, data: users, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  });

  app.get('/:id', auth, async (request, reply) => {
    const { id } = request.params as any;
    const user = await prisma.user.findUnique({
      where: { id },
      include: { reportPreferences: { include: { source: true } } },
    });
    if (!user) return reply.status(404).send({ success: false, error: { message: 'User not found' } });
    return reply.send({ success: true, data: user });
  });

  app.patch('/:id/status', auth, async (request, reply) => {
    const { id } = request.params as any;
    const { status } = z.object({ status: z.enum(['approved', 'blocked', 'deleted']) }).parse(request.body);
    const actor = (request.user as any);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.status(404).send({ success: false, error: { message: 'User not found' } });

    const allowed = VALID_TRANSITIONS[user.status] || [];
    if (!allowed.includes(status)) {
      return reply.status(400).send({ success: false, error: { message: `Cannot transition from ${user.status} to ${status}` } });
    }

    const updated = await prisma.user.update({ where: { id }, data: { status: status as any } });

    await writeAuditLog({
      actorType: 'admin',
      actorId: actor.sub,
      action: `user.${status}`,
      entityType: 'user',
      entityId: id,
      beforeState: { status: user.status },
      afterState: { status },
      ipAddress: request.ip,
    });

    // Notify user via Telegram
    try {
      const messages: Record<string, string> = {
        approved: '✅ Your account has been approved! You will start receiving analytics reports.',
        blocked: '🚫 Your account has been restricted. Contact support for assistance.',
        deleted: 'Your account has been removed from the system.',
      };
      if (messages[status]) {
        await bot.telegram.sendMessage(Number(user.telegramId), messages[status]);
      }
    } catch (_) { /* ignore telegram errors */ }

    return reply.send({ success: true, data: updated });
  });

  app.patch('/:id/reports', auth, async (request, reply) => {
    const { id } = request.params as any;
    const { globalReportsEnabled } = z.object({ globalReportsEnabled: z.boolean() }).parse(request.body);
    const actor = (request.user as any);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.status(404).send({ success: false, error: { message: 'User not found' } });

    const updated = await prisma.user.update({ where: { id }, data: { globalReportsEnabled } });

    await writeAuditLog({
      actorType: 'admin', actorId: actor.sub,
      action: 'user.reports.updated', entityType: 'user', entityId: id,
      beforeState: { globalReportsEnabled: user.globalReportsEnabled },
      afterState: { globalReportsEnabled },
    });

    return reply.send({ success: true, data: updated });
  });

  app.get('/:id/preferences', auth, async (request, reply) => {
    const { id } = request.params as any;
    const prefs = await prisma.userReportPreference.findMany({
      where: { userId: id },
      include: { source: { select: { id: true, name: true, type: true } } },
    });
    return reply.send({ success: true, data: prefs });
  });

  app.patch('/:id/preferences/:sourceId', auth, async (request, reply) => {
    const { id, sourceId } = request.params as any;
    const { reportsEnabled } = z.object({ reportsEnabled: z.boolean() }).parse(request.body);

    const pref = await prisma.userReportPreference.upsert({
      where: { userId_sourceId: { userId: id, sourceId } },
      create: { userId: id, sourceId, reportsEnabled },
      update: { reportsEnabled },
    });

    return reply.send({ success: true, data: pref });
  });
}
