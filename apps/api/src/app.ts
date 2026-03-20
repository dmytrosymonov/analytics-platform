import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { logger } from './lib/logger';
import { authRoutes } from './modules/auth/auth.routes';
import { userRoutes } from './modules/users/user.routes';
import { sourceRoutes } from './modules/sources/source.routes';
import { promptRoutes } from './modules/prompts/prompt.routes';
import { reportRoutes } from './modules/reports/report.routes';
import { auditRoutes } from './modules/audit/audit.routes';
import { settingRoutes } from './modules/settings/setting.routes';
import { telegramWebhookRoute } from './bot/webhook.controller';

export async function buildApp() {
  const app = Fastify({
    logger: false, // we use pino directly
    trustProxy: true,
  });

  // Security
  await app.register(helmet, {
    contentSecurityPolicy: false, // handled by nginx in prod
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3001',
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    redis: (await import('./lib/redis')).redis,
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    sign: { expiresIn: process.env.NODE_ENV === 'production' ? '15m' : '8h' },
  });

  // Auth decorator
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Metrics (simple)
  app.get('/metrics', async () => {
    return { uptime: process.uptime(), memory: process.memoryUsage() };
  });

  // Routes
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(sourceRoutes, { prefix: '/api/v1/sources' });
  await app.register(promptRoutes, { prefix: '/api/v1/prompts' });
  await app.register(reportRoutes, { prefix: '/api/v1/reports' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  await app.register(settingRoutes, { prefix: '/api/v1/settings' });
  await app.register(telegramWebhookRoute, { prefix: '/webhook' });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, url: request.url }, 'Request error');
    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      success: false,
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: statusCode === 500 ? 'Internal server error' : error.message,
      },
    });
  });

  return app;
}
