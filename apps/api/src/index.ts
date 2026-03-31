import { buildApp } from './app';
import { logger } from './lib/logger';
import { startWorkers } from './workers';
import { startScheduler } from './scheduler/scheduler.service';
import { startBot } from './bot/bot.service';
import { startLogDrain } from './lib/log-drain';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT }, 'API server started');

    await startWorkers();
    logger.info('Workers started');

    startLogDrain(30_000); // flush Redis → disk every 30 seconds

    await startScheduler();
    logger.info('Scheduler started');

    try {
      await startBot();
      logger.info('Telegram bot started');
    } catch (err) {
      logger.warn({ err }, 'Telegram bot failed to start (check TELEGRAM_BOT_TOKEN) — continuing without bot');
    }
  } catch (err) {
    logger.error(err, 'Failed to start application');
    process.exit(1);
  }
}

main();
