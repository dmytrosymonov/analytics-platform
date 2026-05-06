import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { createHttpClient } from '../lib/http';
import { CurrencyService } from '../lib/currency.service';
import { logger } from '../lib/logger';

const DEFAULT_BASE_URL = 'https://api.gto.ua/api/private';
const DEFAULT_V3_BASE_URL = 'https://api.gto.ua/api/v3';
const DEFAULT_TIMEZONE = 'Europe/Kyiv';
const DEFAULT_SYNC_CRON = '0 */2 * * *';
const DEFAULT_REFRESH_WINDOW_DAYS = 4;
const DETAIL_CONCURRENCY = 8;
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 500;

type JsonRecord = Record<string, any>;
type SyncMode = 'daily' | 'manual' | 'backfill';

type SyncParams = {
  mode: SyncMode;
  dateFrom: string;
  dateTo: string;
  triggeredBy?: string;
};

type SyncResult = {
  runId: string;
  mode: SyncMode;
  dateFrom: string;
  dateTo: string;
  fetchedOrderRows: number;
  fetchedUniqueOrderIds: number;
  syncedOrderRows: number;
  syncedLineRows: number;
  detailErrorRows: number;
  insertedOrderRows: number;
  insertedLineRows: number;
  deletedOrderRows: number;
  deletedLineRows: number;
  warnings: string[];
};

type GtoConfig = {
  apiKey: string;
  baseUrl: string;
  v3BaseUrl: string;
  timeoutMs: number;
};

type DetailEnvelope = {
  orderId: number;
  summary?: JsonRecord;
  detail?: JsonRecord;
  error?: string;
};

let schedulerStarted = false;
let syncInFlight = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: string, days: number): string {
  const next = parseIsoDate(date);
  next.setUTCDate(next.getUTCDate() + days);
  return toIsoDate(next);
}

function parseDateTime(value?: string | number | null): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseDateOnly(value?: string | number | null): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    return parseDateTime(value);
  }
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function normalizeLineStatus(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function isCancelledStatus(value?: string | null) {
  return normalizeLineStatus(value) === 'CNX';
}

function isActiveStatus(value?: string | null) {
  const status = normalizeLineStatus(value);
  return status !== 'CNX' && status !== '';
}

function extractBracketLabels(name: string): string[] {
  return [...String(name || '').matchAll(/\[([^\]]+)\]/g)]
    .map((match) => (match[1] || '').trim())
    .filter(Boolean);
}

function detectAgentNetwork(name?: string | null): string | null {
  const labels = extractBracketLabels(String(name || ''));
  for (const rawLabel of labels) {
    const normalized = rawLabel.toLocaleLowerCase('uk-UA');
    if (normalized.includes('поїхали з нами')) return 'Поїхали з нами';
    if (normalized.includes('tours&tickets')) return 'TOURS&TICKETS';
    if (normalized.includes('на канікули')) return 'На канікули';
    if (normalized.includes('хо')) return 'ХО';
    if (normalized.includes('хоттур')) return 'Хоттур';
  }
  return null;
}

function salesLeadDays(createdAt?: string | null, startDate?: string | null) {
  if (!createdAt || !startDate) return null;
  const created = String(createdAt).match(/(\d{4})-(\d{2})-(\d{2})/);
  const start = String(startDate).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!created || !start) return null;
  const createdUtc = Date.UTC(Number(created[1]), Number(created[2]) - 1, Number(created[3]));
  const startUtc = Date.UTC(Number(start[1]), Number(start[2]) - 1, Number(start[3]));
  return Math.round((startUtc - createdUtc) / 86400000);
}

function productGroupForService(row: JsonRecord): 'airticket' | 'transfer' | 'insurance' | 'other' {
  const rawType = String(row.type || '').toLowerCase();
  const serviceTypeName = String(row.service_type_name || '').toLowerCase();

  if (rawType === 'airticket') return 'airticket';
  if (rawType === 'transfer') return 'transfer';
  if (rawType === 'service' && serviceTypeName.includes('insurance')) return 'insurance';
  return 'other';
}

function extractDestinationRaw(line: JsonRecord, productGroup: string): string | null {
  if (productGroup === 'hotel') {
    const fullName = String(line.full_name || '');
    const match = fullName.match(/\[([^\]]+)\]/);
    if (match?.[1]) return match[1].trim();
    return String(line.hotel_name || '').trim() || null;
  }

  if (productGroup === 'transfer') {
    return String(line.point_to || line.point_from || '').trim() || null;
  }

  return null;
}

async function fetchWithRetry<T>(
  label: string,
  request: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request();
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status;
      if (attempt === retries || (status && status < 500 && status !== 429)) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn({ label, attempt: attempt + 1, retries, delay, err: error?.message }, 'Retrying GTO request');
      await sleep(delay);
    }
  }
  throw lastError;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getGtoConfig(): Promise<GtoConfig> {
  const source = await prisma.dataSource.findUnique({
    where: { type: 'gto' },
    include: { credentials: true, settings: true },
  });

  if (!source?.credentials) {
    throw new Error('GTO credentials are not configured in DataSource');
  }

  const credentials = JSON.parse(decrypt(source.credentials.encryptedPayload)) as {
    api_key?: string;
    base_url?: string;
  };

  if (!credentials.api_key) {
    throw new Error('GTO api_key is missing');
  }

  const settings = Object.fromEntries((source.settings || []).map((row) => [row.key, row.value]));

  return {
    apiKey: credentials.api_key,
    baseUrl: (credentials.base_url || DEFAULT_BASE_URL).replace(/\/$/, ''),
    v3BaseUrl: (settings.gto_v3_base_url || settings['gto.v3_base_url'] || DEFAULT_V3_BASE_URL).replace(/\/$/, ''),
    timeoutMs: Number(settings.request_timeout_seconds || 30) * 1000,
  };
}

async function fetchOrderListWindow(
  http: ReturnType<typeof createHttpClient>,
  dateFrom: string,
  dateTo: string,
): Promise<JsonRecord[]> {
  const perPage = 1000;
  const rows: JsonRecord[] = [];
  let page = 1;

  for (;;) {
    const resp = await fetchWithRetry(`orders_list:${dateFrom}:${dateTo}:page:${page}`, () =>
      http.get('/orders_list', {
        params: { date_from: dateFrom, date_to: dateTo, sort_by: 'created_at', per_page: perPage, page },
      }),
    );

    const body = resp.data;
    const pageRows = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : [];

    rows.push(...pageRows);
    logger.info({ page, pageRows: pageRows.length, total: rows.length, dateFrom, dateTo }, 'Fetched GTO orders_list page');

    if (pageRows.length < perPage) break;
    page += 1;
    if (page > 500) {
      throw new Error('orders_list exceeded 500 pages');
    }
  }

  return rows;
}

async function fetchOrderDetails(
  http: ReturnType<typeof createHttpClient>,
  summaries: JsonRecord[],
): Promise<DetailEnvelope[]> {
  const summaryById = new Map<number, JsonRecord>();
  for (const summary of summaries) {
    const orderId = Number(summary.order_id);
    if (Number.isFinite(orderId) && orderId > 0) {
      summaryById.set(orderId, summary);
    }
  }

  const orderIds = Array.from(summaryById.keys());
  return mapLimit(orderIds, DETAIL_CONCURRENCY, async (orderId, index) => {
    if (index > 0 && index % 100 === 0) {
      logger.info({ progress: `${index}/${orderIds.length}` }, 'Fetching GTO order_data');
    }

    try {
      const resp = await fetchWithRetry(`order_data:${orderId}`, () =>
        http.get('/order_data', { params: { order_id: orderId } }),
      );
      return {
        orderId,
        summary: summaryById.get(orderId),
        detail: resp.data?.data ?? resp.data,
      };
    } catch (error: any) {
      return {
        orderId,
        summary: summaryById.get(orderId),
        error: error?.message || String(error),
      };
    }
  });
}

function decimalValue(value: number | null): string | null {
  return value === null || value === undefined ? null : round2(value).toFixed(2);
}

async function buildReportingRows(
  details: DetailEnvelope[],
  config: GtoConfig,
) {
  const warnings: string[] = [];
  const successful = details.filter((row) => row.detail && !row.error);
  const failed = details.filter((row) => row.error);
  const rateCache = new Map<string, Awaited<ReturnType<typeof CurrencyService.getRatesForDate>>>();

  const getRatesForDate = async (date: string) => {
    const normalized = date.slice(0, 10);
    const cached = rateCache.get(normalized);
    if (cached) return cached;
    const rates = await CurrencyService.getRatesForDate(config.apiKey, config.v3BaseUrl, normalized);
    rateCache.set(normalized, rates);
    return rates;
  };

  const orderRows: any[] = [];
  const lineRows: any[] = [];

  for (const row of successful) {
    const detail = row.detail as JsonRecord;
    const summary = row.summary || {};
    const createdAtText = String(detail.created_at || summary.created_at || '');
    const bookingDate = createdAtText.slice(0, 10);
    const rates = bookingDate ? await getRatesForDate(bookingDate) : null;
    const toEur = (amount: number | null, currency?: string | null) => {
      if (amount === null || amount === undefined) return null;
      if (!rates) return round2(amount);
      return CurrencyService.toEur(amount, String(currency || 'EUR'), rates);
    };

    const hotelLines = Array.isArray(detail.hotel) ? detail.hotel : [];
    const serviceLines = Array.isArray(detail.service) ? detail.service : [];
    const allLines: Array<{ productGroup: string; raw: JsonRecord }> = [
      ...hotelLines.map((line: JsonRecord) => ({ productGroup: 'hotel', raw: line })),
      ...serviceLines.map((line: JsonRecord) => ({ productGroup: productGroupForService(line), raw: line })),
    ];

    const activeProductGroups = Array.from(new Set(
      allLines
        .filter(({ raw }) => isActiveStatus(raw.status))
        .map(({ productGroup }) => productGroup),
    ));

    const destinations = Array.from(new Set(
      allLines
        .map(({ productGroup, raw }) => extractDestinationRaw(raw, productGroup))
        .filter((value): value is string => Boolean(value)),
    ));

    const comments = Array.isArray(detail.comment) ? detail.comment : [];
    const urgentCommentCount = comments.filter((comment: any) => String(comment.type || '').toLowerCase() === 'urgent').length;
    const countries = Array.isArray(detail.country) ? detail.country : [];
    const suppliers = Array.isArray(detail.supplier) ? detail.supplier : [];

    const orderId = Number(detail.order_id || row.orderId);
    const totalAmountOriginal = parseAmount(detail.total_amount);
    const balanceAmountOriginal = parseAmount(detail.balance_amount);

    orderRows.push({
      orderId: BigInt(orderId),
      createdAt: parseDateTime(detail.created_at || summary.created_at) || new Date(),
      updatedAt: parseDateTime(detail.updated_at || summary.updated_at),
      confirmedAt: parseDateTime(detail.confirmed_at),
      dateStart: parseDateOnly(detail.date_start || summary.date_start),
      dateEnd: parseDateOnly(detail.date_end || summary.date_end),
      orderStatus: String(detail.status || summary.status || ''),
      orderStatusName: String(detail.status_name || summary.status_name || '') || null,
      creator: String(detail.creator || summary.creator || '') || null,
      agentId: String(detail.agent_id || '') || null,
      agentName: String(detail.agent_name || '') || null,
      agentNetwork: detectAgentNetwork(detail.agent_name) || null,
      agentReference: String(detail.agent_reference || '') || null,
      companyId: String(summary.company_id || '') || null,
      companyName: String(summary.company_name || '') || null,
      orderCurrency: String(detail.currency || '') || null,
      balanceCurrency: String(detail.balance_currency || '') || null,
      totalAmountOriginal: decimalValue(totalAmountOriginal),
      totalAmountEur: decimalValue(toEur(totalAmountOriginal, detail.currency)),
      balanceAmountOriginal: decimalValue(balanceAmountOriginal),
      balanceAmountEur: decimalValue(toEur(balanceAmountOriginal, detail.balance_currency || detail.currency)),
      bookingRateDate: bookingDate ? parseDateOnly(bookingDate) : null,
      touristsCount: Array.isArray(detail.tourist) ? detail.tourist.length : 0,
      countriesCount: countries.length,
      countryNames: countries.map((country: any) => country.name).filter(Boolean).join(' | ') || null,
      primaryCountryName: String(countries[0]?.name || '') || null,
      suppliersCount: suppliers.length,
      supplierNames: suppliers.map((supplier: any) => supplier.name).filter(Boolean).join(' | ') || null,
      destinationNames: destinations.join(' | ') || null,
      productGroups: activeProductGroups.join(' | ') || null,
      hasHotel: activeProductGroups.includes('hotel'),
      hasAirticket: activeProductGroups.includes('airticket'),
      hasTransfer: activeProductGroups.includes('transfer'),
      hasInsurance: activeProductGroups.includes('insurance'),
      hasOther: activeProductGroups.includes('other'),
      isPackage: activeProductGroups.length >= 2,
      hotelLinesCount: allLines.filter((line) => line.productGroup === 'hotel').length,
      airticketLinesCount: allLines.filter((line) => line.productGroup === 'airticket').length,
      transferLinesCount: allLines.filter((line) => line.productGroup === 'transfer').length,
      insuranceLinesCount: allLines.filter((line) => line.productGroup === 'insurance').length,
      otherLinesCount: allLines.filter((line) => line.productGroup === 'other').length,
      activeLinesCount: allLines.filter((line) => isActiveStatus(line.raw.status)).length,
      cancelledLinesCount: allLines.filter((line) => isCancelledStatus(line.raw.status)).length,
      commentCount: comments.length,
      urgentCommentCount,
      hasComments: comments.length > 0,
      salesLeadDays: salesLeadDays(detail.created_at || summary.created_at, detail.date_start || summary.date_start),
      syncedAt: new Date(),
    });

    for (const { productGroup, raw } of allLines) {
      const serviceId = String(raw.service_id || raw.id || `${productGroup}-${lineRows.length + 1}`);
      const lineId = `${orderId}:${productGroup}:${serviceId}`;
      const priceOriginal = parseAmount(raw.price);
      const priceBuyOriginal = parseAmount(raw.price_buy);
      const discountOriginal = parseAmount(raw.discount);

      lineRows.push({
        lineId,
        orderId: BigInt(orderId),
        productGroup,
        rawType: String(raw.type || '') || null,
        serviceTypeName: String(raw.service_type_name || '') || null,
        status: String(raw.status || '') || null,
        statusName: String(raw.status_name || '') || null,
        supplierId: String(raw.supplier_id || '') || null,
        supplierName: String(raw.supplier_name || '') || null,
        destinationRaw: extractDestinationRaw(raw, productGroup),
        dateFrom: parseDateOnly(raw.date_from),
        dateTo: parseDateOnly(raw.date_to),
        currency: String(raw.currency || '') || null,
        priceOriginal: decimalValue(priceOriginal),
        priceEur: decimalValue(toEur(priceOriginal, raw.currency)),
        priceBuyOriginal: decimalValue(priceBuyOriginal),
        priceBuyEur: decimalValue(toEur(priceBuyOriginal, raw.currency)),
        discountOriginal: decimalValue(discountOriginal),
        numberOfServices: Number.isFinite(Number(raw.number_of_services)) ? Number(raw.number_of_services) : null,
        hotelName: String(raw.hotel_name || '') || null,
        roomName: String(raw.room_name || '') || null,
        mealName: String(raw.meal_name || '') || null,
        accommodationName: String(raw.acc_name || '') || null,
        transferType: String(raw.transfer_type || '') || null,
        pointFrom: String(raw.point_from || '') || null,
        pointTo: String(raw.point_to || '') || null,
        syncedAt: new Date(),
      });
    }
  }

  if (failed.length > 0) {
    warnings.push(`Failed to refresh ${failed.length} orders in current sync window`);
  }

  return {
    orderRows,
    lineRows,
    failed,
    warnings,
  };
}

function chunk<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

async function replaceReportingRows(orderRows: any[], lineRows: any[]) {
  const orderIds = orderRows.map((row) => row.orderId);
  let deletedLineRows = 0;
  let deletedOrderRows = 0;
  let insertedOrderRows = 0;
  let insertedLineRows = 0;

  for (const ids of chunk(orderIds, DELETE_CHUNK)) {
    deletedLineRows += await (prisma as any).reportingGtoOrderLine.deleteMany({
      where: { orderId: { in: ids } },
    }).then((result: any) => result.count);

    deletedOrderRows += await (prisma as any).reportingGtoOrder.deleteMany({
      where: { orderId: { in: ids } },
    }).then((result: any) => result.count);
  }

  for (const rows of chunk(orderRows, INSERT_CHUNK)) {
    if (!rows.length) continue;
    insertedOrderRows += await (prisma as any).reportingGtoOrder.createMany({
      data: rows,
    }).then((result: any) => result.count);
  }

  for (const rows of chunk(lineRows, INSERT_CHUNK)) {
    if (!rows.length) continue;
    insertedLineRows += await (prisma as any).reportingGtoOrderLine.createMany({
      data: rows,
    }).then((result: any) => result.count);
  }

  return {
    deletedLineRows,
    deletedOrderRows,
    insertedOrderRows,
    insertedLineRows,
  };
}

function computeDailyWindow(timezone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = formatter.format(new Date());
  return {
    dateFrom: addDays(today, -(DEFAULT_REFRESH_WINDOW_DAYS - 1)),
    dateTo: today,
  };
}

export async function syncGtoLookerOrders(params: SyncParams): Promise<SyncResult> {
  if (syncInFlight) {
    throw new Error('GTO Looker sync is already running');
  }

  syncInFlight = true;
  const run = await (prisma as any).reportingGtoSyncRun.create({
    data: {
      mode: params.mode,
      status: 'running',
      windowDateFrom: parseDateOnly(params.dateFrom),
      windowDateTo: parseDateOnly(params.dateTo),
      triggeredBy: params.triggeredBy || null,
    },
  });

  try {
    const config = await getGtoConfig();
    const http = createHttpClient({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      params: { apikey: config.apiKey },
    }, 'gto-looker-sync');

    const summaries = await fetchOrderListWindow(http, params.dateFrom, params.dateTo);
    const details = await fetchOrderDetails(http, summaries);
    const { orderRows, lineRows, failed, warnings } = await buildReportingRows(details, config);
    const replaceStats = await replaceReportingRows(orderRows, lineRows);

    const result: SyncResult = {
      runId: run.id,
      mode: params.mode,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      fetchedOrderRows: summaries.length,
      fetchedUniqueOrderIds: new Set(summaries.map((row) => Number(row.order_id))).size,
      syncedOrderRows: orderRows.length,
      syncedLineRows: lineRows.length,
      detailErrorRows: failed.length,
      insertedOrderRows: replaceStats.insertedOrderRows,
      insertedLineRows: replaceStats.insertedLineRows,
      deletedOrderRows: replaceStats.deletedOrderRows,
      deletedLineRows: replaceStats.deletedLineRows,
      warnings,
    };

    await (prisma as any).reportingGtoSyncRun.update({
      where: { id: run.id },
      data: {
        status: 'success',
        finishedAt: new Date(),
        fetchedOrderRows: result.fetchedOrderRows,
        fetchedUniqueOrderIds: result.fetchedUniqueOrderIds,
        syncedOrderRows: result.syncedOrderRows,
        syncedLineRows: result.syncedLineRows,
        detailErrorRows: result.detailErrorRows,
        insertedOrderRows: result.insertedOrderRows,
        insertedLineRows: result.insertedLineRows,
        deletedOrderRows: result.deletedOrderRows,
        deletedLineRows: result.deletedLineRows,
        warnings: result.warnings,
        sourceSnapshotDateFrom: parseDateOnly(params.dateFrom),
        sourceSnapshotDateTo: parseDateOnly(params.dateTo),
      },
    });

    logger.info(result, 'GTO Looker sync completed');
    return result;
  } catch (error: any) {
    await (prisma as any).reportingGtoSyncRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: error?.message || String(error),
      },
    });
    logger.error({ err: error, runId: run.id }, 'GTO Looker sync failed');
    throw error;
  } finally {
    syncInFlight = false;
  }
}

export async function getGtoLookerSyncStatus() {
  const [lastRun, runs, ordersCount, linesCount] = await Promise.all([
    (prisma as any).reportingGtoSyncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    (prisma as any).reportingGtoSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
    (prisma as any).reportingGtoOrder.count(),
    (prisma as any).reportingGtoOrderLine.count(),
  ]);

  return {
    inFlight: syncInFlight,
    lastRun,
    recentRuns: runs,
    rowCounts: {
      orders: ordersCount,
      lines: linesCount,
    },
  };
}

export function startGtoLookerSyncScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  cron.schedule(
    DEFAULT_SYNC_CRON,
    async () => {
      const { dateFrom, dateTo } = computeDailyWindow(DEFAULT_TIMEZONE);
      try {
        await syncGtoLookerOrders({
          mode: 'daily',
          dateFrom,
          dateTo,
          triggeredBy: 'scheduler',
        });
      } catch (error: any) {
        logger.error({ err: error?.message || String(error), dateFrom, dateTo }, 'Scheduled GTO Looker sync failed');
      }
    },
    { timezone: DEFAULT_TIMEZONE },
  );

  logger.info({ cron: DEFAULT_SYNC_CRON, timezone: DEFAULT_TIMEZONE }, 'Scheduled GTO Looker sync');
}

export function getDailyLookerWindow() {
  return computeDailyWindow(DEFAULT_TIMEZONE);
}
