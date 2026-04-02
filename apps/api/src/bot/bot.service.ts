import { Telegraf, Markup } from 'telegraf';
import { prisma } from '../lib/prisma';
import { writeAuditLog } from '../lib/audit';
import { logger } from '../lib/logger';
import { decrypt } from '../lib/encryption';
import { connectorRegistry } from '../connectors/registry';
import { llmService } from '../llm/llm.service';
import { promptRegistry } from '../llm/prompt-registry.service';
import { computePeriod, getSourceTimezone } from '../scheduler/scheduler.service';

// ── Mutable bot instance (replaced on reload) ────────────────────────────────
let _bot: Telegraf = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || 'placeholder:token');
let _botRunning = false;

// Proxy so other modules always get the current instance
export const bot = new Proxy({} as Telegraf, {
  get(_target, prop) {
    return (_bot as any)[prop];
  },
});

// ── Session state for multi-step /ask flow (in-memory, ok for internal tool) ─
interface AskSession {
  step: 'waiting_question';
  sourceId: string;
  sourceName: string;
}
const sessions = new Map<number, AskSession>();

function stripSummerSection(text: string): string {
  return text.replace(/\n{2,}☀️ Лето:[\s\S]*$/u, '').trim();
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
}

function formatSummerSalesOutlook(metrics: any): string {
  const section = metrics?.computed?.section4_summer;
  if (!section) throw new Error('Летние данные недоступны');

  const months = [section.june, section.july, section.august].filter(Boolean);
  const topDestinations = Array.isArray(section.top_destinations_combined)
    ? section.top_destinations_combined.slice(0, 5)
    : [];

  const lines: string[] = [
    '☀️ *Summer Sales Outlook*',
    `Сезон: лето ${section.year || ''}`.trim(),
    '',
  ];

  for (const month of months) {
    lines.push(
      `${month.label}: ${formatInt(month.confirmed_orders)} зак / ${formatInt(month.tourists)} туристов / GMV: ${formatInt(month.revenue_eur)} EUR / Gross profit: ${formatInt(month.profit_eur)} EUR (${month.profit_pct}%)`,
    );
  }

  if (topDestinations.length > 0) {
    lines.push('', 'Самые популярные направления:');
    for (const d of topDestinations) {
      lines.push(`${d.flag || ''}${d.country} - ${formatInt(d.tourists)} туристов (${d.pct}%)`.trim());
    }
  }

  return lines.join('\n');
}

function isTelegramParseError(err: any): boolean {
  return /can't parse entities/i.test(err?.message || '');
}

export async function sendTelegramMessageSafe(chatId: number, text: string) {
  try {
    return await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    } as any);
  } catch (err: any) {
    if (!isTelegramParseError(err)) throw err;
    logger.warn({ chatId, err: err.message }, 'Telegram markdown send failed, retrying without parse mode');
    return bot.telegram.sendMessage(chatId, text, {
      disable_web_page_preview: true,
    } as any);
  }
}

async function replySafe(ctx: any, text: string, extra: Record<string, unknown> = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra } as any);
  } catch (err: any) {
    if (!isTelegramParseError(err)) throw err;
    logger.warn({ err: err.message }, 'Telegram markdown reply failed, retrying without parse mode');
    return ctx.reply(text, extra as any);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getUser(telegramId: number) {
  return prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
}

async function requireApproved(ctx: any): Promise<{ id: string; telegramId: bigint } | null> {
  const user = await getUser(ctx.from!.id);
  if (!user) {
    await ctx.reply('Вы не зарегистрированы. Используйте /start для подписки.');
    return null;
  }
  if (user.status !== 'approved') {
    const msgs: Record<string, string> = {
      pending: '⏳ Ваш аккаунт ожидает подтверждения администратора.',
      blocked:  '🚫 Ваш аккаунт заблокирован.',
      deleted:  '❌ Аккаунт не найден. Обратитесь к администратору.',
    };
    await ctx.reply(msgs[user.status] || 'Нет доступа.');
    return null;
  }
  return user;
}

async function getEnabledSchedules() {
  return prisma.reportSchedule.findMany({
    where: { isEnabled: true, source: { isEnabled: true } },
    include: { source: { select: { id: true, name: true, type: true } } },
    orderBy: [{ source: { name: 'asc' } }, { periodType: 'asc' }],
  });
}

async function getUserSchedulePrefs(userId: string) {
  const prefs = await prisma.userSchedulePreference.findMany({ where: { userId } });
  return new Map(prefs.map(p => [p.scheduleId, p.enabled]));
}

// ── /reports — build inline keyboard showing current subscription state ────────
async function buildReportsKeyboard(userId: string) {
  const schedules = await getEnabledSchedules();
  if (schedules.length === 0) {
    return { text: 'Нет активных расписаний. Попросите администратора настроить их.', keyboard: null };
  }
  const prefs = await getUserSchedulePrefs(userId);
  const periodLabel = (p: string) => p === 'daily' ? 'день' : p === 'weekly' ? 'неделя' : 'месяц';

  const buttons = schedules.map(s => {
    const enabled = prefs.get(s.id) ?? true;
    return Markup.button.callback(
      `${enabled ? '✅' : '❌'} ${s.name} · ${s.source.name} (${periodLabel(s.periodType)})`,
      `sub:${s.id}`,
    );
  });

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));

  return {
    text: '📋 *Мои подписки на отчёты*\n\nНажмите кнопку чтобы включить или выключить подписку:',
    keyboard: Markup.inlineKeyboard(rows),
  };
}

// ── /generate — build source selection keyboard ────────────────────────────────
async function buildGenerateKeyboard() {
  const schedules = await getEnabledSchedules();
  if (schedules.length === 0) return null;
  const periodLabel = (p: string) => p === 'daily' ? 'день' : p === 'weekly' ? 'неделя' : 'месяц';

  const buttons = schedules.map(s =>
    Markup.button.callback(
      `${s.name} · ${s.source.name} (${periodLabel(s.periodType)})`,
      `gen:${s.id}`,
    ),
  );
  const rows = buttons.map(b => [b]);
  rows.push([Markup.button.callback('☀️ Summer Sales Outlook', 'gen:summer')]);
  return Markup.inlineKeyboard(rows);
}

async function runStoredAnalysis(scheduleId: string): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await prisma.reportSchedule.findUnique({
    where: { id: scheduleId },
    include: { source: true },
  });
  if (!schedule) throw new Error('Расписание не найдено');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: schedule.source.id } });
  if (!credRecord) throw new Error('Учётные данные не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: schedule.source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach(s => { settings[s.key] = s.value; });

  const timezone = await getSourceTimezone(schedule.source.id);
  const { periodStart, periodEnd } = computePeriod(schedule.periodType as any, timezone);
  const run = await prisma.reportRun.create({
    data: {
      scheduleId,
      periodStart,
      periodEnd,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date(),
    },
  });

  const connector = connectorRegistry.get(schedule.source.type);
  const promptVersion = await promptRegistry.getActivePrompt(schedule.source.id);
  if (!promptVersion) {
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_failure', completedAt: new Date(), errorSummary: 'Промпт не настроен для этого источника' },
    });
    throw new Error('Промпт не настроен для этого источника');
  }

  try {
    await prisma.reportJob.create({
      data: {
        runId: run.id,
        sourceId: schedule.source.id,
        jobType: 'fetch',
        status: 'running',
        startedAt: new Date(),
        attemptCount: 1,
      },
    });

    const fetchResult = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
    if (!fetchResult.success || !fetchResult.data) {
      throw new Error(fetchResult.error?.message || 'Ошибка получения данных');
    }

    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: fetchResult.data.metrics as any,
        formattedMessage: '',
      },
      update: {
        normalizedData: fetchResult.data.metrics as any,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });

    await prisma.reportJob.create({
      data: {
        runId: run.id,
        sourceId: schedule.source.id,
        jobType: 'analyze',
        status: 'running',
        startedAt: new Date(),
        attemptCount: 1,
      },
    });

    const rendered = await promptRegistry.renderPrompt(promptVersion, {
      normalized_metrics_json: JSON.stringify(fetchResult.data.metrics),
      report_period_start: periodStart.toISOString(),
      report_period_end: periodEnd.toISOString(),
      source_name: schedule.source.name,
      output_language: 'Russian',
      audience_type: 'business',
    });

    const analysis = await llmService.analyze({
      systemPrompt: rendered.system,
      userPrompt: rendered.user,
      sourceId: schedule.source.id,
      runId: run.id,
    });

    let formattedMessage = analysis.telegramMessage;
    if (schedule.source.type === 'gto' && schedule.periodType === 'daily') {
      formattedMessage = stripSummerSection(formattedMessage);
    }

    await prisma.reportResult.update({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      data: {
        promptVersionId: promptVersion.id,
        llmRequest: { system: rendered.system, user: rendered.user } as any,
        llmResponse: analysis.structuredOutput as any,
        structuredOutput: analysis.structuredOutput as any,
        formattedMessage,
        tokenUsage: analysis.tokenUsage as any,
        llmModel: analysis.model,
        llmCostUsd: analysis.costUsd,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'analyze' } },
      data: { status: 'success', completedAt: new Date() },
    });

    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return {
      runId: run.id,
      resultId: storedResult.id,
      message: formattedMessage,
    };
  } catch (err: any) {
    const errorSummary = err?.message || 'Manual generation failed';
    await prisma.reportJob.updateMany({
      where: { runId: run.id, status: 'running' },
      data: { status: 'failed', lastError: errorSummary, completedAt: new Date() },
    }).catch(() => {});
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_failure', completedAt: new Date(), errorSummary },
    }).catch(() => {});
    throw err;
  }
}

// ── /ask — build enabled sources keyboard ─────────────────────────────────────
async function buildAskKeyboard() {
  const sources = await prisma.dataSource.findMany({
    where: { isEnabled: true },
    orderBy: { name: 'asc' },
  });
  if (sources.length === 0) return null;

  const SOURCE_ICON: Record<string, string> = {
    gto: '🛒', ga4: '📊', redmine: '🐞', youtrack: '🎯', youtrack_progress: '🚦',
  };

  const buttons = sources.map(s =>
    Markup.button.callback(`${SOURCE_ICON[s.type] || '📁'} ${s.name}`, `ask:${s.id}`),
  );
  const rows = buttons.map(b => [b]);
  return Markup.inlineKeyboard(rows);
}

// ── Core: fetch connector data + run LLM analysis ────────────────────────────
async function runAnalysis(scheduleId: string): Promise<{ runId: string; resultId: string; message: string }> {
  return runStoredAnalysis(scheduleId);
}

async function runSummerSalesOutlook(): Promise<string> {
  const source = await prisma.dataSource.findFirst({
    where: { type: 'gto', isEnabled: true },
  });
  if (!source) throw new Error('Источник GTO не найден или отключён');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: source.id } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach(s => { settings[s.key] = s.value; });

  const timezone = await getSourceTimezone(source.id);
  const { periodStart, periodEnd } = computePeriod('daily' as any, timezone);
  const connector = connectorRegistry.get(source.type);
  const result = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
  if (!result.success || !result.data) throw new Error(result.error?.message || 'Ошибка получения данных');

  return formatSummerSalesOutlook(result.data.metrics);
}

// ── Core: fetch data + answer a free-form question via LLM ───────────────────
async function runFreeQuery(sourceId: string, question: string): Promise<string> {
  const source = await prisma.dataSource.findUnique({ where: { id: sourceId } });
  if (!source) throw new Error('Источник не найден');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId } });
  if (!credRecord) throw new Error('Учётные данные не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId } });
  const settings: Record<string, string> = {};
  settingRows.forEach(s => { settings[s.key] = s.value; });

  // Use last 7 days for /ask queries
  const periodEnd = new Date();
  periodEnd.setHours(0, 0, 0, 0);
  const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);

  const connector = connectorRegistry.get(source.type);
  const result = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
  if (!result.success || !result.data) throw new Error(result.error?.message || 'Ошибка получения данных');

  const dataStr = JSON.stringify(result.data.metrics, null, 2);
  const systemPrompt =
    'You are a data analytics assistant. Answer the question based on the provided data concisely and specifically. ' +
    'Respond in the same language as the question. Use markdown formatting where helpful.';
  const userPrompt =
    `Data from ${source.name} (last 7 days):\n\`\`\`json\n${dataStr.slice(0, 8000)}\n\`\`\`\n\nQuestion: ${question}`;

  return llmService.chat(systemPrompt, userPrompt);
}

// ── Register all handlers ─────────────────────────────────────────────────────
function registerHandlers(instance: Telegraf) {

  // /start
  instance.command('start', async (ctx) => {
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

        const sources = await prisma.dataSource.findMany();
        for (const source of sources) {
          await prisma.userReportPreference.upsert({
            where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
            create: { userId: user.id, sourceId: source.id, reportsEnabled: true },
            update: {},
          });
        }

        await writeAuditLog({ actorType: 'bot', action: 'user.registered', entityType: 'user', entityId: user.id });

        const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
        if (adminChatId) {
          await instance.telegram.sendMessage(
            adminChatId,
            `👤 *Новый запрос на подписку*\nИмя: ${from.first_name || ''} ${from.last_name || ''}\nUsername: @${from.username || 'нет'}\nTelegram ID: \`${from.id}\`\n\nПодтвердите в панели администратора.`,
            { parse_mode: 'Markdown' },
          ).catch(() => {});
        }
      }

      const messages: Record<string, string> = {
        pending:  `⏳ *Ожидание подтверждения*\n\nЗапрос отправлен. Вы получите уведомление после одобрения.\n\nДоступные команды: /help`,
        approved: `✅ *Добро пожаловать!*\n\nВы подписаны на аналитические отчёты.\n\n/reports — управление подписками\n/generate — сгенерировать отчёт сейчас\n/ask — задать вопрос по данным\n/help — все команды`,
        blocked:  `🚫 *Доступ ограничен*\n\nВаш аккаунт заблокирован. Обратитесь к администратору.`,
        deleted:  `Аккаунт не найден. Обратитесь к администратору.`,
      };

      await ctx.reply(messages[user.status] || messages.pending, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error({ err }, 'Error in /start handler');
      await ctx.reply('Произошла ошибка. Попробуйте позже.');
    }
  });

  // /status
  instance.command('status', async (ctx) => {
    const user = await getUser(ctx.from!.id);
    if (!user) return ctx.reply('Вы не зарегистрированы. Используйте /start.');
    const statusLabels: Record<string, string> = {
      pending: '⏳ Ожидает подтверждения',
      approved: '✅ Подтверждён',
      blocked: '🚫 Заблокирован',
      deleted: '❌ Удалён',
    };
    await ctx.reply(
      `*Статус аккаунта*\n\nСтатус: ${statusLabels[user.status] || user.status}\nОтчёты: ${user.globalReportsEnabled ? '✅ Включены' : '❌ Выключены'}`,
      { parse_mode: 'Markdown' },
    );
  });

  // /help
  instance.command('help', async (ctx) => {
    await ctx.reply(
      `*Analytics Report Bot*\n\n` +
      `📋 /reports — управление подписками на отчёты\n` +
      `⚡️ /generate — сгенерировать отчёт прямо сейчас\n` +
      `💬 /ask — задать вопрос по данным (ИИ ответит)\n` +
      `👤 /status — статус вашего аккаунта\n` +
      `/start — регистрация\n\n` +
      `Автоматические отчёты приходят по расписанию.`,
      { parse_mode: 'Markdown' },
    );
  });

  // /reports — show subscription management keyboard
  instance.command('reports', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return;
    const { text, keyboard } = await buildReportsKeyboard(user.id);
    if (!keyboard) return ctx.reply(text);
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  // Callback: toggle schedule subscription
  instance.action(/^sub:(.+)$/, async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    const scheduleId = ctx.match[1];

    const prefs = await getUserSchedulePrefs(user.id);
    const current = prefs.get(scheduleId) ?? true;
    await prisma.userSchedulePreference.upsert({
      where: { userId_scheduleId: { userId: user.id, scheduleId } },
      create: { userId: user.id, scheduleId, enabled: !current },
      update: { enabled: !current },
    });

    // Refresh the keyboard in place
    const { text, keyboard } = await buildReportsKeyboard(user.id);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
    await ctx.answerCbQuery(!current ? '✅ Подписка включена' : '❌ Подписка отключена');
  });

  // Callback: open separate summer sales outlook from /generate submenu
  instance.action('gen:summer', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Summer Sales Outlook*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const message = await runSummerSalesOutlook();
      await replySafe(ctx, message, { disable_web_page_preview: true });
    } catch (err: any) {
      logger.error({ err }, 'Summer sales outlook failed');
      await ctx.reply(`❌ Ошибка генерации летнего отчёта: ${err.message}`);
    }
  });

  // /generate — show schedule selection keyboard
  instance.command('generate', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return;
    const keyboard = await buildGenerateKeyboard();
    if (!keyboard) return ctx.reply('Нет активных расписаний для генерации.');
    await ctx.reply('⚡️ *Выберите отчёт для генерации:*', { parse_mode: 'Markdown', ...keyboard });
  });

  // Callback: generate selected report
  instance.action(/^gen:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    const scheduleId = ctx.match[1];
    if (scheduleId === 'summer') return;

    const schedule = await prisma.reportSchedule.findUnique({
      where: { id: scheduleId },
      include: { source: { select: { name: true } } },
    });
    if (!schedule) return ctx.reply('Расписание не найдено.');

    // Confirm and start
    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runAnalysis(scheduleId);
      const sent = await replySafe(ctx, result.message, { disable_web_page_preview: true });
      await prisma.sentMessage.create({
        data: {
          resultId: result.resultId,
          userId: user.id,
          status: 'sent',
          telegramMessageId: sent?.message_id ? BigInt(sent.message_id) : undefined,
          sentAt: new Date(),
        },
      }).catch(() => {});
    } catch (err: any) {
      logger.error({ err, scheduleId }, 'On-demand analysis failed');
      await ctx.reply(`❌ Ошибка генерации: ${err.message}`);
    }
  });

  // /ask — show data source selection keyboard
  instance.command('ask', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return;
    const keyboard = await buildAskKeyboard();
    if (!keyboard) return ctx.reply('Нет активных источников данных.');
    await ctx.reply('💬 *Выберите источник данных:*', { parse_mode: 'Markdown', ...keyboard });
  });

  // Callback: selected source for /ask
  instance.action(/^ask:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    const sourceId = ctx.match[1];

    const source = await prisma.dataSource.findUnique({ where: { id: sourceId } });
    if (!source) return ctx.reply('Источник не найден.');

    sessions.set(ctx.from!.id, { step: 'waiting_question', sourceId, sourceName: source.name });

    await ctx.editMessageText(
      `💬 *${source.name}* выбран.\n\nОтправьте ваш вопрос — ИИ ответит на основе данных за последние 7 дней.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});
  });

  // Text messages — handle /ask question input
  instance.on('text', async (ctx) => {
    const text = (ctx.message as any).text as string;
    if (text.startsWith('/')) return; // ignore commands

    const session = sessions.get(ctx.from!.id);
    if (!session) return; // no active session

    sessions.delete(ctx.from!.id);

    const user = await requireApproved(ctx);
    if (!user) return;

    const waitMsg = await ctx.reply(`🔍 Ищу ответ в данных *${session.sourceName}*...`, { parse_mode: 'Markdown' });

    try {
      const answer = await runFreeQuery(session.sourceId, text);
      await replySafe(ctx, answer, { disable_web_page_preview: true });
    } catch (err: any) {
      logger.error({ err, sourceId: session.sourceId }, 'Free query failed');
      await ctx.reply(`❌ Ошибка: ${err.message}`);
    } finally {
      await ctx.telegram.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => {});
    }
  });

  instance.catch((err) => {
    logger.error({ err }, 'Telegram bot error');
  });
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────────
export async function startBot(token?: string) {
  const resolvedToken = token
    || (await prisma.systemSetting.findUnique({ where: { key: 'telegram.bot_token' } }))?.value
    || process.env.TELEGRAM_BOT_TOKEN
    || '';

  if (!resolvedToken || resolvedToken === 'placeholder:token') {
    throw new Error('No valid Telegram bot token configured');
  }

  if (_botRunning) {
    try { _bot.stop('RELOAD'); } catch (_) {}
    _botRunning = false;
    await new Promise(r => setTimeout(r, 500));
  }

  _bot = new Telegraf(resolvedToken);
  registerHandlers(_bot);

  // Register bot command menu shown in Telegram UI
  await _bot.telegram.setMyCommands([
    { command: 'reports',  description: 'Управление подписками на отчёты' },
    { command: 'generate', description: 'Сгенерировать отчёт прямо сейчас' },
    { command: 'ask',      description: 'Задать вопрос по данным (ИИ ответит)' },
    { command: 'status',   description: 'Статус аккаунта' },
    { command: 'help',     description: 'Помощь' },
    { command: 'start',    description: 'Регистрация' },
  ]).catch(err => logger.warn({ err }, 'Failed to set bot commands'));

  if (process.env.TELEGRAM_WEBHOOK_URL) {
    logger.info({ url: process.env.TELEGRAM_WEBHOOK_URL }, 'Bot using webhook mode');
  } else {
    logger.info('Bot using polling mode');
    await _bot.launch();
  }

  _botRunning = true;
  logger.info('Telegram bot started successfully');
}

export function getBotStatus(): { running: boolean; hasToken: boolean } {
  return {
    running: _botRunning,
    hasToken: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'placeholder:token'),
  };
}
