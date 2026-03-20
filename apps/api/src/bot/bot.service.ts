import { Telegraf } from 'telegraf';
import { prisma } from '../lib/prisma';
import { writeAuditLog } from '../lib/audit';
import { logger } from '../lib/logger';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'placeholder:token';
export const bot = new Telegraf(BOT_TOKEN);

export async function startBot() {
  bot.command('start', async (ctx) => {
    const from = ctx.from!;
    try {
      let user = await prisma.user.findUnique({ where: { telegramId: BigInt(from.id) } });

      if (!user) {
        user = await prisma.user.create({
          data: {
            telegramId: BigInt(from.id),
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
            languageCode: from.language_code,
            status: 'pending',
          },
        });

        // Create default preferences for all sources
        const sources = await prisma.dataSource.findMany();
        for (const source of sources) {
          await prisma.userReportPreference.upsert({
            where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
            create: { userId: user.id, sourceId: source.id, reportsEnabled: true },
            update: {},
          });
        }

        await writeAuditLog({ actorType: 'bot', action: 'user.registered', entityType: 'user', entityId: user.id });

        // Notify admins
        const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
        if (adminChatId) {
          await bot.telegram.sendMessage(adminChatId,
            `👤 *New subscription request*\nName: ${from.first_name || ''} ${from.last_name || ''}\nUsername: @${from.username || 'unknown'}\nTelegram ID: \`${from.id}\`\n\nReview in admin panel.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }

      const messages: Record<string, string> = {
        pending: `⏳ *Subscription Pending*\n\nYour request has been submitted and is awaiting admin approval.\nYou will be notified once approved.`,
        approved: `✅ *Welcome back!*\n\nYou are subscribed to analytics reports.\nUse /help to see available commands.`,
        blocked: `🚫 *Access Restricted*\n\nYour account has been restricted. Please contact support.`,
        deleted: `Account not found. Please contact support.`,
      };

      await ctx.reply(messages[user.status] || messages.pending, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error({ err }, 'Error in /start handler');
      await ctx.reply('An error occurred. Please try again later.');
    }
  });

  bot.command('status', async (ctx) => {
    const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user) return ctx.reply('You are not registered. Use /start to subscribe.');

    const statusLabels: Record<string, string> = {
      pending: '⏳ Pending approval',
      approved: '✅ Approved',
      blocked: '🚫 Blocked',
      deleted: '❌ Deleted',
    };

    const reportsStatus = user.globalReportsEnabled ? '✅ Enabled' : '❌ Disabled';
    await ctx.reply(
      `*Your Account Status*\n\nStatus: ${statusLabels[user.status] || user.status}\nReports: ${reportsStatus}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `*Analytics Report Bot*\n\n` +
      `/start — Subscribe to analytics reports\n` +
      `/status — Check your subscription status\n` +
      `/help — Show this help message\n\n` +
      `Reports are delivered automatically on schedule.\n` +
      `Contact your administrator to adjust report settings.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });

  // Use polling in development, webhook in production
  if (process.env.TELEGRAM_WEBHOOK_URL) {
    logger.info({ url: process.env.TELEGRAM_WEBHOOK_URL }, 'Bot using webhook mode');
    // Webhook is set up via the webhook controller
  } else {
    logger.info('Bot using polling mode');
    await bot.launch();
  }
}
