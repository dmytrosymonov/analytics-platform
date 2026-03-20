import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { fetchQueue } from '../queue/queues';
import { logger } from '../lib/logger';

export async function startScheduler() {
  const settings = await prisma.systemSetting.findMany({
    where: { key: { startsWith: 'scheduler.' } },
  });

  const cronMap: Record<string, string> = {};
  settings.forEach(s => { cronMap[s.key] = s.value; });

  const sourceTypes = ['gto', 'ga4', 'redmine'];
  for (const type of sourceTypes) {
    const cronExpr = cronMap[`scheduler.${type}_cron`] || '0 8 * * *';
    const validExpr = cron.validate(cronExpr) ? cronExpr : '0 8 * * *';

    cron.schedule(validExpr, async () => {
      await triggerScheduledRun(type);
    }, { timezone: 'UTC' });

    logger.info({ sourceType: type, cron: validExpr }, 'Scheduled source cron');
  }
}

async function triggerScheduledRun(sourceType: string) {
  const source = await prisma.dataSource.findUnique({ where: { type: sourceType as any } });
  if (!source || !source.isEnabled) return;

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setHours(0, 0, 0, 0);
  const periodStart = new Date(periodEnd.getTime() - 86400000);

  // Idempotency check
  const existing = await prisma.reportRun.findFirst({
    where: { periodStart, periodEnd, triggerType: 'scheduled' },
  });
  if (existing) {
    logger.info({ periodStart, periodEnd }, 'Scheduled run already exists, skipping');
    return;
  }

  const run = await prisma.reportRun.create({
    data: { periodStart, periodEnd, status: 'pending', triggerType: 'scheduled' },
  });

  await prisma.reportJob.create({
    data: { runId: run.id, sourceId: source.id, jobType: 'fetch', status: 'pending' },
  });

  await fetchQueue.add('fetch', { runId: run.id, sourceId: source.id }, {
    jobId: `fetch:${run.id}:${source.id}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });

  logger.info({ runId: run.id, sourceType }, 'Triggered scheduled run');
}
