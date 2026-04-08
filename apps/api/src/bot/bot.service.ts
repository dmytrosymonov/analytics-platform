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
    };

const sessions = new Map<number, BotSession>();
type ScheduleWithSource = Prisma.ReportScheduleGetPayload<{ include: { source: true } }>;
type ScheduleWithSourceSummary = Prisma.ReportScheduleGetPayload<{ include: { source: { select: { id: true; name: true; type: true } } } }>;
type ManualReportAccessState = ReturnType<typeof listManualReportAccessDefinitions>[number] & { enabled: boolean };
type AdminManageableUser = Prisma.UserGetPayload<{}>;
type AdminUserFilter = 'pending' | 'approved' | 'blocked' | 'deleted' | 'all';
const prismaManualReportAccess = (prisma as any).userManualReportAccess as {
  findMany: (args: unknown) => Promise<Array<{ reportKey: string; enabled: boolean }>>;
  findUnique: (args: unknown) => Promise<{ reportKey: string; enabled: boolean } | null>;
};
const ADMIN_USER_PAGE_SIZE = 8;
const MAX_CUSTOM_PERIOD_DAYS = 31;

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

function shiftYmd(year: number, month: number, day: number, offsetDays: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function parseDateToken(input: string): { year: number; month: number; day: number } | null {
  const value = input.trim();
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
    return { year, month, day };
  }

  match = value.match(/^(\d{2})[./](\d{2})[./](\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function parseCustomPeriodInput(text: string, timezone: string): { periodStart: Date; periodEnd: Date; from: string; to: string } | { error: string } {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const rangeMatch = normalized.match(/^(\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2})(?:\s*(?:-|—|–)\s*(\d{2}[./]\d{2}[./]\d{4}|\d{4}-\d{2}-\d{2}))?$/);
  if (!rangeMatch) {
    return { error: 'Укажите одну дату или диапазон в формате `ДД.MM.ГГГГ - ДД.MM.ГГГГ`.' };
  }

  const start = parseDateToken(rangeMatch[1]);
  const end = parseDateToken(rangeMatch[2] || rangeMatch[1]);
  if (!start || !end) {
    return { error: 'Не удалось распознать дату. Используйте формат `ДД.MM.ГГГГ - ДД.MM.ГГГГ` или `YYYY-MM-DD - YYYY-MM-DD`.' };
  }

  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  if (endUtc < startUtc) {
    return { error: 'Дата окончания не может быть раньше даты начала.' };
  }

  const inclusiveDays = Math.round((endUtc - startUtc) / 86400000) + 1;
  if (inclusiveDays > MAX_CUSTOM_PERIOD_DAYS) {
    return { error: `Период слишком длинный. Сейчас поддерживается максимум ${MAX_CUSTOM_PERIOD_DAYS} день(дней).` };
  }

  const nextDay = shiftYmd(end.year, end.month, end.day, 1);
  return {
    periodStart: zonedDateTimeToUtc(timezone, start.year, start.month, start.day),
    periodEnd: zonedDateTimeToUtc(timezone, nextDay.year, nextDay.month, nextDay.day),
    from: `${String(start.year).padStart(4, '0')}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')}`,
    to: `${String(end.year).padStart(4, '0')}-${String(end.month).padStart(2, '0')}-${String(end.day).padStart(2, '0')}`,
  };
}

function buildCustomPeriodPrompt(reportLabel: string): string {
  return (
    `📅 *${reportLabel}*\n\n` +
    `Отправьте период одним сообщением.\n` +
    `Форматы:\n` +
    `• \`08.04.2026 - 10.04.2026\`\n` +
    `• \`2026-04-08 - 2026-04-10\`\n` +
    `• \`08.04.2026\` для одного дня\n\n` +
    `Максимальная длина периода: ${MAX_CUSTOM_PERIOD_DAYS} день(дней).\n` +
    `Напишите \`cancel\`, чтобы отменить.`
  );
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
  if (hasGto && manualReports.some((report) => report.sourceType === 'gto' && report.enabled)) {
    rows.push([Markup.button.callback('Sales', 'reports:sales')]);
  }
  if (hasComments && commentsSchedules.length > 0) {
    rows.push([Markup.button.callback('Comments', 'reports:comments')]);
  }
  if (hasRedmine && redmineSchedules.length > 0) {
    rows.push([Markup.button.callback('Redmine', 'reports:redmine')]);
  }
  if (hasYoutrack && youtrackSchedules.length > 0) {
    rows.push([Markup.button.callback('Youtrack', 'reports:youtrack')]);
  }

  if (rows.length === 0) return null;
  return Markup.inlineKeyboard(rows);
}

async function buildSalesReportsMenu(userId: string) {
  const [allowed, reports] = await Promise.all([
    hasSourceAccess(userId, ['gto']),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  const hasSalesAccess = reports.some((report) => ['sales.yesterday', 'sales.today'].includes(report.key) && report.enabled);
  const hasPaymentsAccess = reports.some((report) => ['sales.payments_yesterday', 'sales.payments_today'].includes(report.key) && report.enabled);
  if (reports.find((report) => report.key === 'sales.yesterday')?.enabled) {
    rows.push([Markup.button.callback('Yesterday', 'gen:sales:daily')]);
  }
  if (reports.find((report) => report.key === 'sales.today')?.enabled) {
    rows.push([Markup.button.callback('Today', 'gen:sales:today')]);
  }
  if (hasSalesAccess) {
    rows.push([Markup.button.callback('📅 Sales Period', 'custom:sales:sales')]);
  }
  if (reports.find((report) => report.key === 'sales.agents')?.enabled) {
    rows.push([Markup.button.callback('Agents 7 Days', 'gen:sales:agents')]);
    rows.push([Markup.button.callback('📅 Agents Period', 'custom:sales:agents')]);
  }
  if (reports.find((report) => report.key === 'sales.payments_yesterday')?.enabled) {
    rows.push([Markup.button.callback('Payments Yesterday', 'gen:sales:payments_yesterday')]);
  }
  if (reports.find((report) => report.key === 'sales.payments_today')?.enabled) {
    rows.push([Markup.button.callback('Payments Today', 'gen:sales:payments_today')]);
  }
  if (hasPaymentsAccess) {
    rows.push([Markup.button.callback('📅 Payments Period', 'custom:sales:payments')]);
  }
  if (reports.find((report) => report.key === 'sales.summer')?.enabled) {
    rows.push([Markup.button.callback('Summer', 'gen:sales:summer')]);
  }
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:home')]);
  return Markup.inlineKeyboard(rows);
}

async function buildScheduleCategoryMenu(userId: string, sourceTypes: string[], prefix: string) {
  const [allowed, schedules, manualReports] = await Promise.all([
    hasSourceAccess(userId, sourceTypes),
    getManualSchedulesBySourceTypes(sourceTypes),
    getUserManualReportAccess(userId),
  ]);
  if (!allowed) return null;
  const allowedSchedules = schedules.filter((schedule) =>
    manualReports.some((report) => report.key === makeScheduleRunReportKey(schedule.id) && report.enabled),
  );
  if (allowedSchedules.length === 0) return null;

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const schedule of allowedSchedules) {
    rows.push([
      Markup.button.callback(`${schedule.name} · ${schedule.source.name}`, `gen:${prefix}:${schedule.id}`),
      Markup.button.callback('📅 Period', `custom:schedule:${schedule.id}`),
    ]);
  }
  rows.push([Markup.button.callback('← Back', 'reports:home')]);
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

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const schedule of schedules) {
    if (manualReports.some((report) => report.key === makeScheduleRunReportKey(schedule.id) && report.enabled)) {
      rows.push([
        Markup.button.callback(`${schedule.name} · ${schedule.source.name}`, `gen:youtrack:${schedule.id}`),
        Markup.button.callback('📅 Period', `custom:schedule:${schedule.id}`),
      ]);
    }
    if (String(schedule.source.type) === 'youtrack_progress') {
      const hourButtons = [24, 48, 72]
        .filter((hours) => manualReports.some((report) => report.key === makeScheduleHoursReportKey(schedule.id, hours) && report.enabled))
        .map((hours) => Markup.button.callback(`${hours}h`, `gen:youtrack_hours:${schedule.id}:${hours}`));
      if (hourButtons.length > 0) {
        rows.push(hourButtons);
      }
    }
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

  const topRow = [24, 48]
    .filter((hours) => manualReports.some((report) => report.key === `redmine.hours.${hours}` && report.enabled))
    .map((hours) => Markup.button.callback(`${hours}h`, `gen:redmine_hours:${preferredSchedule.id}:${hours}`));
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (topRow.length > 0) rows.push(topRow);
  if (manualReports.some((report) => report.key === 'redmine.hours.168' && report.enabled)) {
    rows.push([Markup.button.callback('7 days', `gen:redmine_hours:${preferredSchedule.id}:168`)]);
  }
  if (manualReports.some((report) => ['redmine.hours.24', 'redmine.hours.48', 'redmine.hours.168'].includes(report.key) && report.enabled)) {
    rows.push([Markup.button.callback('📅 Custom Period', `custom:schedule:${preferredSchedule.id}`)]);
  }
  if (rows.length === 0) return null;
  rows.push([Markup.button.callback('← Back', 'reports:home')]);

  return Markup.inlineKeyboard(rows);
}

async function runStoredAnalysis(
  scheduleId: string,
  periodOverride?: { periodStart: Date; periodEnd: Date },
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
async function runAnalysis(scheduleId: string): Promise<{ runId: string; resultId: string; message: string }> {
  return runStoredAnalysis(scheduleId);
}

async function runAnalysisForPeriod(
  scheduleId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ runId: string; resultId: string; message: string }> {
  return runStoredAnalysis(scheduleId, { periodStart, periodEnd });
}

async function runRollingHoursAnalysis(scheduleId: string, hours: number): Promise<{ runId: string; resultId: string; message: string }> {
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
  const run = await prisma.reportRun.create({
    data: {
      scheduleId: schedule.id,
      periodStart,
      periodEnd,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date(),
    },
  });

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

async function runGtoPaymentsReport(mode: 'today' | 'yesterday'): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const timezone = await getSourceTimezone(schedule.source.id);
  const period = mode === 'today' ? computeCurrentDayPeriod(timezone) : computePeriod('daily', timezone);
  const dateStr = period.periodStart.toLocaleDateString('sv-SE', { timeZone: timezone });
  const periodLabel = formatPeriodLabel(dateStr, dateStr);

  const run = await prisma.reportRun.create({
    data: {
      scheduleId: schedule.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date(),
    },
  });

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
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const timezone = await getSourceTimezone(schedule.source.id);
  const fromDate = periodStart.toLocaleDateString('sv-SE', { timeZone: timezone });
  const toDate = new Date(periodEnd.getTime() - 1).toLocaleDateString('sv-SE', { timeZone: timezone });
  const periodLabel = formatPeriodLabel(fromDate, toDate);

  const run = await prisma.reportRun.create({
    data: {
      scheduleId: schedule.id,
      periodStart,
      periodEnd,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date(),
    },
  });

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

async function runGtoTodayReport(): Promise<{ runId: string; resultId: string; message: string }> {
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
  const run = await prisma.reportRun.create({
    data: {
      scheduleId: schedule.id,
      periodStart,
      periodEnd,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date(),
    },
  });

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
): Promise<{ runId: string; resultId: string; message: string }> {
  const schedule = await getScheduleBySourceTypeAndPeriod('gto', 'daily');
  if (!schedule) throw new Error('Расписание Daily Sales Report не найдено');

  const credRecord = await prisma.sourceCredential.findUnique({ where: { sourceId: schedule.source.id } });
  if (!credRecord) throw new Error('Учётные данные GTO не настроены');

  const credentials = JSON.parse(decrypt(credRecord.encryptedPayload)) as Record<string, unknown>;
  const settingRows = await prisma.sourceSetting.findMany({ where: { sourceId: schedule.source.id } });
  const settings: Record<string, string> = {};
  settingRows.forEach((s) => { settings[s.key] = s.value; });

  const run = await prisma.reportRun.create({
    data: {
      scheduleId: schedule.id,
      periodStart,
      periodEnd,
      status: 'running',
      triggerType: 'manual',
      startedAt: new Date(),
    },
  });

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
  sessions.set(ctx.from!.id, {
    step: 'waiting_custom_period',
    timezone,
    reportLabel,
    target,
  });

  await ctx.editMessageText(
    buildCustomPeriodPrompt(reportLabel),
    { parse_mode: 'Markdown' },
  ).catch(async () => {
    await ctx.reply(buildCustomPeriodPrompt(reportLabel), { parse_mode: 'Markdown' });
  });
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
    await ctx.editMessageText('📊 *Отчёты*\n\nВыберите раздел:', { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action('reports:sales', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildSalesReportsMenu(user.id);
    if (!keyboard) return ctx.reply('Нет доступных отчётов Sales.');
    await ctx.editMessageText('📊 *Sales*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
  });

  instance.action('reports:comments', async (ctx) => {
    const user = await requireApproved(ctx);
    if (!user) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const keyboard = await buildScheduleCategoryMenu(user.id, ['gto_comments'], 'comments');
    if (!keyboard) return ctx.reply('Нет доступных отчётов Comments.');
    await ctx.editMessageText('💬 *Comments*\n\nВыберите отчёт:', { parse_mode: 'Markdown', ...keyboard } as any).catch(() => {});
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
    await beginCustomPeriodSelection(ctx, timezone, `${schedule.source.name}: произвольный период`, {
      kind: 'schedule',
      scheduleId,
      scheduleName: schedule.source.name,
      accessKey,
    });
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
      const result = await runGtoTodayReport();
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
      const result = await runGtoAgentActivityReport();
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
      const result = await runGtoPaymentsReport('today');
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
      const result = await runGtoPaymentsReport('yesterday');
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
      const result = await runAnalysis(schedule.id);
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

  instance.action(/^gen:youtrack_hours:([^:]+):(24|48|72)$/, async (ctx) => {
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

    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}* за последние *${hours}h*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runRollingHoursAnalysis(scheduleId, hours);
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

    const label = hours === 168 ? '7 days' : `${hours}h`;
    await ctx.editMessageText(
      `⏳ Генерирую отчёт *${schedule.source.name}* за последние *${label}*...\nЭто может занять 1–2 минуты.`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});

    try {
      const result = await runRollingHoursAnalysis(scheduleId, hours);
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

    const parsed = parseCustomPeriodInput(text, session.timezone);
    if ('error' in parsed) {
      await ctx.reply(`${parsed.error}\n\n${buildCustomPeriodPrompt(session.reportLabel)}`, { parse_mode: 'Markdown' });
      return;
    }

    sessions.delete(ctx.from!.id);
    const label = formatPeriodLabel(parsed.from, parsed.to);
    const waitMsg = await ctx.reply(`⏳ Готовлю *${session.reportLabel}* за период *${label}*...`, { parse_mode: 'Markdown' });

    try {
      if (session.target.kind === 'sales') {
        if (!(await hasAnyManualReportAccess(user.id, session.target.accessKeys))) {
          throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
        }
        const result = await runGtoSalesPeriodReport(parsed.periodStart, parsed.periodEnd);
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
        return;
      }

      if (session.target.kind === 'payments') {
        if (!(await hasAnyManualReportAccess(user.id, session.target.accessKeys))) {
          throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
        }
        const result = await runGtoPaymentsReportForPeriod(parsed.periodStart, parsed.periodEnd);
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
        return;
      }

      if (session.target.kind === 'agents') {
        if (!(await hasAnyManualReportAccess(user.id, session.target.accessKeys))) {
          throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
        }
        const result = await runGtoAgentActivityReport({
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
        });
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
        return;
      }

      if (!(await hasManualReportAccess(user.id, session.target.accessKey))) {
        throw new Error('У вас нет доступа к этому отчёту. Обратитесь к администратору.');
      }
      const result = await runAnalysisForPeriod(session.target.scheduleId, parsed.periodStart, parsed.periodEnd);
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
      logger.error({ err, session }, 'Custom period generation failed');
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
