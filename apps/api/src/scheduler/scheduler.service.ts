import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { fetchQueue } from '../queue/queues';
import { logger } from '../lib/logger';

const scheduledTasks = new Map<string, cron.ScheduledTask>();

export async function startScheduler() {
  const schedules = await prisma.reportSchedule.findMany({
    include: { source: true },
  });

  for (const schedule of schedules) {
    if (!schedule.isEnabled) continue;
    registerSchedule(schedule);
  }

  logger.info({ count: schedules.filter(s => s.isEnabled).length }, 'Scheduler started');
}

export function registerSchedule(schedule: { id: string; cronExpression: string; source: { id: string; type: string }; periodType: string; name: string }) {
  // Stop existing task if any
  const existing = scheduledTasks.get(schedule.id);
  if (existing) { existing.stop(); scheduledTasks.delete(schedule.id); }

  const validExpr = cron.validate(schedule.cronExpression) ? schedule.cronExpression : '0 8 * * *';

  const task = cron.schedule(validExpr, async () => {
    await triggerScheduledRun(schedule.id);
  }, { timezone: 'UTC' });

  scheduledTasks.set(schedule.id, task);
  logger.info({ scheduleId: schedule.id, name: schedule.name, cron: validExpr }, 'Scheduled source cron');
}

export function unregisterSchedule(scheduleId: string) {
  const task = scheduledTasks.get(scheduleId);
  if (task) { task.stop(); scheduledTasks.delete(scheduleId); }
}

export async function triggerScheduledRun(scheduleId: string) {
  const schedule = await prisma.reportSchedule.findUnique({
    where: { id: scheduleId },
    include: { source: true },
  });
  if (!schedule || !schedule.isEnabled) return;
  if (!schedule.source.isEnabled) {
    logger.info({ scheduleId }, 'Source disabled, skipping scheduled run');
    return;
  }

  const { periodStart, periodEnd } = computePeriod(schedule.periodType as any);

  // Idempotency
  const existing = await prisma.reportRun.findFirst({
    where: { scheduleId, periodStart, periodEnd, triggerType: 'scheduled' },
  });
  if (existing) {
    logger.info({ scheduleId, periodStart }, 'Scheduled run already exists, skipping');
    return;
  }

  const run = await prisma.reportRun.create({
    data: { scheduleId, periodStart, periodEnd, status: 'pending', triggerType: 'scheduled' },
  });

  await prisma.reportJob.create({
    data: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch', status: 'pending' },
  });

  await fetchQueue.add('fetch', { runId: run.id, sourceId: schedule.source.id, scheduleId }, {
    jobId: `fetch:${run.id}:${schedule.source.id}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });

  logger.info({ runId: run.id, scheduleId, periodType: schedule.periodType }, 'Triggered scheduled run');
}

export function computePeriod(periodType: 'daily' | 'weekly' | 'monthly'): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  if (periodType === 'daily') {
    const periodEnd = new Date(today);
    const periodStart = new Date(today.getTime() - 86400000);
    return { periodStart, periodEnd };
  }

  if (periodType === 'weekly') {
    const periodEnd = new Date(today);
    const periodStart = new Date(today.getTime() - 7 * 86400000);
    return { periodStart, periodEnd };
  }

  // monthly — first day of last month to first day of this month
  const periodEnd = new Date(today.getFullYear(), today.getMonth(), 1);
  const periodStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return { periodStart, periodEnd };
}
