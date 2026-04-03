import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { fetchQueue } from '../queue/queues';
import { logger } from '../lib/logger';

type RegisteredSchedule = {
  id: string;
  cronExpression: string;
  weekendCronExpression?: string | null;
  source: { id: string; type: string };
  periodType: string;
  name: string;
  timezone?: string;
};

type ScheduleScope = 'default' | 'weekend';

const scheduledTasks = new Map<string, cron.ScheduledTask[]>();
const dtfCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

export async function startScheduler() {
  const schedules = await prisma.reportSchedule.findMany({
    include: { source: true },
  });

  for (const schedule of schedules) {
    if (!schedule.isEnabled) continue;
    await registerSchedule(schedule);
  }

  logger.info({ count: schedules.filter(s => s.isEnabled).length }, 'Scheduler started');
}

export async function getSourceTimezone(sourceId: string): Promise<string> {
  const timezoneSetting = await prisma.sourceSetting.findUnique({
    where: { sourceId_key: { sourceId, key: 'timezone' } },
  });
  return timezoneSetting?.value || 'UTC';
}

export async function registerSchedule(schedule: RegisteredSchedule) {
  unregisterSchedule(schedule.id);

  const timezone = schedule.timezone || await getSourceTimezone(schedule.source.id);
  const tasks: cron.ScheduledTask[] = [];

  tasks.push(
    createScheduledTask(schedule, timezone, 'default', cron.validate(schedule.cronExpression) ? schedule.cronExpression : '0 8 * * *'),
  );

  if (schedule.weekendCronExpression) {
    if (cron.validate(schedule.weekendCronExpression)) {
      tasks.push(createScheduledTask(schedule, timezone, 'weekend', schedule.weekendCronExpression));
    } else {
      logger.warn(
        { scheduleId: schedule.id, name: schedule.name, cron: schedule.weekendCronExpression },
        'Skipping invalid weekend cron expression',
      );
    }
  }

  scheduledTasks.set(schedule.id, tasks);
  logger.info(
    {
      scheduleId: schedule.id,
      name: schedule.name,
      cron: schedule.cronExpression,
      weekendCron: schedule.weekendCronExpression || null,
      timezone,
    },
    'Scheduled source cron',
  );
}

function createScheduledTask(schedule: RegisteredSchedule, timezone: string, scope: ScheduleScope, expression: string) {
  return cron.schedule(
    expression,
    async () => {
      const weekend = isWeekendInTimezone(new Date(), timezone);
      if (scope === 'default' && schedule.weekendCronExpression && weekend) return;
      if (scope === 'weekend' && !weekend) return;
      await triggerScheduledRun(schedule.id);
    },
    { timezone },
  );
}

function getWeekdayFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = weekdayFormatterCache.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  weekdayFormatterCache.set(timezone, formatter);
  return formatter;
}

function isWeekendInTimezone(date: Date, timezone: string) {
  const weekday = getWeekdayFormatter(timezone).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}

export function unregisterSchedule(scheduleId: string) {
  const tasks = scheduledTasks.get(scheduleId);
  if (!tasks?.length) return;

  for (const task of tasks) {
    task.stop();
  }
  scheduledTasks.delete(scheduleId);
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

  const timezone = await getSourceTimezone(schedule.source.id);
  const { periodStart, periodEnd } = computePeriod(schedule.periodType as any, timezone);

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

  logger.info({ runId: run.id, scheduleId, periodType: schedule.periodType, timezone }, 'Triggered scheduled run');
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dtfCache.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  dtfCache.set(timezone, formatter);
  return formatter;
}

function getZonedParts(date: Date, timezone: string) {
  const parts = getFormatter(timezone).formatToParts(date);
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function zonedDateTimeToUtc(timezone: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const zoned = getZonedParts(new Date(utcGuess), timezone);
  const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return new Date(utcGuess - (zonedAsUtc - utcGuess));
}

function shiftCalendarDay(year: number, month: number, day: number, offsetDays: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function shiftCalendarMonth(year: number, month: number, offsetMonths: number) {
  const shifted = new Date(Date.UTC(year, month - 1 + offsetMonths, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: 1,
  };
}

export function computePeriod(periodType: 'daily' | 'weekly' | 'monthly', timezone = 'UTC'): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const today = getZonedParts(now, timezone);
  const todayStart = zonedDateTimeToUtc(timezone, today.year, today.month, today.day);

  if (periodType === 'daily') {
    const prevDay = shiftCalendarDay(today.year, today.month, today.day, -1);
    return {
      periodStart: zonedDateTimeToUtc(timezone, prevDay.year, prevDay.month, prevDay.day),
      periodEnd: todayStart,
    };
  }

  if (periodType === 'weekly') {
    const startDay = shiftCalendarDay(today.year, today.month, today.day, -7);
    return {
      periodStart: zonedDateTimeToUtc(timezone, startDay.year, startDay.month, startDay.day),
      periodEnd: todayStart,
    };
  }

  const currentMonthStart = zonedDateTimeToUtc(timezone, today.year, today.month, 1);
  const previousMonth = shiftCalendarMonth(today.year, today.month, -1);
  return {
    periodStart: zonedDateTimeToUtc(timezone, previousMonth.year, previousMonth.month, 1),
    periodEnd: currentMonthStart,
  };
}

export function computeCurrentDayPeriod(timezone = 'UTC'): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const today = getZonedParts(now, timezone);
  const todayStart = zonedDateTimeToUtc(timezone, today.year, today.month, today.day);
  const nextDay = shiftCalendarDay(today.year, today.month, today.day, 1);
  return {
    periodStart: todayStart,
    periodEnd: zonedDateTimeToUtc(timezone, nextDay.year, nextDay.month, nextDay.day),
  };
}

export function computeRollingHoursPeriod(hours: number): { periodStart: Date; periodEnd: Date } {
  const safeHours = Math.max(1, Math.min(hours, 24 * 30));
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - safeHours * 3600000);
  return { periodStart, periodEnd };
}
