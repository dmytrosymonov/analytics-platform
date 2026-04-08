import { Telegraf, Markup } from 'telegraf';
import { Prisma, PeriodType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { writeAuditLog } from '../lib/audit';
import { logger } from '../lib/logger';
import { decrypt } from '../lib/encryption';
import { connectorRegistry } from '../connectors/registry';
import { llmService } from '../llm/llm.service';
import { promptRegistry } from '../llm/prompt-registry.service';
import { computeCurrentDayPeriod, computePeriod, computeRollingHoursPeriod, getSourceTimezone, zonedDateTimeToUtc } from '../scheduler/scheduler.service';
import { formatYouTrackProgressTelegramMessage } from '../lib/youtrack-progress-format';
import { CurrencyService } from '../lib/currency.service';
import { createHttpClient } from '../lib/http';
import { buildGtoCommentsPrompts } from '../lib/gto-comments-prompt';
import { GTO_NETWORK_DEFINITIONS, GtoNetworkKey } from '../connectors/gto/gto.connector';
import {
  listManualReportAccessDefinitions,
  makeScheduleHoursReportKey,
  makeScheduleRunReportKey,
} from '../lib/report-access';

// ── Mutable bot instance (replaced on reload) ────────────────────────────────
let _bot: Telegraf = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || 'placeholder:token');
let _botRunning = false;

const DEFAULT_GTO_BASE_URL = 'https://api.gto.ua/api/private';
const DEFAULT_GTO_V3_BASE_URL = 'https://api.gto.ua/api/v3';

// Proxy so other modules always get the current instance
export const bot = new Proxy({} as Telegraf, {
  get(_target, prop) {
    return (_bot as any)[prop];
  },
});

// ── Session state for multi-step /ask flow (in-memory, ok for internal tool) ─
type PeriodSelectionTarget =
  | { kind: 'sales'; accessKeys: string[] }
  | { kind: 'payments'; accessKeys: string[] }
  | { kind: 'agents'; accessKeys: string[] }
  | { kind: 'network_sales'; accessKeys: string[]; networkKey: 'general' | GtoNetworkKey; networkLabel: string }
  | { kind: 'schedule'; scheduleId: string; scheduleName: string; accessKey: string };

type BotSession =
  | {
      step: 'waiting_question';
      sourceId: string;
      sourceName: string;
    }
  | {
      step: 'waiting_custom_period';
      timezone: string;
      reportLabel: string;
      target: PeriodSelectionTarget;
      displayedYear: number;
      displayedMonth: number;
      startYmd: string | null;
      endYmd: string | null;
      maxYmd: string;
    };

const sessions = new Map<number, BotSession>();
type ScheduleWithSource = Prisma.ReportScheduleGetPayload<{ include: { source: true } }>;
type ScheduleWithSourceSummary = Prisma.ReportScheduleGetPayload<{ include: { source: { select: { id: true; name: true; type: true } } } }>;
type ManualReportAccessState = ReturnType<typeof listManualReportAccessDefinitions>[number] & { enabled: boolean };
type AdminManageableUser = Prisma.UserGetPayload<{}>;
type AdminUserFilter = 'pending' | 'approved' | 'blocked' | 'deleted' | 'all';
type ManualRunInitiator = { telegramUserId?: string };
const prismaManualReportAccess = (prisma as any).userManualReportAccess as {
  findMany: (args: unknown) => Promise<Array<{ reportKey: string; enabled: boolean }>>;
  findUnique: (args: unknown) => Promise<{ reportKey: string; enabled: boolean } | null>;
};
const ADMIN_USER_PAGE_SIZE = 8;
const MAX_CUSTOM_PERIOD_DAYS = 31;
const GTO_NETWORK_ACCESS_KEY = 'sales.networks';
const GTO_NETWORK_MENU_ITEMS: Array<{ key: 'general' | GtoNetworkKey; label: string }> = [
  { key: 'general', label: 'General' },
  ...GTO_NETWORK_DEFINITIONS.map((definition) => ({ key: definition.key, label: definition.label })),
];

function stripSummerSection(text: string): string {
  return text.replace(/\n{2,}☀️ Лето:[\s\S]*$/u, '').trim();
}

function annotateCnfFinancials(text: string): string {
  return text
    .replace(/^💶\s*Выручка:/gmu, '💶 Выручка по CNF:')
    .replace(/^Прибыль:/gmu, 'Прибыль по CNF:')
    .replace(/^💼\s*Средний чек:/gmu, '💼 Средний чек по CNF:')
    .replace(/^💼 Средний чек по CNF:.*$/gmu, (line) => `${line}\nВсе денежные показатели приведены к EUR.`);
}

function toColumnList(text: string, header: string): string {
  const pattern = new RegExp(`^${header}:\\s*(.+)$`, 'gmu');
  return text.replace(pattern, (_match, items: string) => {
    const lines = items.split(/\s*,\s*/).filter(Boolean);
    return `---${header}---\n${lines.join('\n')}`;
  });
}

function removeOtherAnomalies(text: string): string {
  return text.replace(/\n⚠️ Прочие аномалии:[\s\S]*?(?=\n(?:📊 За последние 7 дней|🔮 Старт Ближ\. 7 дней|Старт ближ\. 30 дней|☀️ )|$)/gu, '');
}

function sortDestinationLines(lines: string[]): string[] {
  return [...lines].sort((a, b) => {
    const aTourists = Number(a.match(/-\s*(\d+)\s+турист/u)?.[1] || 0);
    const bTourists = Number(b.match(/-\s*(\d+)\s+турист/u)?.[1] || 0);
    return bTourists - aTourists;
  });
}

function sortUpcomingBlocks(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    if (lines[i].trim() === 'Самые популярные направления:' || /^Старт ближ\. 30 дней:/u.test(lines[i].trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next.trim()) break;
        if (/^(📊|🔮|☀️|💶|📦|👥|💎|Самые популярные направления:)/u.test(next.trim())) break;
        block.push(next);
        i++;
      }
      if (block.length > 0) result.push(...sortDestinationLines(block));
    }
  }
  return result.join('\n');
}

function formatGtoReportText(text: string): string {
  let formatted = text;
  formatted = annotateCnfFinancials(formatted);
  formatted = toColumnList(formatted, '🌍 Направления');
  formatted = toColumnList(formatted, '📦 Продукты');
  formatted = formatted.replace(/(---🌍 Направления---[\s\S]*?)(\n---📦 Продукты---)/gu, '$1\n$2');
  formatted = removeOtherAnomalies(formatted);
  formatted = sortUpcomingBlocks(formatted);
  formatted = formatted.replace(/(🔴 Отрицательная маржа[\s\S]*?)(\n🔮 Старт Ближ\. 7 дней:)/gu, '$1\n$2');
  formatted = formatted.replace(
    /^🔮 Старт Ближ\. 7 дней:\s*(\d+)\s+заказ\w*,\s*(\d+)\s+турист\w*,\s*GMV:\s*([^,]+),\s*Gross profit:\s*(.+)$/gmu,
    '🔮 Старт Ближ. 7 дней: \n$1 заказов, \n$2 туристов, \nGMV: $3, \nGross profit: $4',
  );
  formatted = formatted.replace(
    /^Старт ближ\. 30 дней:\s*(\d+)\s+заказ\w*,\s*(\d+)\s+турист\w*,\s*GMV:\s*([^,]+),\s*Gross profit:\s*(.+)$/gmu,
    'Старт ближ. 30 дней: \n$1 заказов, \n$2 туристов, \nGMV: $3, \nGross profit: $4',
  );
  formatted = formatted.replace(/(Самые популярные направления:[\s\S]*?)(\nСтарт ближ\. 30 дней:)/gu, '$1\n$2');
  return formatted.trim();
}

function formatTourStartMonthLines(months: any[] = []): string[] {
  return months.slice(0, 6).map((m) =>
    `${m.month} - ${formatInt(m.tourists)} туристов, GMV ${formatInt(m.revenue_eur)} EUR, profit ${formatInt(m.profit_eur)} EUR`,
  );
}

function injectProductBlocks(text: string, sections: any[] = []): string {
  let occurrence = 0;
  return text.replace(
    /---📦 Продукты---[\s\S]*?(?=\n\n(?:---🗓 Старт туров---|👥|💎|Самые популярные поставщики|🔴|📊 За последние 7 дней|🔮|$))/gu,
    () => {
      const section = sections[occurrence++];
      const lines = formatProductLines(section?.product_breakdown || {});
      if (lines.length === 0) return '---📦 Продукты---';
      return `---📦 Продукты---\n${lines.join('\n')}`;
    },
  );
}

function injectTourStartMonthsBlock(text: string, months: any[] = []): string {
  const lines = formatTourStartMonthLines(months);
  if (lines.length === 0) return text;
  const block = `---🗓 Старт туров---\n${lines.join('\n')}\n`;
  if (text.includes('---📦 Продукты---')) {
    return text.replace(/(---📦 Продукты---[\s\S]*?)(\n\n👥|\n👥|\n\n💎|\n💎)/u, `$1\n\n${block}$2`);
  }
  return `${text}\n\n${block}`.trim();
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
}

function formatPeriodLabel(from?: string, to?: string): string {
  if (!from || !to) return '—';
  const formatOne = (value: string) => value.split('-').reverse().join('/');
  return from === to ? formatOne(from) : `${formatOne(from)} - ${formatOne(to)}`;
}

function compareYmd(a: string, b: string): number {
  return a.localeCompare(b);
}

function shiftYmd(year: number, month: number, day: number, offsetDays: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parseYmd(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function formatYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getTodayYmd(timezone: string): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
}

function shiftCalendarMonth(year: number, month: number, offset: number) {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeCalendarPeriod(
  timezone: string,
  startYmd: string,
  endYmd?: string | null,
): { periodStart: Date; periodEnd: Date; from: string; to: string } {
  const from = startYmd;
  const to = endYmd || startYmd;
  const start = parseYmd(from);
  const end = parseYmd(to);
  const nextDay = shiftYmd(end.year, end.month, end.day, 1);
  return {
    periodStart: zonedDateTimeToUtc(timezone, start.year, start.month, start.day),
    periodEnd: zonedDateTimeToUtc(timezone, nextDay.year, nextDay.month, nextDay.day),
    from,
    to,
  };
}

const CALENDAR_MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const CALENDAR_WEEKDAYS_RU = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function buildCalendarPrompt(session: Extract<BotSession, { step: 'waiting_custom_period' }>): string {
  const selectedFrom = session.startYmd ? formatPeriodLabel(session.startYmd, session.startYmd) : '—';
  const selectedTo = session.endYmd ? formatPeriodLabel(session.endYmd, session.endYmd) : '—';
  const effectiveTo = session.endYmd || session.startYmd;
  const rangeLabel = session.startYmd ? formatPeriodLabel(session.startYmd, effectiveTo || session.startYmd) : '—';
  const helper = !session.startYmd
    ? 'Выберите дату начала.'
    : !session.endYmd
      ? 'Теперь выберите дату окончания или нажмите Apply для одного дня.'
      : 'Период выбран. Нажмите Apply, чтобы сгенерировать отчёт.';

  return (
    `📅 *${session.reportLabel}*\n\n` +
    `${helper}\n\n` +
    `Начало: ${selectedFrom}\n` +
    `Конец: ${selectedTo}\n` +
    `Период: ${rangeLabel}\n\n` +
    `Максимальная длина периода: ${MAX_CUSTOM_PERIOD_DAYS} день(дней).`
  );
}

function buildCalendarKeyboard(session: Extract<BotSession, { step: 'waiting_custom_period' }>) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  const monthTitle = `${CALENDAR_MONTHS_RU[session.displayedMonth - 1]} ${session.displayedYear}`;
  rows.push([
    Markup.button.callback('‹', 'cal:prev'),
    Markup.button.callback(monthTitle, 'cal:noop'),
    Markup.button.callback('›', 'cal:next'),
  ]);
  rows.push(CALENDAR_WEEKDAYS_RU.map((label) => Markup.button.callback(label, 'cal:noop')));

  const firstDayWeekday = (new Date(Date.UTC(session.displayedYear, session.displayedMonth - 1, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = getDaysInMonth(session.displayedYear, session.displayedMonth);
  const cells: Array<{ text: string; callback: string }> = [];

  for (let i = 0; i < firstDayWeekday; i++) {
    cells.push({ text: ' ', callback: 'cal:noop' });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const ymd = formatYmd(session.displayedYear, session.displayedMonth, day);
    const disabled = compareYmd(ymd, session.maxYmd) > 0;
    const inRange = session.startYmd && (session.endYmd || session.startYmd)
      ? compareYmd(ymd, session.startYmd) >= 0 && compareYmd(ymd, session.endYmd || session.startYmd) <= 0
      : false;

    let text = String(day);
    if (session.startYmd === ymd && (session.endYmd || session.startYmd) === ymd) text = `🟢${day}`;
    else if (session.startYmd === ymd) text = `🟢${day}`;
    else if (session.endYmd === ymd) text = `🔵${day}`;
    else if (inRange) text = `·${day}`;
    if (disabled) text = `·${day}`;

    cells.push({ text, callback: disabled ? 'cal:noop' : `cal:pick:${ymd}` });
  }

  while (cells.length % 7 !== 0) {
    cells.push({ text: ' ', callback: 'cal:noop' });
  }

  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7).map((cell) => Markup.button.callback(cell.text, cell.callback)));
  }

  const actionRow: ReturnType<typeof Markup.button.callback>[] = [
    Markup.button.callback('Reset', 'cal:reset'),
  ];
  if (session.startYmd) {
    actionRow.push(Markup.button.callback('Apply', 'cal:apply'));
  }
  rows.push(actionRow);
  rows.push([Markup.button.callback('Cancel', 'cal:cancel')]);

  return Markup.inlineKeyboard(rows);
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

function isTelegramTooLongError(err: any): boolean {
  return /message is too long/i.test(err?.message || '');
}

export function splitTelegramMessage(text: string, maxLen = 3500): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLen) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;

  while (rest.length > maxLen) {
    let splitAt = rest.lastIndexOf('\n\n', maxLen);
    if (splitAt < Math.floor(maxLen * 0.5)) splitAt = rest.lastIndexOf('\n', maxLen);
    if (splitAt < Math.floor(maxLen * 0.5)) splitAt = rest.lastIndexOf(' ', maxLen);
    if (splitAt < Math.floor(maxLen * 0.5)) splitAt = maxLen;

    const chunk = rest.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(splitAt).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

async function sendTelegramChunk(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  try {
    return await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...extra,
    } as any);
  } catch (err: any) {
    if (isTelegramTooLongError(err)) throw err;
    if (!isTelegramParseError(err)) throw err;
    logger.warn({ chatId, err: err.message }, 'Telegram markdown send failed, retrying without parse mode');
    return bot.telegram.sendMessage(chatId, text, {
      disable_web_page_preview: true,
      ...extra,
    } as any);
  }
}

export async function sendTelegramMessageSafe(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  const chunks = splitTelegramMessage(text);
  let lastMessage: any;

  for (const chunk of chunks) {
    lastMessage = await sendTelegramChunk(chatId, chunk, extra);
  }

  return lastMessage;
}

async function replyChunkSafe(ctx: any, text: string, extra: Record<string, unknown> = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra } as any);
  } catch (err: any) {
    if (isTelegramTooLongError(err)) throw err;
    if (!isTelegramParseError(err)) throw err;
    logger.warn({ err: err.message }, 'Telegram markdown reply failed, retrying without parse mode');
    return ctx.reply(text, extra as any);
  }
}

async function replySafe(ctx: any, text: string, extra: Record<string, unknown> = {}) {
  const chunks = splitTelegramMessage(text);
  let lastMessage: any;

  for (const chunk of chunks) {
    lastMessage = await replyChunkSafe(ctx, chunk, extra);
  }

  return lastMessage;
}

async function editOrReply(ctx: any, text: string, extra: Record<string, unknown> = {}) {
  try {
    return await ctx.editMessageText(text, extra as any);
  } catch (err: any) {
    logger.warn({ err: err?.message, callbackQueryId: ctx.callbackQuery?.id }, 'Telegram edit failed, falling back to reply');
    return replySafe(ctx, text, extra);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getUser(telegramId: number) {
  return prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
}

async function getTelegramAdminChatId(): Promise<string | null> {
  return (
    (await prisma.systemSetting.findUnique({ where: { key: 'telegram.admin_chat_id' } }))?.value
    || process.env.TELEGRAM_ADMIN_CHAT_ID
    || null
  );
}

async function isTelegramAdmin(telegramId: number): Promise<boolean> {
  const adminChatId = await getTelegramAdminChatId();
  return !!adminChatId && adminChatId === String(telegramId);
}

function formatUserStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '⏳ Ожидает подтверждения',
    approved: '✅ Подтверждён',
    blocked: '🚫 Заблокирован',
    deleted: '❌ Удалён',
  };
  return labels[status] || status;
}

function formatUserStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    pending: '⏳',
    approved: '✅',
    blocked: '🚫',
    deleted: '❌',
  };
  return icons[status] || '👤';
}

function formatUserDisplayName(user: Pick<AdminManageableUser, 'firstName' | 'lastName' | 'username' | 'telegramId'>): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return `ID ${String(user.telegramId)}`;
}

function formatUserShortLabel(user: AdminManageableUser): string {
  const base = `${formatUserStatusIcon(user.status)} ${formatUserDisplayName(user)}`;
  return base.length > 48 ? `${base.slice(0, 45)}...` : base;
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Kyiv',
  }).format(value);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function createManualReportRun(
  data: { scheduleId?: string; periodStart: Date; periodEnd: Date; status?: 'pending' | 'running' | 'full_success' | 'partial_success' | 'full_failure'; startedAt?: Date },
  initiator?: ManualRunInitiator,
) {
  return prisma.reportRun.create({
    data: {
      scheduleId: data.scheduleId,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      status: data.status || 'running',
      triggerType: 'manual',
      startedAt: data.startedAt || new Date(),
      triggeredByTelegramUserId: initiator?.telegramUserId,
    },
  });
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
  if (!user.globalReportsEnabled) {
    await ctx.reply('Доступ к отчётам для вашего аккаунта отключён администратором.');
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

async function getSubscribableSchedules(userId: string): Promise<ScheduleWithSourceSummary[]> {
  const [sourceAccess, schedules] = await Promise.all([
    getUserSourceAccess(userId),
    getEnabledSchedules(),
  ]);
  const enabledSourceIds = new Set(sourceAccess.filter((source) => source.enabled).map((source) => source.id));
  return schedules.filter((schedule) => enabledSourceIds.has(schedule.source.id));
}

async function getUserSourceAccess(userId: string) {
  const [sources, prefs] = await Promise.all([
    prisma.dataSource.findMany({
      where: { isEnabled: true },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    }),
    prisma.userReportPreference.findMany({
      where: { userId },
      include: { source: { select: { id: true, type: true } } },
    }),
  ]);

  const enabledBySourceId = new Map(prefs.map((pref) => [pref.sourceId, pref.reportsEnabled]));
  return sources.map((source) => ({
    ...source,
    enabled: enabledBySourceId.get(source.id) ?? true,
  }));
}

async function getUserManualReportAccess(userId: string): Promise<ManualReportAccessState[]> {
  const schedules = await prisma.reportSchedule.findMany({
    include: { source: { select: { type: true, name: true } } },
    orderBy: [{ source: { name: 'asc' } }, { periodType: 'asc' }, { name: 'asc' }],
  });
  const definitions = listManualReportAccessDefinitions(schedules);
  const rows = await prismaManualReportAccess.findMany({ where: { userId } });
  const enabledByKey = new Map(rows.map((row) => [row.reportKey, row.enabled]));
  return definitions.map((definition) => ({
    ...definition,
    enabled: enabledByKey.get(definition.key) ?? true,
  }));
}

async function hasSourceAccess(userId: string, sourceTypes: string[]): Promise<boolean> {
  const access = await getUserSourceAccess(userId);
  return access.some((source) => sourceTypes.includes(String(source.type)) && source.enabled);
}

async function hasManualReportAccess(userId: string, reportKey: string): Promise<boolean> {
  const pref = await prismaManualReportAccess.findUnique({
    where: { userId_reportKey: { userId, reportKey } },
  });
  return pref?.enabled ?? true;
}

async function hasAnyManualReportAccess(userId: string, reportKeys: string[]): Promise<boolean> {
  for (const reportKey of reportKeys) {
    if (await hasManualReportAccess(userId, reportKey)) return true;
  }
  return false;
}

async function getManualSchedulesBySourceTypes(sourceTypes: string[]): Promise<ScheduleWithSourceSummary[]> {
  return prisma.reportSchedule.findMany({
    where: {
      source: { is: { type: { in: sourceTypes as any }, isEnabled: true } },
    },
    include: { source: { select: { id: true, name: true, type: true } } },
    orderBy: [{ source: { name: 'asc' } }, { periodType: 'asc' }, { name: 'asc' }],
  });
}

async function ensureSourceAccess(ctx: any, userId: string, sourceTypes: string[]): Promise<boolean> {
  const allowed = await hasSourceAccess(userId, sourceTypes);
  if (!allowed) {
    await ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    return false;
  }
  return true;
}

async function ensureManualReportAccess(ctx: any, userId: string, sourceTypes: string[], reportKey: string): Promise<boolean> {
  const [sourceAllowed, reportAllowed] = await Promise.all([
    hasSourceAccess(userId, sourceTypes),
    hasManualReportAccess(userId, reportKey),
  ]);
  if (!sourceAllowed || !reportAllowed) {
    await ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    return false;
  }
  return true;
}

async function ensureScheduleSourceAccess(ctx: any, userId: string, scheduleId: string): Promise<boolean> {
  const schedule = await prisma.reportSchedule.findUnique({
    where: { id: scheduleId },
    include: { source: { select: { type: true } } },
  });
  if (!schedule) {
    await ctx.reply('Расписание не найдено.');
    return false;
  }
  const allowed = await hasSourceAccess(userId, [String(schedule.source.type)]);
  if (!allowed) {
    await ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    return false;
  }
  return true;
}

async function getScheduleBySourceTypeAndPeriod(sourceType: string, periodType: PeriodType): Promise<ScheduleWithSource | null> {
  return prisma.reportSchedule.findFirst({
    where: {
      isEnabled: true,
      periodType,
      source: { is: { type: sourceType as any, isEnabled: true } },
    },
    include: { source: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function getSchedulesBySourceTypes(sourceTypes: string[]): Promise<ScheduleWithSourceSummary[]> {
  return prisma.reportSchedule.findMany({
    where: {
      isEnabled: true,
      source: { is: { type: { in: sourceTypes as any }, isEnabled: true } },
    },
    include: { source: { select: { id: true, name: true, type: true } } },
    orderBy: [{ source: { name: 'asc' } }, { periodType: 'asc' }, { name: 'asc' }],
  });
}

async function buildSubscriptionsKeyboard(userId: string) {
  const [schedules, prefs] = await Promise.all([
    getSubscribableSchedules(userId),
    getUserSchedulePrefs(userId),
  ]);
  if (schedules.length === 0) {
    return { text: 'Нет доступных расписаний. Сначала администратор должен открыть вам доступ к источнику отчётов.', keyboard: null };
  }
  const periodLabel = (p: string) => p === 'daily' ? 'день' : p === 'weekly' ? 'неделя' : 'месяц';
  const buttons = schedules.map((schedule) => {
    const enabled = prefs.get(schedule.id) ?? false;
    return Markup.button.callback(
      `${enabled ? '✅' : '➕'} ${schedule.name} · ${schedule.source.name} (${periodLabel(schedule.periodType)})`,
      `sub:${schedule.id}`,
    );
  });

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return {
    text: '🔔 *Регулярные отчёты*\n\nВыберите отчёты, на которые хотите подписаться. Повторное нажатие отключит подписку.',
    keyboard: Markup.inlineKeyboard(rows),
  };
}

async function buildSettingsHome(userId?: string | null) {
  const pendingCount = await prisma.user.count({ where: { status: 'pending' } });
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback(`🆕 Заявки${pendingCount ? ` (${pendingCount})` : ''}`, 'admin:users:pending:0')],
    [Markup.button.callback('👥 Все пользователи', 'admin:users:all:0')],
  ];

  if (userId) {
    rows.push([Markup.button.callback('🔔 Мои подписки', 'settings:subscriptions')]);
  }

  return {
    text:
      '⚙️ *Настройки администратора*\n\n' +
      'Здесь можно просматривать заявки и управлять пользователями прямо из Telegram.',
    keyboard: Markup.inlineKeyboard(rows),
  };
}

async function buildAdminUsersKeyboard(filter: AdminUserFilter, page: number) {
  const normalizedPage = Math.max(0, page);
  const where = filter === 'all' ? {} : { status: filter as any };
  const [users, total, pendingCount, approvedCount, blockedCount, deletedCount] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: normalizedPage * ADMIN_USER_PAGE_SIZE,
      take: ADMIN_USER_PAGE_SIZE,
    }),
    prisma.user.count({ where }),
    prisma.user.count({ where: { status: 'pending' } }),
    prisma.user.count({ where: { status: 'approved' } }),
    prisma.user.count({ where: { status: 'blocked' } }),
    prisma.user.count({ where: { status: 'deleted' } }),
  ]);

  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [
      Markup.button.callback(`🆕 Pending (${pendingCount})`, 'admin:users:pending:0'),
      Markup.button.callback(`👥 All (${pendingCount + approvedCount + blockedCount + deletedCount})`, 'admin:users:all:0'),
    ],
  ];

  if (users.length > 0) {
    for (const user of users) {
      rows.push([
        Markup.button.callback(
          formatUserShortLabel(user),
          `admin:user:${user.id}:${filter}:${normalizedPage}`,
        ),
      ]);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / ADMIN_USER_PAGE_SIZE));
  if (totalPages > 1) {
    const paginationRow: ReturnType<typeof Markup.button.callback>[] = [];
    if (normalizedPage > 0) {
      paginationRow.push(Markup.button.callback('← Prev', `admin:users:${filter}:${normalizedPage - 1}`));
    }
    if (normalizedPage + 1 < totalPages) {
      paginationRow.push(Markup.button.callback('Next →', `admin:users:${filter}:${normalizedPage + 1}`));
    }
    if (paginationRow.length > 0) rows.push(paginationRow);
  }

  rows.push([Markup.button.callback('← В настройки', 'settings:home')]);

  const filterTitle = filter === 'all' ? 'Все пользователи' : `Пользователи: ${formatUserStatusLabel(filter)}`;
  const listText =
    users.length === 0
      ? 'Список пуст.'
      : users.map((user) => `${formatUserStatusIcon(user.status)} ${escapeMarkdown(formatUserDisplayName(user))}`).join('\n');

  return {
    text:
      `👥 *${filterTitle}*\n\n` +
      `Показано: ${users.length} из ${total}. Страница ${normalizedPage + 1}/${totalPages}.\n\n` +
      listText,
    keyboard: Markup.inlineKeyboard(rows),
  };
}

async function buildAdminUserDetailsKeyboard(user: AdminManageableUser, filter: AdminUserFilter, page: number) {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];

  if (user.status === 'pending') {
    rows.push([
      Markup.button.callback('✅ Одобрить', `admin:user_status:${user.id}:approved:${filter}:${page}`),
      Markup.button.callback('🗑 Удалить', `admin:user_status:${user.id}:deleted:${filter}:${page}`),
    ]);
  } else if (user.status === 'approved') {
    rows.push([
      Markup.button.callback('🚫 Заблокировать', `admin:user_status:${user.id}:blocked:${filter}:${page}`),
      Markup.button.callback('🗑 Удалить', `admin:user_status:${user.id}:deleted:${filter}:${page}`),
    ]);
  } else if (user.status === 'blocked') {
    rows.push([
      Markup.button.callback('✅ Разблокировать', `admin:user_status:${user.id}:approved:${filter}:${page}`),
      Markup.button.callback('🗑 Удалить', `admin:user_status:${user.id}:deleted:${filter}:${page}`),
    ]);
  }

  if (user.status !== 'deleted') {
    rows.push([
      Markup.button.callback(
        user.globalReportsEnabled ? '🔕 Выключить отчёты' : '🔔 Включить отчёты',
        `admin:user_reports:${user.id}:${user.globalReportsEnabled ? 'off' : 'on'}:${filter}:${page}`,
      ),
    ]);
  }

  rows.push([Markup.button.callback('← К списку', `admin:users:${filter}:${page}`)]);

  const usernameLine = user.username ? `@${user.username}` : '—';
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || '—';

  return {
    text:
      `👤 *${escapeMarkdown(formatUserDisplayName(user))}*\n\n` +
      `Статус: ${formatUserStatusLabel(user.status)}\n` +
      `Username: ${escapeMarkdown(usernameLine)}\n` +
      `Имя: ${escapeMarkdown(fullName)}\n` +
      `Telegram ID: \`${String(user.telegramId)}\`\n` +
      `Регулярные отчёты: ${user.globalReportsEnabled ? '✅ Включены' : '❌ Выключены'}\n` +
      `Создан: ${formatDateTime(user.createdAt)}`,
    keyboard: Markup.inlineKeyboard(rows),
  };
}

async function renderAdminUserDetails(ctx: any, userId: string, filter: AdminUserFilter, page: number) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    await ctx.editMessageText('Пользователь не найден.', { ...Markup.inlineKeyboard([[Markup.button.callback('← К списку', `admin:users:${filter}:${page}`)]]) } as any).catch(() => {});
    return;
  }

  const { text, keyboard } = await buildAdminUserDetailsKeyboard(user, filter, page);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
}

async function buildTopReportsMenu(userId: string) {
  const [hasGto, hasComments, hasRedmine, hasYoutrack, manualReports, commentsSchedules, redmineSchedules, youtrackSchedules] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    hasSourceAccess(userId, ['gto_comments']),
    hasSourceAccess(userId, ['redmine']),
    hasSourceAccess(userId, ['youtrack', 'youtrack_progress']),
    getUserManualReportAccess(userId),
    getManualSchedulesBySourceTypes(['gto_comments']),
    getManualSchedulesBySourceTypes(['redmine']),
    getManualSchedulesBySourceTypes(['youtrack', 'youtrack_progress']),
  ]);

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if ((hasGto || hasComments) && (
    manualReports.some((report) => report.sourceType === 'gto' && report.enabled)
    || commentsSchedules.length > 0
  )) {
    rows.push([Markup.button.callback('Orders', 'reports:orders')]);
  }
  if (hasRedmine && redmineSchedules.length > 0) {
    rows.push([Markup.button.callback('Redmine tickets', 'reports:redmine')]);
  }
  if (hasYoutrack && youtrackSchedules.length > 0) {
    rows.push([Markup.button.callback('Youtrack', 'reports:youtrack')]);
  }

  if (rows.length === 0) return null;
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersReportsMenu(userId: string) {
  const [hasGto, hasComments, reports, commentSchedules] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    hasSourceAccess(userId, ['gto_comments']),
    getUserManualReportAccess(userId),
    getManualSchedulesBySourceTypes(['gto_comments']),
  ]);
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  const hasSales = hasGto && reports.some((report) => ['sales.yesterday', 'sales.today', 'sales.summer'].includes(report.key) && report.enabled);
  const hasPayments = hasGto && reports.some((report) => ['sales.payments_yesterday', 'sales.payments_today'].includes(report.key) && report.enabled);
  const hasAgents = hasGto && reports.some((report) => report.key === 'sales.agents' && report.enabled);
  const hasNetworks = hasGto && reports.some((report) => report.key === GTO_NETWORK_ACCESS_KEY && report.enabled);
  const hasCommentsMenu = hasComments && commentSchedules.length > 0
    && commentSchedules.some((schedule) => reports.some((report) => report.key === makeScheduleRunReportKey(schedule.id) && report.enabled));

  if (hasSales) rows.push([Markup.button.callback('Sales', 'orders:sales')]);
  if (hasCommentsMenu) rows.push([Markup.button.callback('Comments', 'orders:comments')]);
  if (hasPayments) rows.push([Markup.button.callback('Payments', 'orders:payments')]);
  if (hasAgents) rows.push([Markup.button.callback('Agents activity', 'orders:agents')]);
  if (hasNetworks) rows.push([Markup.button.callback('Network sales', 'orders:networks')]);
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:home')]);
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersSalesMenu(userId: string) {
  const [allowed, reports] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (reports.find((report) => report.key === 'sales.today')?.enabled) {
    rows.push([Markup.button.callback('Today', 'gen:sales:today')]);
  }
  if (reports.find((report) => report.key === 'sales.yesterday')?.enabled) {
    rows.push([Markup.button.callback('Yesterday', 'gen:sales:daily')]);
  }
  const hasSalesAccess = reports.some((report) => ['sales.yesterday', 'sales.today'].includes(report.key) && report.enabled);
  if (hasSalesAccess) {
    rows.push([Markup.button.callback('Last 7 days', 'gen:sales:last7')]);
  }
  if (reports.find((report) => report.key === 'sales.summer')?.enabled) {
    rows.push([Markup.button.callback('Summer', 'gen:sales:summer')]);
  }
  if (hasSalesAccess) {
    rows.push([Markup.button.callback('Custom period', 'custom:sales:sales')]);
  }
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:orders')]);
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersCommentsMenu(userId: string) {
  const [allowed, schedules, manualReports] = await Promise.all([
    hasSourceAccess(userId, ['gto_comments']),
    getManualSchedulesBySourceTypes(['gto_comments']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  const allowedSchedules = schedules.filter((schedule) =>
    manualReports.some((report) => report.key === makeScheduleRunReportKey(schedule.id) && report.enabled),
  );
  if (allowedSchedules.length === 0) return null;
  const preferred = allowedSchedules.find((schedule) => schedule.periodType === 'daily') || allowedSchedules[0];
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback('Today', `gen:comments_period:${preferred.id}:today`)],
    [Markup.button.callback('Yesterday', `gen:comments_period:${preferred.id}:yesterday`)],
    [Markup.button.callback('Last 7 days', `gen:comments_period:${preferred.id}:last7`)],
    [Markup.button.callback('Custom period', `custom:schedule:${preferred.id}`)],
    [Markup.button.callback('← Back', 'reports:orders')],
  ];
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersPaymentsMenu(userId: string) {
  const [allowed, reports] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (reports.find((report) => report.key === 'sales.payments_today')?.enabled) {
    rows.push([Markup.button.callback('Today', 'gen:sales:payments_today')]);
  }
  if (reports.find((report) => report.key === 'sales.payments_yesterday')?.enabled) {
    rows.push([Markup.button.callback('Yesterday', 'gen:sales:payments_yesterday')]);
  }
  if (reports.some((report) => ['sales.payments_yesterday', 'sales.payments_today'].includes(report.key) && report.enabled)) {
    rows.push([Markup.button.callback('Last 7 days', 'gen:sales:payments_last7')]);
    rows.push([Markup.button.callback('Custom period', 'custom:sales:payments')]);
  }
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:orders')]);
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersAgentsMenu(userId: string) {
  const [allowed, reports] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  if (!reports.find((report) => report.key === 'sales.agents')?.enabled) return null;
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback('Today', 'gen:sales:agents_today')],
    [Markup.button.callback('Yesterday', 'gen:sales:agents_yesterday')],
    [Markup.button.callback('Last 7 days', 'gen:sales:agents')],
    [Markup.button.callback('Custom period', 'custom:sales:agents')],
    [Markup.button.callback('← Back', 'reports:orders')],
  ];
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersNetworksMenu(userId: string) {
  const [allowed, reports] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  if (!reports.find((report) => report.key === GTO_NETWORK_ACCESS_KEY)?.enabled) return null;

  const rows = GTO_NETWORK_MENU_ITEMS.map((item) => [Markup.button.callback(item.label, `orders:network:${item.key}`)]);
  rows.push([Markup.button.callback('← Back', 'reports:orders')]);
  return Markup.inlineKeyboard(rows);
}

async function buildOrdersNetworkPeriodMenu(userId: string, networkKey: 'general' | GtoNetworkKey) {
  const [allowed, reports] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  if (!reports.find((report) => report.key === GTO_NETWORK_ACCESS_KEY)?.enabled) return null;

  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback('7 days', `gen:sales:network:${networkKey}:7d`)],
    [Markup.button.callback('30 days', `gen:sales:network:${networkKey}:30d`)],
    [Markup.button.callback('Custom period', `custom:sales:network:${networkKey}`)],
    [Markup.button.callback('← Back', 'orders:networks')],
  ];
  return Markup.inlineKeyboard(rows);
}

async function buildYoutrackReportsMenu(userId: string) {
  const [allowed, schedules, manualReports] = await Promise.all([
    hasSourceAccess(userId, ['youtrack', 'youtrack_progress']),
    getManualSchedulesBySourceTypes(['youtrack', 'youtrack_progress']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  if (schedules.length === 0) return null;

  const preferredProgress =
    schedules.find((schedule) => String(schedule.source.type) === 'youtrack_progress')
    || schedules.find((schedule) => String(schedule.source.type) === 'youtrack')
    || schedules[0];
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  const preferredKeys = [24, 48, 168]
    .filter((hours) => manualReports.some((report) => report.key === makeScheduleHoursReportKey(preferredProgress.id, hours) && report.enabled));

  if (preferredKeys.includes(24)) rows.push([Markup.button.callback('24 hours', `gen:youtrack_hours:${preferredProgress.id}:24`)]);
  if (preferredKeys.includes(48)) rows.push([Markup.button.callback('48 hours', `gen:youtrack_hours:${preferredProgress.id}:48`)]);
  if (preferredKeys.includes(168)) rows.push([Markup.button.callback('7 days', `gen:youtrack_hours:${preferredProgress.id}:168`)]);
  if (manualReports.some((report) => report.key === makeScheduleRunReportKey(preferredProgress.id) && report.enabled)) {
    rows.push([Markup.button.callback('Custom period', `custom:schedule:${preferredProgress.id}`)]);
  }
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:home')]);
  return Markup.inlineKeyboard(rows);
}

async function buildRedmineReportsMenu(userId: string) {
  const [allowed, schedules, manualReports] = await Promise.all([
    hasSourceAccess(userId, ['redmine']),
    getManualSchedulesBySourceTypes(['redmine']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  if (schedules.length === 0) return null;

  const preferredSchedule =
    schedules.find(schedule => schedule.periodType === 'daily') ||
    schedules.find(schedule => schedule.periodType === 'weekly') ||
    schedules[0];

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (manualReports.some((report) => report.key === 'redmine.hours.24' && report.enabled)) {
    rows.push([Markup.button.callback('24 hours', `gen:redmine_hours:${preferredSchedule.id}:24`)]);
  }
  if (manualReports.some((report) => report.key === 'redmine.hours.48' && report.enabled)) {
    rows.push([Markup.button.callback('48 hours', `gen:redmine_hours:${preferredSchedule.id}:48`)]);
  }
  if (manualReports.some((report) => report.key === 'redmine.hours.168' && report.enabled)) {
    rows.push([Markup.button.callback('7 days', `gen:redmine_hours:${preferredSchedule.id}:168`)]);
  }
  if (manualReports.some((report) => ['redmine.hours.24', 'redmine.hours.48', 'redmine.hours.168'].includes(report.key) && report.enabled)) {
    rows.push([Markup.button.callback('Custom period', `custom:schedule:${preferredSchedule.id}`)]);
  }
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:home')]);

  return Markup.inlineKeyboard(rows);
}

async function runStoredAnalysis(
  scheduleId: string,
  periodOverride?: { periodStart: Date; periodEnd: Date },
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
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
  const { periodStart, periodEnd } = periodOverride || computePeriod(schedule.periodType as any, timezone);
  const run = await createManualReportRun({ scheduleId, periodStart, periodEnd }, initiator);

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

    const rendered = String(schedule.source.type) === 'gto_comments'
      ? buildGtoCommentsPrompts({
          normalizedMetricsJson: JSON.stringify(fetchResult.data.metrics),
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        })
      : await promptRegistry.renderPrompt(promptVersion, {
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
      formattedMessage = formatGtoReportText(formattedMessage);
      formattedMessage = injectProductBlocks(formattedMessage, [
        (fetchResult.data.metrics as any)?.computed?.section1_yesterday,
        (fetchResult.data.metrics as any)?.computed?.section2_last_7_days,
      ]);
      formattedMessage = injectTourStartMonthsBlock(formattedMessage, (fetchResult.data.metrics as any)?.computed?.section1_yesterday?.tour_start_months || []);
    }
    if (String(schedule.source.type) === 'youtrack_progress') {
      formattedMessage = formatYouTrackProgressTelegramMessage(formattedMessage, fetchResult.data.metrics, analysis.structuredOutput);
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
async function runAnalysis(scheduleId: string, initiator?: ManualRunInitiator): Promise<{ runId: string; resultId: string; message: string }> {
  return runStoredAnalysis(scheduleId, undefined, initiator);
}

async function runAnalysisForPeriod(
  scheduleId: string,
  periodStart: Date,
  periodEnd: Date,
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  return runStoredAnalysis(scheduleId, { periodStart, periodEnd }, initiator);
}

async function resolvePresetPeriod(sourceId: string, preset: 'today' | 'yesterday' | 'last7'): Promise<{ periodStart: Date; periodEnd: Date }> {
  const timezone = await getSourceTimezone(sourceId);
  if (preset === 'today') return computeCurrentDayPeriod(timezone);
  if (preset === 'yesterday') return computePeriod('daily', timezone);
  return computePeriod('weekly', timezone);
}

async function resolveRollingDaysPeriod(sourceId: string, days: number): Promise<{ periodStart: Date; periodEnd: Date }> {
  const timezone = await getSourceTimezone(sourceId);
  const periodEnd = computeCurrentDayPeriod(timezone).periodEnd;
  const periodStart = new Date(periodEnd.getTime() - days * 86400000);
  return { periodStart, periodEnd };
}

async function runRollingHoursAnalysis(scheduleId: string, hours: number, initiator?: ManualRunInitiator): Promise<{ runId: string; resultId: string; message: string }> {
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

  const { periodStart, periodEnd } = computeRollingHoursPeriod(hours);
  const run = await createManualReportRun({ scheduleId, periodStart, periodEnd }, initiator);

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
      source_name: `${schedule.source.name} (${hours}h)`,
      output_language: 'Russian',
      audience_type: 'business',
    });

    const analysis = await llmService.analyze({
      systemPrompt: rendered.system,
      userPrompt: rendered.user,
      sourceId: schedule.source.id,
      runId: run.id,
    });

    const formattedMessage = String(schedule.source.type) === 'youtrack_progress'
      ? formatYouTrackProgressTelegramMessage(analysis.telegramMessage, fetchResult.data.metrics, analysis.structuredOutput)
      : analysis.telegramMessage;

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
    const errorSummary = err?.message || 'Rolling hours generation failed';
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

async function runGtoAgentActivityReport(
  periodOverride?: { periodStart: Date; periodEnd: Date },
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: schedule.source.id } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: schedule.source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach((s) => { settings[s.key] = s.value; });

  const timezone = await getSourceTimezone(schedule.source.id);
  const { periodStart, periodEnd } = periodOverride || computePeriod('daily' as any, timezone);
  const run = await createManualReportRun({ scheduleId: schedule.id, periodStart, periodEnd }, initiator);

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

    const connector = connectorRegistry.get(schedule.source.type);
    const result = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
    if (!result.success || !result.data) throw new Error(result.error?.message || 'Ошибка получения данных');

    const message = periodOverride
      ? formatGtoAgentActivityPeriodReport(result.data.metrics)
      : formatGtoAgentActivityReport(result.data.metrics);
    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: result.data.metrics as any,
        formattedMessage: message,
      },
      update: {
        normalizedData: result.data.metrics as any,
        formattedMessage: message,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });

    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return { runId: run.id, resultId: storedResult.id, message };
  } catch (err: any) {
    const errorSummary = err?.message || 'Agent activity report generation failed';
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

async function runGtoNetworkSalesReport(
  networkKey: 'general' | GtoNetworkKey,
  periodStart: Date,
  periodEnd: Date,
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: schedule.source.id } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: schedule.source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach((s) => { settings[s.key] = s.value; });

  const run = await createManualReportRun({ scheduleId: schedule.id, periodStart, periodEnd }, initiator);

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

    const connector = connectorRegistry.get(schedule.source.type);
    const result = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
    if (!result.success || !result.data) throw new Error(result.error?.message || 'Ошибка получения данных');

    const message = networkKey === 'general'
      ? formatNetworkGeneralReport(result.data.metrics)
      : formatSingleNetworkSalesReport(result.data.metrics, networkKey);

    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: result.data.metrics as any,
        formattedMessage: message,
      },
      update: {
        normalizedData: result.data.metrics as any,
        formattedMessage: message,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return { runId: run.id, resultId: storedResult.id, message };
  } catch (err: any) {
    const errorSummary = err?.message || 'Network sales report generation failed';
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

function formatTopDestinationLines(destinations: any[]): string[] {
  return destinations.slice(0, 3).map(d => `${d.flag || ''}${d.country} ${formatInt(d.orders)} зак / ${formatInt(d.tourists)} тур`.trim());
}

function formatProductLines(products: any): string[] {
  return [
    { key: 'package', label: '🏨Пакет' },
    { key: 'hotel', label: '🏩Отель' },
    { key: 'flight', label: '✈️Перелёт' },
    { key: 'transfer', label: '🚐Трансферы' },
    { key: 'insurance', label: '🛡️Страховки' },
  ]
    .map(({ key, label }) => ({ label, data: products?.[key] }))
    .filter(item => item.data && item.data.orders > 0)
    .map(item => `${item.label} ${formatInt(item.data.orders)} зак / ${formatInt(item.data.tourists)} тур, ср. глубина ${item.data.avg_lead_days ?? '—'} дн.`);
}

function formatSupplierLines(suppliers: any[]): string[] {
  return suppliers.slice(0, 3).map(s => `${s.name} - ${formatInt(s.orders)} заказов, ${formatInt(s.cost_eur)} EUR`);
}

function formatNegativeMarginLines(orders: any[]): string[] {
  return orders.map(o => `#${o.order_id} — GMV ${formatInt(o.revenue_eur)} EUR, себест. ${formatInt(o.cost_eur)} EUR, маржа ${o.profit_pct}%`);
}

function formatAgentMainProducts(products: any[]): string {
  if (!Array.isArray(products) || products.length === 0) return '—';
  return products.map((product) => `${product.label} (${formatInt(product.orders)}; ${product.pct}%)`).join(', ');
}

function formatPct(value: number): string {
  return `${Math.round(value || 0)}%`;
}

function getNetworkProductEmoji(key: string): string {
  return {
    package: '🏨',
    hotel: '🏩',
    flight: '✈️',
    transfer: '🚐',
    insurance: '🛡️',
    other: '📦',
  }[key] || '📦';
}

function formatNetworkProductStructureLines(products: any): string[] {
  const entries = Object.entries(products || {})
    .map(([key, value]: [string, any]) => ({ key, value }))
    .filter((entry) => entry.value?.orders > 0)
    .sort((a, b) => {
      if ((b.value.revenue_eur || 0) !== (a.value.revenue_eur || 0)) return (b.value.revenue_eur || 0) - (a.value.revenue_eur || 0);
      return (b.value.orders || 0) - (a.value.orders || 0);
    });

  return entries.map(({ key, value }: { key: string; value: any }) =>
    `${getNetworkProductEmoji(key)} ${value.label || 'Продукт'}: ${formatInt(value.orders)} зак / ${formatInt(value.tourists || 0)} тур / ${formatInt(value.revenue_eur || 0)} EUR / profit ${formatInt(value.profit_eur || 0)} EUR (${value.profit_pct || 0}%), ср. глубина ${value.avg_lead_days ?? '—'} дн.`,
  );
}

function formatNetworkTopProductLines(products: any[]): string[] {
  return (products || []).slice(0, 5).map((product: any) =>
    `${getNetworkProductEmoji(product.key)} ${product.label} — ${formatInt(product.orders)} зак (${formatInt(product.revenue_eur || 0)} EUR), ср. глубина ${product.avg_lead_days ?? '—'} дн.`,
  );
}

function formatNetworkTopAgentLines(agents: any[]): string[] {
  const lines: string[] = [];
  for (const [index, agent] of (agents || []).slice(0, 5).entries()) {
    lines.push(
      `${index + 1}. ${agent.name}`,
      `Заказы: ${formatInt(agent.orders)}, туристы: ${formatInt(agent.tourists || 0)}`,
      `Деньги: ${formatInt(agent.revenue_eur || 0)} EUR, прибыль: ${formatInt(agent.profit_eur || 0)} EUR`,
      `Структура заказов: ${formatAgentMainProducts(agent.main_products || [])}`,
      '',
    );
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function formatNetworkGeneralReport(metrics: any): string {
  const section = metrics?.computed?.section6_requested_period_network_sales;
  if (!section?.general) throw new Error('Данные отчёта по сетям недоступны');

  const lines: string[] = [
    '🌐 Network sales / General',
    `Период: ${formatPeriodLabel(section.period?.from, section.period?.to)}`,
    '',
    'Все денежные показатели приведены к EUR. Деньги и прибыль считаются по CNF.',
  ];

  for (const item of section.general.networks || []) {
    lines.push(
      '',
      `========== ${item.label} ==========`,
      `${item.label} — заказы ${formatInt(item.orders_total)} (${formatPct(item.share_of_gto?.orders_pct || 0)} GTO), туристы ${formatInt(item.tourists || 0)} (${formatPct(item.share_of_gto?.tourists_pct || 0)} GTO), выручка ${formatInt(item.revenue_eur || 0)} EUR (${formatPct(item.share_of_gto?.revenue_pct || 0)} GTO), profit ${formatInt(item.profit_eur || 0)} EUR (${item.profit_pct || 0}%)`,
    );
    const productLines = formatNetworkTopProductLines(item.top_products_by_orders || []);
    if (productLines.length > 0) {
      lines.push('Топ продукты:', ...productLines);
    } else {
      lines.push('Топ продукты: —');
    }
  }

  return lines.join('\n').trim();
}

function formatSingleNetworkSalesReport(metrics: any, networkKey: GtoNetworkKey): string {
  const section = metrics?.computed?.section6_requested_period_network_sales?.networks?.[networkKey];
  if (!section) throw new Error('Данные отчёта по сети недоступны');

  const lines: string[] = [
    `🌐 Network sales / ${section.label}`,
    `Период: ${formatPeriodLabel(metrics?.computed?.section6_requested_period_network_sales?.period?.from, metrics?.computed?.section6_requested_period_network_sales?.period?.to)}`,
    '',
  ];

  if (!section.data_available) {
    lines.push('За выбранный период по этой сети данных нет.');
    return lines.join('\n');
  }

  lines.push(
    `📦 Заказы: ${formatInt(section.orders?.total || 0)} (✅${formatInt(section.orders?.confirmed || 0)} / ❌${formatInt(section.orders?.cancelled || 0)} / ⚠️${formatInt(section.orders?.pending || 0)})`,
    `Туристы: ${formatInt(section.tourists || 0)}`,
    '',
    `💶 Выручка по CNF: ${formatInt(section.financials?.revenue_eur || 0)} EUR`,
    `Прибыль по CNF: ${formatInt(section.financials?.profit_eur || 0)} EUR (${section.financials?.profit_pct || 0}%)`,
    `💼 Средний чек по CNF: ${formatInt(section.financials?.avg_order_eur || 0)} EUR`,
    'Все денежные показатели приведены к EUR.',
  );

  const topAgents = formatNetworkTopAgentLines(section.top_agents_by_orders || []);
  if (topAgents.length > 0) {
    lines.push('', '---🏆 ТОП 5 агентов по заказам---', ...topAgents);
  }

  const productStructure = formatNetworkProductStructureLines(section.top_products_by_revenue || []);
  if (productStructure.length > 0) {
    lines.push('', '---📦 Структура заказов и прибыли---', ...productStructure);
  }

  const destinations = formatTopDestinationLines(section.top_destinations || []);
  if (destinations.length > 0) {
    lines.push('', '---🌍 Самые популярные направления---', ...destinations);
  }

  return lines.join('\n').trim();
}

function formatGtoAgentActivityReport(metrics: any): string {
  const section = metrics?.computed?.section5_agent_activity;
  if (!section) throw new Error('Данные отчёта по агентам недоступны');

  const lines: string[] = [
    '👥 Активность агентов GTO',
    `Период: ${formatPeriodLabel(section.period?.from, section.period?.to)}`,
    '',
    `Активных агентов: ${formatInt(section.unique_active_agents || 0)}`,
    `Активных заявок: ${formatInt(section.active_orders_total || 0)}`,
    section.detail_coverage_note || `Покрытие деталей: ${section.detail_coverage_pct || 0}%`,
    '',
    'Все денежные показатели приведены к EUR.',
  ];

  const topAgents = Array.isArray(section.top_agents_by_revenue) ? section.top_agents_by_revenue.slice(0, 5) : [];
  if (topAgents.length > 0) {
    lines.push('', '---🏆 ТОП агентов по выручке---');
    for (const [index, agent] of topAgents.entries()) {
      lines.push(
        `${index + 1}. ${agent.name}`,
        `Выручка: ${formatInt(agent.revenue_eur)} EUR`,
        `Заявок: ${formatInt(agent.orders)}, туристов: ${formatInt(agent.tourists)}`,
        `Основные продукты: ${formatAgentMainProducts(agent.main_products)}`,
        '',
      );
    }
    while (lines[lines.length - 1] === '') lines.pop();
  } else {
    lines.push('', 'За выбранный период активных агентов не найдено.');
  }

  return lines.join('\n').trim();
}

function formatGtoAgentActivityPeriodReport(metrics: any): string {
  const section = metrics?.computed?.section5_requested_period_agent_activity;
  if (!section) throw new Error('Данные отчёта по агентам за период недоступны');

  const lines: string[] = [
    '👥 Активность агентов GTO',
    `Период: ${formatPeriodLabel(section.period?.from, section.period?.to)}`,
    '',
    `Активных агентов: ${formatInt(section.unique_active_agents || 0)}`,
    `Активных заявок: ${formatInt(section.active_orders_total || 0)}`,
    section.detail_coverage_note || `Покрытие деталей: ${section.detail_coverage_pct || 0}%`,
    '',
    'Все денежные показатели приведены к EUR.',
  ];

  const topAgents = Array.isArray(section.top_agents_by_revenue) ? section.top_agents_by_revenue.slice(0, 5) : [];
  if (topAgents.length > 0) {
    lines.push('', '---🏆 ТОП агентов по выручке---');
    for (const [index, agent] of topAgents.entries()) {
      lines.push(
        `${index + 1}. ${agent.name}`,
        `Выручка: ${formatInt(agent.revenue_eur)} EUR`,
        `Заявок: ${formatInt(agent.orders)}, туристов: ${formatInt(agent.tourists)}`,
        `Основные продукты: ${formatAgentMainProducts(agent.main_products)}`,
        '',
      );
    }
    while (lines[lines.length - 1] === '') lines.pop();
  }

  return lines.join('\n').trim();
}

type PaymentDirection = 'in' | 'out';

type PaymentRow = {
  id: string;
  type: PaymentDirection;
  order_id: string;
  amount_eur: number;
  payment_form: string;
  date: string;
  received_from: string;
  is_revoked: boolean;
};

function formatPaymentFormLines(forms: Array<{ payment_form: string; count: number; amount_eur: number }>): string[] {
  return forms.map((form) => `${form.payment_form} — ${formatInt(form.count)} платежей, ${formatInt(form.amount_eur)} EUR`);
}

function formatTopPaymentLines(rows: PaymentRow[]): string[] {
  return rows.slice(0, 5).map((row) => {
    const suffix = row.received_from ? `, ${row.received_from}` : '';
    return `#${row.order_id} — ${formatInt(row.amount_eur)} EUR (${row.payment_form}${suffix})`;
  });
}

function formatGtoPaymentsReport(title: string, periodLabel: string, payload: any): string {
  const incoming = payload?.incoming || { count: 0, amount_eur: 0, by_form: [], top_payments: [] };
  const outgoing = payload?.outgoing || { count: 0, amount_eur: 0, by_form: [], top_payments: [] };

  const lines: string[] = [
    title,
    `Период: ${periodLabel}`,
    '',
    'Все денежные показатели приведены к EUR.',
    '',
    '---📥 Входящие---',
    `Платежей: ${formatInt(incoming.count)}`,
    `Сумма: ${formatInt(incoming.amount_eur)} EUR`,
  ];

  const incomingForms = formatPaymentFormLines(incoming.by_form || []);
  if (incomingForms.length > 0) {
    lines.push('', 'Типы оплат:', ...incomingForms);
  }

  const incomingTop = formatTopPaymentLines(incoming.top_payments || []);
  if (incomingTop.length > 0) {
    lines.push('', 'Крупнейшие входящие:', ...incomingTop);
  }

  lines.push('', '---📤 Исходящие---', `Платежей: ${formatInt(outgoing.count)}`, `Сумма: ${formatInt(outgoing.amount_eur)} EUR`);

  const outgoingForms = formatPaymentFormLines(outgoing.by_form || []);
  if (outgoingForms.length > 0) {
    lines.push('', 'Типы оплат:', ...outgoingForms);
  }

  const outgoingTop = formatTopPaymentLines(outgoing.top_payments || []);
  if (outgoingTop.length > 0) {
    lines.push('', 'Крупнейшие исходящие:', ...outgoingTop);
  }

  return lines.join('\n').trim();
}

async function getGtoPaymentsBaseConfig(sourceId: string) {
  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId } });
  const settings: Record<string, string> = {};
  settingRows.forEach((s) => { settings[s.key] = s.value; });

  const apiKey = String(credentials.api_key || '');
  if (!apiKey) throw new Error('GTO API key не настроен');

  const baseUrl = String(credentials.base_url || DEFAULT_GTO_BASE_URL).replace(/\/$/, '');
  const timeout = parseInt(settings['request_timeout_seconds'] || '30', 10) * 1000;
  const client = createHttpClient({ baseURL: baseUrl, params: { apikey: apiKey }, timeout }, 'gto-payments');

  const v3Setting = await prisma.systemSetting.findUnique({ where: { key: 'gto.v3_base_url' } });
  const v3BaseUrl = (v3Setting?.value || DEFAULT_GTO_V3_BASE_URL).replace(/\/$/, '');
  const rates = await CurrencyService.getRates(apiKey, v3BaseUrl);

  return { client, rates };
}

async function fetchGtoPaymentsForDate(sourceId: string, dateStr: string, type: PaymentDirection): Promise<PaymentRow[]> {
  return fetchGtoPaymentsForPeriod(sourceId, dateStr, dateStr, type);
}

async function fetchGtoPaymentsForPeriod(sourceId: string, fromDate: string, toDate: string, type: PaymentDirection): Promise<PaymentRow[]> {
  const { client, rates } = await getGtoPaymentsBaseConfig(sourceId);
  const rows: PaymentRow[] = [];
  const perPage = 1000;
  let page = 1;

  for (;;) {
    const resp = await client.get('/payments_list', {
      params: {
        type,
        date_from: fromDate,
        date_to: toDate,
        per_page: perPage,
        page,
      },
    });

    const data = Array.isArray(resp.data?.data) ? resp.data.data : Array.isArray(resp.data) ? resp.data : [];
    for (const item of data) {
      if (item?.is_revoked) continue;
      const amount = Math.abs(parseFloat(item?.amount) || 0);
      const currency = String(item?.currency_code || item?.balance_currency_code || 'EUR');
      rows.push({
        id: String(item?.id || ''),
        type,
        order_id: String(item?.order_id || ''),
        amount_eur: CurrencyService.toEur(amount, currency, rates),
        payment_form: String(item?.payment_form || 'Unknown'),
        date: String(item?.date || fromDate),
        received_from: String(item?.received_from || '').trim(),
        is_revoked: Boolean(item?.is_revoked),
      });
    }

    if (data.length < perPage) break;
    page++;
    if (page > 20) break;
  }

  return rows;
}

function summarizePayments(rows: PaymentRow[]) {
  const byForm = new Map<string, { count: number; amount_eur: number }>();
  for (const row of rows) {
    const key = row.payment_form || 'Unknown';
    const existing = byForm.get(key) || { count: 0, amount_eur: 0 };
    existing.count += 1;
    existing.amount_eur += row.amount_eur;
    byForm.set(key, existing);
  }

  return {
    count: rows.length,
    amount_eur: rows.reduce((sum, row) => sum + row.amount_eur, 0),
    by_form: [...byForm.entries()]
      .map(([payment_form, stats]) => ({ payment_form, count: stats.count, amount_eur: stats.amount_eur }))
      .sort((a, b) => b.amount_eur - a.amount_eur),
    top_payments: [...rows].sort((a, b) => b.amount_eur - a.amount_eur).slice(0, 5),
  };
}

async function runGtoPaymentsReport(mode: 'today' | 'yesterday', initiator?: ManualRunInitiator): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const timezone = await getSourceTimezone(schedule.source.id);
  const period = mode === 'today' ? computeCurrentDayPeriod(timezone) : computePeriod('daily', timezone);
  const dateStr = period.periodStart.toLocaleDateString('sv-SE', { timeZone: timezone });
  const periodLabel = formatPeriodLabel(dateStr, dateStr);

  const run = await createManualReportRun({
    scheduleId: schedule.id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  }, initiator);

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

    const [incomingRows, outgoingRows] = await Promise.all([
      fetchGtoPaymentsForDate(schedule.source.id, dateStr, 'in'),
      fetchGtoPaymentsForDate(schedule.source.id, dateStr, 'out'),
    ]);

    const normalizedData = {
      payments: {
        period: { from: dateStr, to: dateStr },
        incoming: summarizePayments(incomingRows),
        outgoing: summarizePayments(outgoingRows),
      },
    };

    const title = mode === 'today' ? '💳 Отчёт по оплатам GTO Today' : '💳 Отчёт по оплатам GTO Yesterday';
    const message = formatGtoPaymentsReport(title, periodLabel, normalizedData.payments);

    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: normalizedData as any,
        formattedMessage: message,
      },
      update: {
        normalizedData: normalizedData as any,
        formattedMessage: message,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });

    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return { runId: run.id, resultId: storedResult.id, message };
  } catch (err: any) {
    const errorSummary = err?.message || 'Payments report generation failed';
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

async function runGtoPaymentsReportForPeriod(
  periodStart: Date,
  periodEnd: Date,
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const timezone = await getSourceTimezone(schedule.source.id);
  const fromDate = periodStart.toLocaleDateString('sv-SE', { timeZone: timezone });
  const toDate = new Date(periodEnd.getTime() - 1).toLocaleDateString('sv-SE', { timeZone: timezone });
  const periodLabel = formatPeriodLabel(fromDate, toDate);

  const run = await createManualReportRun({ scheduleId: schedule.id, periodStart, periodEnd }, initiator);

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

    const [incomingRows, outgoingRows] = await Promise.all([
      fetchGtoPaymentsForPeriod(schedule.source.id, fromDate, toDate, 'in'),
      fetchGtoPaymentsForPeriod(schedule.source.id, fromDate, toDate, 'out'),
    ]);

    const normalizedData = {
      payments: {
        period: { from: fromDate, to: toDate },
        incoming: summarizePayments(incomingRows),
        outgoing: summarizePayments(outgoingRows),
      },
    };

    const message = formatGtoPaymentsReport('💳 Отчёт по оплатам GTO', periodLabel, normalizedData.payments);
    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: normalizedData as any,
        formattedMessage: message,
      },
      update: {
        normalizedData: normalizedData as any,
        formattedMessage: message,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return { runId: run.id, resultId: storedResult.id, message };
  } catch (err: any) {
    const errorSummary = err?.message || 'Payments custom period generation failed';
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

async function runGtoPaymentsPresetReport(
  preset: 'last7',
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');
  const period = await resolvePresetPeriod(schedule.source.id, preset);
  return runGtoPaymentsReportForPeriod(period.periodStart, period.periodEnd, initiator);
}

function formatGtoTodayReport(metrics: any): string {
  const section = metrics?.computed?.section1_yesterday;
  const snapshot = section?.non_cancelled_snapshot;
  if (!section || !snapshot) throw new Error('Данные Today-отчёта недоступны');

  const topAgent = snapshot.top_agents_by_orders?.[0];
  const mostExpensive = snapshot.most_expensive_order;
  const cnfFinancials = section.financials || {};
  const lines: string[] = [
    '📊 Отчёт по продажам GTO Today',
    `Период: ${section.period.from.split('-').reverse().join('/')}`,
    '',
    `📦  Заявок: ${formatInt(section.orders.total)} (✅${formatInt(section.orders.confirmed)} подтв, ❌${formatInt(section.orders.cancelled)} отмен, ⚠️${formatInt(section.orders.pending)} pending)`,
    `Туристов: ${formatInt(snapshot.tourists)}`,
    '',
    `💶 Выручка (без cancelled): ${formatInt(snapshot.financials.revenue_eur)} EUR`,
    `Прибыль по CNF: ${formatInt(cnfFinancials.profit_eur || 0)} EUR (${cnfFinancials.profit_pct || 0}%)`,
    `💼 Средний чек по CNF: ${formatInt(cnfFinancials.avg_order_eur || 0)} EUR`,
    'Все денежные показатели приведены к EUR.',
    '',
    '---🌍 Направления---',
    ...formatTopDestinationLines(snapshot.top_destinations || []),
    '',
    '---📦 Продукты---',
    ...formatProductLines(snapshot.product_breakdown || {}),
  ];

  const startMonthLines = formatTourStartMonthLines(snapshot.tour_start_months || []);
  if (startMonthLines.length > 0) {
    lines.push('', '---🗓 Старт туров---', ...startMonthLines);
  }

  if (topAgent) {
    lines.push('', `👥 Топ агент: ${topAgent.name} — ${formatInt(topAgent.orders)} зак, ${formatInt(topAgent.tourists)} тур`);
  }

  if (mostExpensive) {
    lines.push('', `💎 Самый дорогой заказ: #${mostExpensive.order_id} — ${formatInt(mostExpensive.price_eur)} EUR`);
  }

  const supplierLines = formatSupplierLines(snapshot.top_suppliers_by_orders || []);
  if (supplierLines.length > 0) {
    lines.push('', 'Самые популярные поставщики (себестоимость):', ...supplierLines);
  }

  lines.push('', `🔴 Отрицательная маржа (${formatInt(snapshot.negative_margin_count || 0)} заказов):`);
  const negativeLines = formatNegativeMarginLines(snapshot.negative_margin_orders || []);
  if (negativeLines.length > 0) lines.push(...negativeLines);

  return lines.join('\n').trim();
}

function formatGtoSalesPeriodReport(metrics: any): string {
  const section = metrics?.computed?.section0_requested_period_sales;
  if (!section) throw new Error('Данные отчёта по продажам за период недоступны');

  const topAgent = section.top_agents_by_orders?.[0];
  const mostExpensive = section.most_expensive_order;
  const lines: string[] = [
    '📊 Отчёт по продажам GTO',
    `Период: ${formatPeriodLabel(section.period?.from, section.period?.to)}`,
    '',
    `📦 Заявок: ${formatInt(section.orders.total)} (✅${formatInt(section.orders.confirmed)} подтв, ❌${formatInt(section.orders.cancelled)} отмен, ⚠️${formatInt(section.orders.pending)} pending)`,
    `Туристов: ${formatInt(section.tourists || 0)}`,
    '',
    `💶 Выручка по CNF: ${formatInt(section.financials?.revenue_eur || 0)} EUR`,
    `Прибыль по CNF: ${formatInt(section.financials?.profit_eur || 0)} EUR (${section.financials?.profit_pct || 0}%)`,
    `💼 Средний чек по CNF: ${formatInt(section.financials?.avg_order_eur || 0)} EUR`,
    'Все денежные показатели приведены к EUR.',
    '',
    '---🌍 Направления---',
    ...formatTopDestinationLines(section.top_destinations || []),
    '',
    '---📦 Продукты---',
    ...formatProductLines(section.product_breakdown || {}),
  ];

  const startMonthLines = formatTourStartMonthLines(section.tour_start_months || []);
  if (startMonthLines.length > 0) {
    lines.push('', '---🗓 Старт туров---', ...startMonthLines);
  }
  if (topAgent) {
    lines.push('', `👥 Топ агент: ${topAgent.name} — ${formatInt(topAgent.orders)} зак, ${formatInt(topAgent.tourists)} тур`);
  }
  if (mostExpensive) {
    lines.push('', `💎 Самый дорогой заказ: #${mostExpensive.order_id} — ${formatInt(mostExpensive.price_eur)} EUR`);
  }

  lines.push('', `🔴 Отрицательная маржа (${formatInt(section.negative_margin_count || 0)} заказов):`);
  const negativeLines = formatNegativeMarginLines(section.negative_margin_orders || []);
  if (negativeLines.length > 0) lines.push(...negativeLines);

  return lines.join('\n').trim();
}

async function runGtoTodayReport(initiator?: ManualRunInitiator): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: schedule.source.id } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: schedule.source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach(s => { settings[s.key] = s.value; });

  const timezone = await getSourceTimezone(schedule.source.id);
  const { periodStart, periodEnd } = computeCurrentDayPeriod(timezone);
  const run = await createManualReportRun({ scheduleId: schedule.id, periodStart, periodEnd }, initiator);

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

    const connector = connectorRegistry.get(schedule.source.type);
    const fetchResult = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
    if (!fetchResult.success || !fetchResult.data) {
      throw new Error(fetchResult.error?.message || 'Ошибка получения данных');
    }

    const message = formatGtoTodayReport(fetchResult.data.metrics);
    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: fetchResult.data.metrics as any,
        formattedMessage: message,
      },
      update: {
        normalizedData: fetchResult.data.metrics as any,
        formattedMessage: message,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });

    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return { runId: run.id, resultId: storedResult.id, message };
  } catch (err: any) {
    const errorSummary = err?.message || 'Today report generation failed';
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

async function runGtoSalesPeriodReport(
  periodStart: Date,
  periodEnd: Date,
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: schedule.source.id } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: schedule.source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach((s) => { settings[s.key] = s.value; });

  const run = await createManualReportRun({ scheduleId: schedule.id, periodStart, periodEnd }, initiator);

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

    const connector = connectorRegistry.get(schedule.source.type);
    const fetchResult = await connector.fetchData(credentials, settings, { start: periodStart, end: periodEnd });
    if (!fetchResult.success || !fetchResult.data) {
      throw new Error(fetchResult.error?.message || 'Ошибка получения данных');
    }

    const message = formatGtoSalesPeriodReport(fetchResult.data.metrics);
    const storedResult = await prisma.reportResult.upsert({
      where: { runId_sourceId: { runId: run.id, sourceId: schedule.source.id } },
      create: {
        runId: run.id,
        sourceId: schedule.source.id,
        normalizedData: fetchResult.data.metrics as any,
        formattedMessage: message,
      },
      update: {
        normalizedData: fetchResult.data.metrics as any,
        formattedMessage: message,
      },
    });

    await prisma.reportJob.update({
      where: { runId_sourceId_jobType: { runId: run.id, sourceId: schedule.source.id, jobType: 'fetch' } },
      data: { status: 'success', completedAt: new Date() },
    });
    await prisma.reportRun.update({
      where: { id: run.id },
      data: { status: 'full_success', completedAt: new Date(), errorSummary: null },
    });

    return { runId: run.id, resultId: storedResult.id, message };
  } catch (err: any) {
    const errorSummary = err?.message || 'Sales custom period generation failed';
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

async function runGtoSalesPresetReport(
  preset: 'last7',
  initiator?: ManualRunInitiator,
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');
  const period = await resolvePresetPeriod(schedule.source.id, preset);
  return runGtoSalesPeriodReport(period.periodStart, period.periodEnd, initiator);
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

async function beginCustomPeriodSelection(
  ctx: any,
  timezone: string,
  reportLabel: string,
  target: PeriodSelectionTarget,
) {
  const maxYmd = getTodayYmd(timezone);
  const today = parseYmd(maxYmd);
  sessions.set(ctx.from!.id, {
    step: 'waiting_custom_period',
    timezone,
    reportLabel,
    target,
    displayedYear: today.year,
    displayedMonth: today.month,
    startYmd: null,
    endYmd: null,
    maxYmd,
  });

  const session = sessions.get(ctx.from!.id);
  if (!session || session.step !== 'waiting_custom_period') return;

  await ctx.editMessageText(
    buildCalendarPrompt(session),
    { parse_mode: 'Markdown', ...buildCalendarKeyboard(session) },
  ).catch(async () => {
    await ctx.reply(buildCalendarPrompt(session), { parse_mode: 'Markdown', ...buildCalendarKeyboard(session) });
  });
}

async function renderCustomPeriodCalendar(ctx: any, session: Extract<BotSession, { step: 'waiting_custom_period' }>) {
  await ctx.editMessageText(
    buildCalendarPrompt(session),
    { parse_mode: 'Markdown', ...buildCalendarKeyboard(session) } as any,
  ).catch(() => {});
}

async function executeCustomPeriodSelection(
  ctx: any,
  userId: string,
  session: Extract<BotSession, { step: 'waiting_custom_period' }>,
) {
  if (!session.startYmd) {
    await ctx.answerCbQuery('Сначала выберите дату.');
    return;
  }

  const period = normalizeCalendarPeriod(session.timezone, session.startYmd, session.endYmd);
  const startUtc = Date.UTC(parseYmd(period.from).year, parseYmd(period.from).month - 1, parseYmd(period.from).day);
  const endUtc = Date.UTC(parseYmd(period.to).year, parseYmd(period.to).month - 1, parseYmd(period.to).day);
  const inclusiveDays = Math.round((endUtc - startUtc) / 86400000) + 1;
  if (inclusiveDays > MAX_CUSTOM_PERIOD_DAYS) {
    await ctx.answerCbQuery(`Максимум ${MAX_CUSTOM_PERIOD_DAYS} дней`);
    return;
  }

  sessions.delete(ctx.from!.id);
  const label = formatPeriodLabel(period.from, period.to);
  await ctx.editMessageText(`⏳ Готовлю *${session.reportLabel}* за период *${label}*...`, { parse_mode: 'Markdown' }).catch(() => {});

  try {
    if (session.target.kind === 'sales') {
      if (!(await hasAnyManualReportAccess(userId, session.target.accessKeys))) {
        throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const result = await runGtoSalesPeriodReport(period.periodStart, period.periodEnd, { telegramUserId: userId });
      const sent = await replySafe(ctx, result.message, { disable_web_page_preview: true });
      await prisma.sentMessage.create({
        data: {
          resultId: result.resultId,
          userId,
          status: 'sent',
          telegramMessageId: sent?.message_id ? BigInt(sent.message_id) : undefined,
          sentAt: new Date(),
        },
      }).catch(() => {});
      return;
    }

    if (session.target.kind === 'payments') {
      if (!(await hasAnyManualReportAccess(userId, session.target.accessKeys))) {
        throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const result = await runGtoPaymentsReportForPeriod(period.periodStart, period.periodEnd, { telegramUserId: userId });
      const sent = await replySafe(ctx, result.message, { disable_web_page_preview: true });
      await prisma.sentMessage.create({
        data: {
          resultId: result.resultId,
          userId,
          status: 'sent',
          telegramMessageId: sent?.message_id ? BigInt(sent.message_id) : undefined,
          sentAt: new Date(),
        },
      }).catch(() => {});
      return;
    }

    if (session.target.kind === 'agents') {
      if (!(await hasAnyManualReportAccess(userId, session.target.accessKeys))) {
        throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const result = await runGtoAgentActivityReport({
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      }, { telegramUserId: userId });
      const sent = await replySafe(ctx, result.message, { disable_web_page_preview: true });
      await prisma.sentMessage.create({
        data: {
          resultId: result.resultId,
          userId,
          status: 'sent',
          telegramMessageId: sent?.message_id ? BigInt(sent.message_id) : undefined,
          sentAt: new Date(),
        },
      }).catch(() => {});
      return;
    }

    if (session.target.kind === 'network_sales') {
      if (!(await hasAnyManualReportAccess(userId, session.target.accessKeys))) {
        throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const result = await runGtoNetworkSalesReport(
        session.target.networkKey,
        period.periodStart,
        period.periodEnd,
        { telegramUserId: userId },
      );
      const sent = await replySafe(ctx, result.message, { disable_web_page_preview: true });
      await prisma.sentMessage.create({
        data: {
          resultId: result.resultId,
          userId,
          status: 'sent',
          telegramMessageId: sent?.message_id ? BigInt(sent.message_id) : undefined,
          sentAt: new Date(),
        },
      }).catch(() => {});
      return;
    }

    if (!(await hasManualReportAccess(userId, session.target.accessKey))) {
      throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }

    const result = await runAnalysisForPeriod(session.target.scheduleId, period.periodStart, period.periodEnd, { telegramUserId: userId });
    const sent = await replySafe(ctx, result.message, { disable_web_page_preview: true });
    await prisma.sentMessage.create({
      data: {
        resultId: result.resultId,
        userId,
        status: 'sent',
        telegramMessageId: sent?.message_id ? BigInt(sent.message_id) : undefined,
        sentAt: new Date(),
      },
    }).catch(() => {});
  } catch (err: any) {
    logger.error({ err, session }, 'Custom period generation failed');
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
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

        const adminChatId = await getTelegramAdminChatId();
        if (adminChatId) {
          await sendTelegramMessageSafe(
            Number(adminChatId),
            `👤 *Новая заявка на регистрацию*\n` +
            `Имя: ${(from.first_name || '').trim()} ${(from.last_name || '').trim()}\n` +
            `Username: @${from.username || 'нет'}\n` +
            `Telegram ID: \`${from.id}\`\n\n` +
            `Можно обработать заявку прямо здесь, в Telegram.`,
            {
              reply_markup: Markup.inlineKeyboard([
                [
                  Markup.button.callback('✅ Одобрить', `admin:user_status:${user.id}:approved:pending:0`),
                  Markup.button.callback('🚫 Заблокировать', `admin:user_status:${user.id}:blocked:pending:0`),
                ],
                [Markup.button.callback('👥 Открыть список заявок', 'admin:users:pending:0')],
              ]).reply_markup,
            },
          ).catch(() => {});
        }
      }

      const messages: Record<string, string> = {
        pending:  `⏳ *Ожидание подтверждения*\n\nЗапрос отправлен. Вы получите уведомление после одобрения.\n\nДоступные команды: /help`,
        approved: `✅ *Добро пожаловать!*\n\nВы подписаны на аналитические отчёты.\n\n/reports — меню отчётов\n/settings — ваши доступы\n/ask — задать вопрос по данным\n/help — все команды`,
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
      `📋 /reports — открыть меню отчётов\n` +
      `⚙️ /settings — посмотреть доступные отчёты\n` +
      `💬 /ask — задать вопрос по данным (ИИ ответит)\n` +
      `👤 /status — статус вашего аккаунта\n` +
      `/start — регистрация\n\n` +
      `Автоматические отчёты приходят по расписанию.`,
      { parse_mode: 'Markdown' },
    );
  });

  // /reports — show top-level reports menu
  instance.command('reports', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return;
    const keyboard = await buildTopReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Сейчас для вас нет доступных отчётов. Обратитесь к администратору.');
    await ctx.reply('📊 *Отчёты*\n\nВыберите раздел:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.command('settings', async (ctx) => {
    const [isAdmin, user] = await Promise.all([
      isTelegramAdmin(ctx.from!.id),
      getUser(ctx.from!.id),
    ]);

    if (isAdmin) {
      const { text, keyboard } = await buildSettingsHome(user?.status === 'approved' ? user.id : null);
      return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
    }

    const approvedUser = await requireApproved(ctx);
    if (!approvedUser) return;
    const { text, keyboard } = await buildSubscriptionsKeyboard(approvedUser.id);
    if (!keyboard) return ctx.reply(text, { parse_mode: 'Markdown' });
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('settings:home', async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isTelegramAdmin(ctx.from!.id))) return;
    const user = await getUser(ctx.from!.id);
    const { text, keyboard } = await buildSettingsHome(user?.status === 'approved' ? user.id : null);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action('settings:subscriptions', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    const { text, keyboard } = await buildSubscriptionsKeyboard(user.id);
    if (!keyboard) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown' } as any).catch(() => {});
      return;
    }
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action(/^admin:users:(pending|approved|blocked|deleted|all):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isTelegramAdmin(ctx.from!.id))) return;
    const filter = ctx.match[1] as AdminUserFilter;
    const page = Number(ctx.match[2]);
    const { text, keyboard } = await buildAdminUsersKeyboard(filter, page);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action(/^admin:user:([^:]+):(pending|approved|blocked|deleted|all):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isTelegramAdmin(ctx.from!.id))) return;
    const userId = ctx.match[1];
    const filter = ctx.match[2] as AdminUserFilter;
    const page = Number(ctx.match[3]);
    await renderAdminUserDetails(ctx, userId, filter, page);
  });

  instance.action(/^admin:user_status:([^:]+):(approved|blocked|deleted):(pending|approved|blocked|deleted|all):(\d+)$/, async (ctx) => {
    if (!(await isTelegramAdmin(ctx.from!.id))) {
      await ctx.answerCbQuery('Недостаточно прав.');
      return;
    }

    const userId = ctx.match[1];
    const nextStatus = ctx.match[2] as 'approved' | 'blocked' | 'deleted';
    const filter = ctx.match[3] as AdminUserFilter;
    const page = Number(ctx.match[4]);
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      await ctx.answerCbQuery('Пользователь не найден.');
      return;
    }

    const allowedTransitions: Record<string, string[]> = {
      pending: ['approved', 'deleted', 'blocked'],
      approved: ['blocked', 'deleted'],
      blocked: ['approved', 'deleted'],
      deleted: [],
    };
    if (!(allowedTransitions[user.status] || []).includes(nextStatus)) {
      await ctx.answerCbQuery('Недопустимый переход статуса.');
      return;
    }

    const updated = await prisma.user.update({ where: { id: userId }, data: { status: nextStatus as any } });
    await writeAuditLog({
      actorType: 'bot',
      action: `user.${nextStatus}.via_telegram`,
      entityType: 'user',
      entityId: userId,
      beforeState: { status: user.status },
      afterState: { status: nextStatus, adminTelegramId: String(ctx.from!.id) },
    });

    const messages: Record<string, string> = {
      approved: '✅ Ваш аккаунт одобрен. Теперь доступны /reports, /settings и /ask.',
      blocked: '🚫 Ваша заявка отклонена или аккаунт заблокирован. При необходимости свяжитесь с администратором.',
      deleted: '❌ Ваша заявка была отклонена. При необходимости свяжитесь с администратором и отправьте /start повторно.',
    };
    await sendTelegramMessageSafe(Number(updated.telegramId), messages[nextStatus]).catch(() => {});

    await ctx.answerCbQuery(`Статус: ${formatUserStatusLabel(nextStatus)}`);
    await renderAdminUserDetails(ctx, userId, filter, page);
  });

  instance.action(/^admin:user_reports:([^:]+):(on|off):(pending|approved|blocked|deleted|all):(\d+)$/, async (ctx) => {
    if (!(await isTelegramAdmin(ctx.from!.id))) {
      await ctx.answerCbQuery('Недостаточно прав.');
      return;
    }

    const userId = ctx.match[1];
    const mode = ctx.match[2];
    const filter = ctx.match[3] as AdminUserFilter;
    const page = Number(ctx.match[4]);
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      await ctx.answerCbQuery('Пользователь не найден.');
      return;
    }

    const globalReportsEnabled = mode === 'on';
    await prisma.user.update({ where: { id: userId }, data: { globalReportsEnabled } });
    await writeAuditLog({
      actorType: 'bot',
      action: 'user.reports.updated.via_telegram',
      entityType: 'user',
      entityId: userId,
      beforeState: { globalReportsEnabled: user.globalReportsEnabled },
      afterState: { globalReportsEnabled, adminTelegramId: String(ctx.from!.id) },
    });

    await sendTelegramMessageSafe(
      Number(user.telegramId),
      globalReportsEnabled
        ? '🔔 Администратор включил для вас регулярные отчёты.'
        : '🔕 Администратор отключил для вас регулярные отчёты.',
    ).catch(() => {});

    await ctx.answerCbQuery(globalReportsEnabled ? 'Отчёты включены' : 'Отчёты выключены');
    await renderAdminUserDetails(ctx, userId, filter, page);
  });

  instance.action(/^sub:(.+)$/, async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    const scheduleId = ctx.match[1];
    const subscribableSchedules = await getSubscribableSchedules(user.id);
    if (!subscribableSchedules.some((schedule) => schedule.id === scheduleId)) {
      await ctx.answerCbQuery('Эта подписка вам недоступна.');
      return;
    }

    const existing = await prisma.userSchedulePreference.findUnique({
      where: { userId_scheduleId: { userId: user.id, scheduleId } },
    });

    if (existing?.enabled) {
      await prisma.userSchedulePreference.delete({
        where: { userId_scheduleId: { userId: user.id, scheduleId } },
      });
      const { text, keyboard } = await buildSubscriptionsKeyboard(user.id);
      if (keyboard) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
      }
      await ctx.answerCbQuery('Подписка отключена');
      return;
    }

    await prisma.userSchedulePreference.upsert({
      where: { userId_scheduleId: { userId: user.id, scheduleId } },
      create: { userId: user.id, scheduleId, enabled: true },
      update: { enabled: true },
    });

    const { text, keyboard } = await buildSubscriptionsKeyboard(user.id);
    if (keyboard) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
    }
    await ctx.answerCbQuery('Подписка включена');
  });

  instance.action('reports:home', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildTopReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Сейчас для вас нет доступных отчётов. Обратитесь к администратору.');
    await editOrReply(ctx, '📊 *Отчёты*\n\nВыберите раздел:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('reports:orders', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildOrdersReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Orders.');
    await editOrReply(ctx, '📦 *Orders*\n\nВыберите категорию:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('orders:sales', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildOrdersSalesMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Sales.');
    await editOrReply(ctx, '📈 *Orders / Sales*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('orders:comments', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildOrdersCommentsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Comments.');
    await editOrReply(ctx, '💬 *Orders / Comments*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('orders:payments', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildOrdersPaymentsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Payments.');
    await editOrReply(ctx, '💳 *Orders / Payments*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('orders:agents', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildOrdersAgentsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Agents activity.');
    await editOrReply(ctx, '🧑‍💼 *Orders / Agents activity*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action('orders:networks', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildOrdersNetworksMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Network sales.');
    await editOrReply(ctx, '🌐 *Orders / Network sales*\n\nВыберите сеть или общий отчёт:', { parse_mode: 'Markdown', ...keyboard });
  });

  instance.action(/^orders:network:(general|poikhaly_z_namy|tours_tickets|na_kanikuly|kho|hottur)$/, async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const networkKey = ctx.match[1] as 'general' | GtoNetworkKey;
    const keyboard = await buildOrdersNetworkPeriodMenu(user.id, networkKey);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Network sales.');
    const label = GTO_NETWORK_MENU_ITEMS.find((item) => item.key === networkKey)?.label || 'Network';
    await ctx.editMessageText(`🌐 *Orders / Network sales / ${label}*\n\nВыберите период:`, { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action('reports:redmine', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildRedmineReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Redmine.');
    await ctx.editMessageText('🐞 *Redmine*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action('reports:youtrack', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildYoutrackReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Youtrack.');
    await ctx.editMessageText('🎯 *Youtrack*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action(/^custom:sales:(sales|payments|agents)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;

    const mode = ctx.match[1];
    if (mode === 'sales') {
      if (!(await ensureSourceAccess(ctx, user.id, ['gto']))) return;
      if (!(await hasAnyManualReportAccess(user.id, ['sales.yesterday', 'sales.today']))) {
        return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
      if (!schedule) return ctx.reply('Daily Sales Report не найден.');
      const timezone = await getSourceTimezone(schedule.source.id);
      await beginCustomPeriodSelection(ctx, timezone, 'GTO Sales: произвольный период', {
        kind: 'sales',
        accessKeys: ['sales.yesterday', 'sales.today'],
      });
      return;
    }

    if (mode === 'payments') {
      if (!(await ensureSourceAccess(ctx, user.id, ['gto']))) return;
      if (!(await hasAnyManualReportAccess(user.id, ['sales.payments_yesterday', 'sales.payments_today']))) {
        return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
      if (!schedule) return ctx.reply('Daily Sales Report не найден.');
      const timezone = await getSourceTimezone(schedule.source.id);
      await beginCustomPeriodSelection(ctx, timezone, 'GTO Payments: произвольный период', {
        kind: 'payments',
        accessKeys: ['sales.payments_yesterday', 'sales.payments_today'],
      });
      return;
    }

    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.agents'))) return;
    const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
    if (!schedule) return ctx.reply('Daily Sales Report не найден.');
    const timezone = await getSourceTimezone(schedule.source.id);
    await beginCustomPeriodSelection(ctx, timezone, 'GTO Agents: произвольный период', {
      kind: 'agents',
      accessKeys: ['sales.agents'],
    });
  });

  instance.action(/^custom:sales:network:(general|poikhaly_z_namy|tours_tickets|na_kanikuly|kho|hottur)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], GTO_NETWORK_ACCESS_KEY))) return;

    const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
    if (!schedule) return ctx.reply('Daily Sales Report не найден.');
    const timezone = await getSourceTimezone(schedule.source.id);
    const networkKey = ctx.match[1] as 'general' | GtoNetworkKey;
    const networkLabel = GTO_NETWORK_MENU_ITEMS.find((item) => item.key === networkKey)?.label || 'Network';
    await beginCustomPeriodSelection(ctx, timezone, `GTO Network Sales / ${networkLabel}: произвольный период`, {
      kind: 'network_sales',
      accessKeys: [GTO_NETWORK_ACCESS_KEY],
      networkKey,
      networkLabel,
    });
  });

  instance.action(/^custom:schedule:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;

    const scheduleId = ctx.match[1];
    const schedule = await prisma.reportSchedule.findUnique({
      where: { id: scheduleId },
      include: { source: { select: { name: true, type: true, id: true } } },
    });
    if (!schedule) return ctx.reply('Расписание не найдено.');
    if (!(await ensureScheduleSourceAccess(ctx, user.id, scheduleId))) return;

    let accessKey = makeScheduleRunReportKey(scheduleId);
    if (String(schedule.source.type) === 'redmine') {
      const candidateKeys = ['redmine.hours.24', 'redmine.hours.48', 'redmine.hours.168'];
      accessKey = '';
      for (const key of candidateKeys) {
        if (await hasManualReportAccess(user.id, key)) {
          accessKey = key;
          break;
        }
      }
      if (!accessKey) return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    } else if (!(await hasManualReportAccess(user.id, accessKey))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }

    const timezone = await getSourceTimezone(schedule.source.id);
    await beginCustomPeriodSelection(ctx, timezone, `${schedule.name}: произвольный период`, {
      kind: 'schedule',
      scheduleId,
      scheduleName: schedule.name,
      accessKey,
    });
  });

  instance.action(/^cal:(prev|next|reset|apply|cancel|noop)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = sessions.get(ctx.from!.id);
    if (!session || session.step !== 'waiting_custom_period') return;

    if (ctx.match[1] === 'noop') return;
    if (ctx.match[1] === 'cancel') {
      sessions.delete(ctx.from!.id);
      await ctx.editMessageText('Ок, отменил выбор периода.').catch(() => {});
      return;
    }
    if (ctx.match[1] === 'reset') {
      session.startYmd = null;
      session.endYmd = null;
      await renderCustomPeriodCalendar(ctx, session);
      return;
    }
    if (ctx.match[1] === 'apply') {
      const user = await requireApproved(ctx);
      if (!user) return;
      await executeCustomPeriodSelection(ctx, user.id, session);
      return;
    }

    const shifted = shiftCalendarMonth(session.displayedYear, session.displayedMonth, ctx.match[1] === 'prev' ? -1 : 1);
    const displayedFirstYmd = formatYmd(shifted.year, shifted.month, 1);
    if (compareYmd(displayedFirstYmd, session.maxYmd) > 0) return;
    session.displayedYear = shifted.year;
    session.displayedMonth = shifted.month;
    await renderCustomPeriodCalendar(ctx, session);
  });

  instance.action(/^cal:pick:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = sessions.get(ctx.from!.id);
    if (!session || session.step !== 'waiting_custom_period') return;

    const pickedYmd = ctx.match[1];
    if (compareYmd(pickedYmd, session.maxYmd) > 0) return;

    if (!session.startYmd || (session.startYmd && session.endYmd)) {
      session.startYmd = pickedYmd;
      session.endYmd = null;
    } else if (compareYmd(pickedYmd, session.startYmd) < 0) {
      session.endYmd = session.startYmd;
      session.startYmd = pickedYmd;
    } else {
      session.endYmd = pickedYmd;
    }

    await renderCustomPeriodCalendar(ctx, session);
  });

  // Callback: open separate summer sales outlook from Sales submenu
  instance.action('gen:sales:summer', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.summer'))) return;

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

  instance.action('gen:sales:today', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.today'))) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Today Sales Report*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoTodayReport({ telegramUserId: user.id });
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
      logger.error({ err }, 'Today sales report failed');
      await ctx.reply(`❌ Ошибка генерации today-отчёта: ${err.message}`);
    }
  });

  instance.action('gen:sales:last7', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await hasAnyManualReportAccess(user.id, ['sales.yesterday', 'sales.today']))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }
    if (!(await ensureSourceAccess(ctx, user.id, ['gto']))) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Sales Last 7 Days*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoSalesPresetReport('last7', { telegramUserId: user.id });
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
      logger.error({ err }, 'Last 7 days sales report failed');
      await ctx.reply(`❌ Ошибка генерации 7-day sales-отчёта: ${err.message}`);
    }
  });

  instance.action(/^gen:sales:network:(general|poikhaly_z_namy|tours_tickets|na_kanikuly|kho|hottur):(7d|30d)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], GTO_NETWORK_ACCESS_KEY))) return;

    const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
    if (!schedule) return ctx.reply('Daily Sales Report не найден.');
    const networkKey = ctx.match[1] as 'general' | GtoNetworkKey;
    const periodKey = ctx.match[2] as '7d' | '30d';
    const days = periodKey === '30d' ? 30 : 7;
    const label = GTO_NETWORK_MENU_ITEMS.find((item) => item.key === networkKey)?.label || 'Network';
    const period = await resolveRollingDaysPeriod(schedule.source.id, days);

    await ctx.editMessageText(
      `⏳ Готовлю *Network sales / ${label} / ${days} days*...\nЭто может занять до минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoNetworkSalesReport(networkKey, period.periodStart, period.periodEnd, { telegramUserId: user.id });
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
      logger.error({ err, networkKey, periodKey }, 'Network sales report failed');
      await ctx.reply(`❌ Ошибка генерации сетевого отчёта: ${err.message}`);
    }
  });

  instance.action('gen:sales:agents', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.agents'))) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Agent Activity Report*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoAgentActivityReport(undefined, { telegramUserId: user.id });
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
      logger.error({ err }, 'Agent activity report failed');
      await ctx.reply(`❌ Ошибка генерации отчёта по агентам: ${err.message}`);
    }
  });

  instance.action('gen:sales:agents_today', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.agents'))) return;

    const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
    if (!schedule) return ctx.reply('Daily Sales Report не найден.');
    const period = await resolvePresetPeriod(schedule.source.id, 'today');

    await ctx.editMessageText(
      '⏳ Готовлю *Agent Activity Today*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoAgentActivityReport(period, { telegramUserId: user.id });
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
      logger.error({ err }, 'Today agent activity report failed');
      await ctx.reply(`❌ Ошибка генерации today-отчёта по агентам: ${err.message}`);
    }
  });

  instance.action('gen:sales:agents_yesterday', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.agents'))) return;

    const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
    if (!schedule) return ctx.reply('Daily Sales Report не найден.');
    const period = await resolvePresetPeriod(schedule.source.id, 'yesterday');

    await ctx.editMessageText(
      '⏳ Готовлю *Agent Activity Yesterday*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoAgentActivityReport(period, { telegramUserId: user.id });
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
      logger.error({ err }, 'Yesterday agent activity report failed');
      await ctx.reply(`❌ Ошибка генерации yesterday-отчёта по агентам: ${err.message}`);
    }
  });

  instance.action('gen:sales:payments_today', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.payments_today'))) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Payments Today*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoPaymentsReport('today', { telegramUserId: user.id });
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
      logger.error({ err }, 'Today payments report failed');
      await ctx.reply(`❌ Ошибка генерации today-отчёта по оплатам: ${err.message}`);
    }
  });

  instance.action('gen:sales:payments_last7', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await hasAnyManualReportAccess(user.id, ['sales.payments_yesterday', 'sales.payments_today']))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }
    if (!(await ensureSourceAccess(ctx, user.id, ['gto']))) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Payments Last 7 Days*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoPaymentsPresetReport('last7', { telegramUserId: user.id });
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
      logger.error({ err }, 'Last 7 days payments report failed');
      await ctx.reply(`❌ Ошибка генерации 7-day отчёта по оплатам: ${err.message}`);
    }
  });

  instance.action('gen:sales:payments_yesterday', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.payments_yesterday'))) return;

    await ctx.editMessageText(
      '⏳ Готовлю *Payments Yesterday*...\nЭто может занять до минуты.',
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runGtoPaymentsReport('yesterday', { telegramUserId: user.id });
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
      logger.error({ err }, 'Yesterday payments report failed');
      await ctx.reply(`❌ Ошибка генерации yesterday-отчёта по оплатам: ${err.message}`);
    }
  });

  instance.action('gen:sales:daily', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    if (!(await ensureManualReportAccess(ctx, user.id, ['gto'], 'sales.yesterday'))) return;
    const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
    if (!schedule) return ctx.reply('Daily Sales Report не найден.');

    await ctx.editMessageText(
      `⏳ Генерирую отчёт *Yesterday*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runAnalysis(schedule.id, { telegramUserId: user.id });
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
      logger.error({ err, scheduleId: schedule.id }, 'On-demand sales daily analysis failed');
      await ctx.reply(`❌ Ошибка генерации: ${err.message}`);
    }
  });

  // /generate — legacy shortcut to the reports menu
  instance.command('generate', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return;
    const keyboard = await buildTopReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Сейчас для вас нет доступных отчётов. Обратитесь к администратору.');
    await ctx.reply('📊 *Отчёты*\n\nВыберите раздел:', { parse_mode: 'Markdown', ...keyboard });
  });

  // Callback: generate selected report from Comments / Youtrack menus
  instance.action(/^gen:(comments|youtrack):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;
    const scheduleId = ctx.match[2];

    const schedule = await prisma.reportSchedule.findUnique({
      where: { id: scheduleId },
      include: { source: { select: { name: true } } },
    });
    if (!schedule) return ctx.reply('Расписание не найдено.');
    if (!(await ensureScheduleSourceAccess(ctx, user.id, scheduleId))) return;
    if (!(await hasManualReportAccess(user.id, makeScheduleRunReportKey(scheduleId)))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }

    // Confirm and start
    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runAnalysis(scheduleId, { telegramUserId: user.id });
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

  instance.action(/^gen:comments_period:([^:]+):(today|yesterday|last7)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;

    const scheduleId = ctx.match[1];
    const preset = ctx.match[2] as 'today' | 'yesterday' | 'last7';
    const schedule = await prisma.reportSchedule.findUnique({
      where: { id: scheduleId },
      include: { source: { select: { id: true, name: true, type: true } } },
    });
    if (!schedule) return ctx.reply('Расписание не найдено.');
    if (!(await ensureScheduleSourceAccess(ctx, user.id, scheduleId))) return;
    if (!(await hasManualReportAccess(user.id, makeScheduleRunReportKey(scheduleId)))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }
    if (String(schedule.source.type) !== 'gto_comments') return ctx.reply('Этот режим доступен только для Comments.');

    const label = preset === 'last7' ? 'Last 7 days' : preset === 'today' ? 'Today' : 'Yesterday';
    const period = await resolvePresetPeriod(schedule.source.id, preset);

    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}* за период *${label}*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runAnalysisForPeriod(scheduleId, period.periodStart, period.periodEnd, { telegramUserId: user.id });
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
      logger.error({ err, scheduleId, preset }, 'On-demand comments preset analysis failed');
      await ctx.reply(`❌ Ошибка генерации: ${err.message}`);
    }
  });

  instance.action(/^gen:youtrack_hours:([^:]+):(24|48|168)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;

    const scheduleId = ctx.match[1];
    const hours = Number(ctx.match[2]);
    const schedule = await prisma.reportSchedule.findUnique({
      where: { id: scheduleId },
      include: { source: { select: { name: true, type: true } } },
    });
    if (!schedule) return ctx.reply('Расписание не найдено.');
    if (!(await ensureScheduleSourceAccess(ctx, user.id, scheduleId))) return;
    if (!(await hasManualReportAccess(user.id, makeScheduleHoursReportKey(scheduleId, hours)))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }
    if (String(schedule.source.type) !== 'youtrack_progress') return ctx.reply('Этот режим доступен только для YouTrack Daily Progress.');

    const label = hours === 168 ? '7 days' : `${hours} hours`;
    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}* за последние *${label}*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runRollingHoursAnalysis(scheduleId, hours, { telegramUserId: user.id });
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
      logger.error({ err, scheduleId, hours }, 'On-demand YouTrack rolling-hours analysis failed');
      await ctx.reply(`❌ Ошибка генерации: ${err.message}`);
    }
  });

  instance.action(/^gen:redmine_hours:([^:]+):(24|48|168)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const user = await requireApproved(ctx);
    if (!user) return;

    const scheduleId = ctx.match[1];
    const hours = Number(ctx.match[2]);
    const schedule = await prisma.reportSchedule.findUnique({
      where: { id: scheduleId },
      include: { source: { select: { name: true, type: true } } },
    });
    if (!schedule) return ctx.reply('Расписание не найдено.');
    if (!(await ensureScheduleSourceAccess(ctx, user.id, scheduleId))) return;
    if (!(await hasManualReportAccess(user.id, `redmine.hours.${hours}`))) {
      return ctx.reply('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
    }
    if (String(schedule.source.type) !== 'redmine') return ctx.reply('Этот режим доступен только для Redmine.');

    const label = hours === 168 ? '7 days' : `${hours} hours`;
    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}* за последние *${label}*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runRollingHoursAnalysis(scheduleId, hours, { telegramUserId: user.id });
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
      logger.error({ err, scheduleId, hours }, 'On-demand Redmine rolling-hours analysis failed');
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

    const user = await requireApproved(ctx);
    if (!user) return;

    if (text.trim().toLowerCase() === 'cancel' || text.trim().toLowerCase() === 'отмена') {
      sessions.delete(ctx.from!.id);
      await ctx.reply('Ок, отменил выбор периода.');
      return;
    }

    if (session.step === 'waiting_question') {
      const questionSession = session;
      sessions.delete(ctx.from!.id);
      const waitMsg = await ctx.reply(`🔍 Ищу ответ в данных *${questionSession.sourceName}*...`, { parse_mode: 'Markdown' });

      try {
        const answer = await runFreeQuery(questionSession.sourceId, text);
        await replySafe(ctx, answer, { disable_web_page_preview: true });
      } catch (err: any) {
        logger.error({ err, sourceId: questionSession.sourceId }, 'Free query failed');
        await ctx.reply(`❌ Ошибка: ${err.message}`);
      } finally {
        await ctx.telegram.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => {});
      }
      return;
    }

    await ctx.reply('Выберите даты кнопками в календаре выше. Текстом вводить период больше не нужно.');
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
    { command: 'reports',  description: 'Отчёты' },
    { command: 'settings', description: 'Настройки' },
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
