import { Queue } from 'bullmq';
import { redis } from '../lib/redis';

const connection = redis as any;

export const fetchQueue = new Queue('source-fetch', { connection });
export const analyzeQueue = new Queue('source-analyze', { connection });
export const deliverQueue = new Queue('report-delivery', { connection });
