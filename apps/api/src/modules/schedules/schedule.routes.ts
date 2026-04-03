import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { writeAuditLog } from '../../lib/audit';
import { computePeriod, getSourceTimezone, registerSchedule, unregisterSchedule } from '../../scheduler/scheduler.service';
import { fetchQueue } from '../../queue/queues';

export async function scheduleRoutes(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  // List all schedules (optionally filtered by sourceId)
  app.get('/', auth, async (request, reply) => {
    const { sourceId } = request.query as any;
    const schedules = await prisma.reportSchedule.findMany({
      where: sourceId ? { sourceId } : {},
      include: { source: { select: { id: true, name: true, type: true } } },
      orderBy: [{ sourceId: 'asc' }, { periodType: 'asc' }],
    });
    return reply.send({ success: true, data: schedules });
  });

  // Create a new schedule for a source
  app.post('/', auth, async (request, reply) => {
    const actor = (request.user as any);
    const body = z.object({
      sourceId: z.string().uuid(),
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      cronExpression: z.string(),
      periodType: z.enum(['daily', 'weekly', 'monthly']),
      isEnabled: z.boolean().default(false),
    }).parse(request.body);

    const source = await prisma.dataSource.findUnique({ where: { id: body.sourceId } });
    if (!source) return reply.status(404).send({ success: false, error: { message: 'Source not found' } });

    const schedule = await prisma.reportSchedule.create({ data: body });

    if (schedule.isEnabled) {
      await registerSchedule({ ...schedule, source: { id: source.id, type: source.type } });
    }

    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'schedule.created', entityType: 'schedule', entityId: schedule.id, afterState: body });
    return reply.status(201).send({ success: true, data: schedule });
  });

  // Update schedule (toggle, rename, change cron/period)
  app.patch('/:id', auth, async (request, reply) => {
    const { id } = request.params as any;
    const actor = (request.user as any);
    const body = z.object({
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
      cronExpression: z.string().optional(),
      periodType: z.enum(['daily', 'weekly', 'monthly']).optional(),
      isEnabled: z.boolean().optional(),
    }).parse(request.body);

    const existing = await prisma.reportSchedule.findUnique({ where: { id }, include: { source: true } });
    if (!existing) return reply.status(404).send({ success: false, error: { message: 'Schedule not found' } });

    const updated = await prisma.reportSchedule.update({ where: { id }, data: body, include: { source: { select: { id: true, type: true } } } });

    // Update cron task
    if (updated.isEnabled) {
      await registerSchedule({ ...updated, source: { id: updated.source.id, type: updated.source.type } });
    } else {
      unregisterSchedule(id);
    }

    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'schedule.updated', entityType: 'schedule', entityId: id, beforeState: { isEnabled: existing.isEnabled }, afterState: body });
    return reply.send({ success: true, data: updated });
  });

  // Delete a schedule
  app.delete('/:id', auth, async (request, reply) => {
    const { id } = request.params as any;
    const actor = (request.user as any);

    const existing = await prisma.reportSchedule.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ success: false, error: { message: 'Schedule not found' } });

    unregisterSchedule(id);
    await prisma.reportSchedule.delete({ where: { id } });

    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'schedule.deleted', entityType: 'schedule', entityId: id });
    return reply.send({ success: true });
  });

  // Manually trigger a schedule run now
  app.post('/:id/trigger', auth, async (request, reply) => {
    const { id } = request.params as any;
    const actor = (request.user as any);

    const schedule = await prisma.reportSchedule.findUnique({ where: { id }, include: { source: true } });
    if (!schedule) return reply.status(404).send({ success: false, error: { message: 'Schedule not found' } });

    const timezone = await getSourceTimezone(schedule.source.id);
    const { periodStart, periodEnd } = computePeriod(schedule.periodType as any, timezone);

    const run = await prisma.reportRun.create({
      data: { scheduleId: id, periodStart, periodEnd, status: 'pending', triggerType: 'manual', triggeredBy: actor.sub },
    });
    await prisma.reportJob.create({
      data: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch', status: 'pending' },
    });
    await fetchQueue.add('fetch', { runId: run.id, sourceId: schedule.source.id, scheduleId: id }, {
      jobId: `fetch:${run.id}:${schedule.source.id}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    await writeAuditLog({ actorType: 'admin', actorId: actor.sub, action: 'schedule.triggered_manual', entityType: 'schedule', entityId: id });
    return reply.send({ success: true, data: { runId: run.id } });
  });

  // Get user preferences for all schedules
  app.get('/preferences/:userId', auth, async (request, reply) => {
    const { userId } = request.params as any;
    const prefs = await prisma.userSchedulePreference.findMany({
      where: { userId },
      include: { schedule: { include: { source: { select: { id: true, name: true, type: true } } } } },
    });
    return reply.send({ success: true, data: prefs });
  });

  // Set user preference for a schedule
  app.patch('/preferences/:userId/:scheduleId', auth, async (request, reply) => {
    const { userId, scheduleId } = request.params as any;
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    const actor = (request.user as any);

    const existing = await prisma.userSchedulePreference.findUnique({
      where: { userId_scheduleId: { userId, scheduleId } },
    });

    const pref = await prisma.userSchedulePreference.upsert({
      where: { userId_scheduleId: { userId, scheduleId } },
      create: { userId, scheduleId, enabled },
      update: { enabled },
    });

    await writeAuditLog({
      actorType: 'admin',
      actorId: actor.sub,
      action: 'user.schedule_access.updated',
      entityType: 'user',
      entityId: userId,
      beforeState: { scheduleId, enabled: existing?.enabled ?? true },
      afterState: { scheduleId, enabled },
      ipAddress: request.ip,
    });

    return reply.send({ success: true, data: pref });
  });

  app.delete('/preferences/:userId/:scheduleId', auth, async (request, reply) => {
    const { userId, scheduleId } = request.params as any;
    const actor = (request.user as any);

    const existing = await prisma.userSchedulePreference.findUnique({
      where: { userId_scheduleId: { userId, scheduleId } },
    });

    if (!existing) {
      return reply.send({ success: true, data: { removed: false } });
    }

    await prisma.userSchedulePreference.delete({
      where: { userId_scheduleId: { userId, scheduleId } },
    });

    await writeAuditLog({
      actorType: 'admin',
      actorId: actor.sub,
      action: 'user.schedule_subscription.deleted',
      entityType: 'user',
      entityId: userId,
      beforeState: { scheduleId, enabled: existing.enabled },
      afterState: { scheduleId, removed: true },
      ipAddress: request.ip,
    });

    return reply.send({ success: true, data: { removed: true } });
  });
}
