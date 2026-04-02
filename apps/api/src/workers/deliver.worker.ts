import { Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { sendTelegramMessageSafe } from '../bot/bot.service';
import { logger } from '../lib/logger';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + maxLen)); i += maxLen; }
  return chunks;
}

export async function handleDeliverJob(job: Job) {
  const { runId, sourceId } = job.data;
  logger.info({ runId, sourceId }, 'Starting deliver job');

  await prisma.reportJob.upsert({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'deliver' } },
    create: { runId, sourceId, jobType: 'deliver', status: 'running', startedAt: new Date() },
    update: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } },
  });

  const result = await prisma.reportResult.findUnique({ where: { runId_sourceId: { runId, sourceId } } });
  if (!result || !result.formattedMessage) {
    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'deliver' } },
      data: { status: 'skipped', skipReason: 'No formatted message', completedAt: new Date() },
    });
    return;
  }

  // Get scheduleId from run to filter by schedule preferences
  const run = await prisma.reportRun.findUnique({ where: { id: runId } });
  const scheduleId = run?.scheduleId ?? job.data.scheduleId;

  // Eligible users: approved + global enabled + subscribed to this schedule (or source if legacy)
  let users;
  if (scheduleId) {
    users = await prisma.user.findMany({
      where: {
        status: 'approved',
        globalReportsEnabled: true,
        schedulePreferences: { some: { scheduleId, enabled: true } },
      },
    });
    // If no schedule prefs yet, fall back to source prefs (for users added before schedules)
    if (users.length === 0) {
      users = await prisma.user.findMany({
        where: {
          status: 'approved',
          globalReportsEnabled: true,
          reportPreferences: { some: { sourceId, reportsEnabled: true } },
        },
      });
    }
  } else {
    users = await prisma.user.findMany({
      where: {
        status: 'approved',
        globalReportsEnabled: true,
        reportPreferences: { some: { sourceId, reportsEnabled: true } },
      },
    });
  }

  logger.info({ runId, sourceId, userCount: users.length }, 'Delivering to eligible users');

  let sentCount = 0;
  let failedCount = 0;

  for (const user of users) {
    const sentMsg = await prisma.sentMessage.create({
      data: { resultId: result.id, userId: user.id, status: 'sent' },
    });

    try {
      const chunks = splitMessage(result.formattedMessage);
      let lastMsgId: number | undefined;
      for (const chunk of chunks) {
        const msg = await sendTelegramMessageSafe(Number(user.telegramId), chunk);
        lastMsgId = msg.message_id;
        await sleep(50); // Respect Telegram rate limits
      }

      await prisma.sentMessage.update({
        where: { id: sentMsg.id },
        data: { status: 'sent', telegramMessageId: lastMsgId ? BigInt(lastMsgId) : undefined, sentAt: new Date() },
      });
      sentCount++;
    } catch (err: any) {
      await prisma.sentMessage.update({
        where: { id: sentMsg.id },
        data: { status: 'failed', failureReason: err.message },
      });
      failedCount++;
      logger.warn({ userId: user.id, err: err.message }, 'Failed to deliver to user');
    }
  }

  await prisma.reportJob.update({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'deliver' } },
    data: { status: 'success', completedAt: new Date() },
  });

  // Check if all jobs done and update run status
  const allJobs = await prisma.reportJob.findMany({ where: { runId } });
  const allDone = allJobs.every(j => ['success', 'failed', 'skipped'].includes(j.status));
  if (allDone) {
    const successCount = allJobs.filter(j => j.status === 'success').length;
    const runStatus = successCount === 0 ? 'full_failure' : successCount === allJobs.length ? 'full_success' : 'partial_success';
    await prisma.reportRun.update({ where: { id: runId }, data: { status: runStatus as any, completedAt: new Date() } });
  }

  logger.info({ runId, sourceId, sentCount, failedCount }, 'Deliver job completed');
}
