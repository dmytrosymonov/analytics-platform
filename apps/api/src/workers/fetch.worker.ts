import { Job } from 'bullmq';
import { prisma } from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { connectorRegistry } from '../connectors/registry';
import { analyzeQueue } from '../queue/queues';
import { logger } from '../lib/logger';

export async function handleFetchJob(job: Job) {
  const { runId, sourceId } = job.data;
  logger.info({ runId, sourceId }, 'Starting fetch job');

  await prisma.reportJob.upsert({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'fetch' } },
    create: { runId, sourceId, jobType: 'fetch', status: 'running', startedAt: new Date(), attemptCount: 1 },
    update: { status: 'running', startedAt: new Date(), attemptCount: { increment: 1 } },
  });

  await prisma.reportRun.update({ where: { id: runId }, data: { status: 'running', startedAt: new Date() } }).catch(() => {});

  // Check source enabled
  const source = await prisma.dataSource.findUnique({ where: { id: sourceId } });
  if (!source) { return await skipJob(runId, sourceId, 'Source not found'); }
  if (!source.isEnabled) { return await skipJob(runId, sourceId, 'Source is disabled'); }

  // Check credentials
  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId } });
  if (!credRecord) { return await skipJob(runId, sourceId, 'No credentials configured'); }

  const run = await prisma.reportRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Run not found');

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(decrypt(credRecord.encryptedPayload));
  } catch {
    return await skipJob(runId, sourceId, 'Failed to decrypt credentials');
  }

  const settings: Record<string, string> = {};
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId } });
  settingRows.forEach(s => { settings[s.key] = s.value; });

  const connector = connectorRegistry.get(source.type);
  const result = await connector.fetchData(credentials, settings, { start: run.periodStart, end: run.periodEnd });

  if (!result.success || !result.data) {
    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'fetch' } },
      data: { status: 'failed', lastError: result.error?.message || 'Fetch failed', completedAt: new Date() },
    });
    throw new Error(result.error?.message || 'Connector fetch failed');
  }

  await prisma.reportResult.upsert({
    where: { runId_sourceId: { runId, sourceId } },
    create: { runId, sourceId, normalizedData: result.data.metrics as any, formattedMessage: '' },
    update: { normalizedData: result.data.metrics as any },
  });

  await prisma.reportJob.update({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'fetch' } },
    data: { status: 'success', completedAt: new Date() },
  });

  logger.info({ runId, sourceId }, 'Fetch job succeeded, enqueueing analyze');
  await analyzeQueue.add('analyze', { runId, sourceId }, { jobId: `analyze:${runId}:${sourceId}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 } });
}

async function skipJob(runId: string, sourceId: string, reason: string) {
  logger.warn({ runId, sourceId, reason }, 'Skipping fetch job');
  await prisma.reportJob.upsert({
    where: { runId_sourceId_jobType: { runId, sourceId, jobType: 'fetch' } },
    create: { runId, sourceId, jobType: 'fetch', status: 'skipped', skipReason: reason, completedAt: new Date() },
    update: { status: 'skipped', skipReason: reason, completedAt: new Date() },
  });
  await checkRunCompletion(runId);
}

async function checkRunCompletion(runId: string) {
  const jobs = await prisma.reportJob.findMany({ where: { runId } });
  const allDone = jobs.every(j => ['success', 'failed', 'skipped'].includes(j.status));
  if (!allDone) return;

  const successCount = jobs.filter(j => j.status === 'success').length;
  const status = successCount === 0 ? 'full_failure' : successCount === jobs.length ? 'full_success' : 'partial_success';
  await prisma.reportRun.update({ where: { id: runId }, data: { status: status as any, completedAt: new Date() } });
}
