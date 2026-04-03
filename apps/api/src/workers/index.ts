import { Worker } from 'bullmq';
import { redis } from '../lib/redis';
import { handleFetchJob } from './fetch.worker';
import { handleAnalyzeJob } from './analyze.worker';
import { handleDeliverJob } from './deliver.worker';
import { logger } from '../lib/logger';

export async function startWorkers() {
  const connection = redis as any;

  const fetchWorker = new Worker('source-fetch', handleFetchJob, { connection, concurrency: 5 });
  const analyzeWorker = new Worker('source-analyze', handleAnalyzeJob, { connection, concurrency: 3 });
  const deliverWorker = new Worker('report-delivery', handleDeliverJob, { connection, concurrency: 5 });

  for (const worker of [fetchWorker, analyzeWorker, deliverWorker]) {
    worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Worker job failed'));
    worker.on('completed', (job) => logger.info({ jobId: job.id, name: job.name }, 'Worker job completed'));
  }
}
