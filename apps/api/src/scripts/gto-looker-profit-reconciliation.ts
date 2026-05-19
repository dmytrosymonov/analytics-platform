import XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { decrypt } from '../lib/encryption';
import { CurrencyService } from '../lib/currency.service';

type ExcelRow = {
  orderId: number;
  status: string;
  numberOfPax: number;
  structure: string;
  createdAt: Date | null;
  commissionOriginal: number;
  commissionCurrency: string;
  flightCostOriginal: number;
};

type ReportingOrderRow = {
  orderId: bigint;
  orderStatus: string;
  createdAt: Date;
  touristsCount: number;
  totalAmountEur: any;
  profitEur: any;
  accountingClass: string | null;
  profitBasisUsed: string | null;
  hasIncompleteCoreCost: boolean;
  hasOrderDestination: boolean;
};

type ReportingLineRow = {
  orderId: bigint;
  productGroup: string;
  status: string | null;
  currency: string | null;
  currencyBuy: string | null;
  priceBuyOriginal: any;
};

type ReconciliationBucket =
  | 'incomplete_core_cost'
  | 'airticket_amount_details_basis'
  | 'package_revenue_basis'
  | 'hotel_no_flight_margin_mismatch'
  | 'currency_label_issue'
  | 'ancillary_cost_issue'
  | 'unknown_manual_logic';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseAmount(value: unknown) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim();
  if (!text) return 0;
  const normalized = text.replace(/\s+/g, '').replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0));
  }
  const text = String(value).trim();
  if (!text) return null;
  const ddmmyy = text.match(/^(\d{2})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
  if (ddmmyy) {
    const year = 2000 + Number(ddmmyy[3]);
    return new Date(Date.UTC(
      year,
      Number(ddmmyy[2]) - 1,
      Number(ddmmyy[1]),
      Number(ddmmyy[4] || 0),
      Number(ddmmyy[5] || 0),
    ));
  }
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function decimalToNumber(value: unknown) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseAmount(value);
  if (typeof value === 'object' && value && 'toNumber' in value && typeof (value as any).toNumber === 'function') {
    return (value as any).toNumber();
  }
  return parseAmount(value);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function toIsoDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

async function getGtoConfig() {
  const source = await prisma.dataSource.findUnique({
    where: { type: 'gto' },
    include: { credentials: true, settings: true },
  });

  if (!source?.credentials) throw new Error('GTO credentials are not configured in DataSource');

  const credentials = JSON.parse(decrypt(source.credentials.encryptedPayload)) as { api_key?: string };
  if (!credentials.api_key) throw new Error('GTO api_key is missing');

  const settings = Object.fromEntries((source.settings || []).map((row) => [row.key, row.value]));
  return {
    apiKey: credentials.api_key,
    v3BaseUrl: (settings.gto_v3_base_url || settings['gto.v3_base_url'] || 'https://api.gto.ua/api/v3').replace(/\/$/, ''),
  };
}

function loadExcelRows(xlsxPath: string): ExcelRow[] {
  const workbook = XLSX.readFile(xlsxPath, { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  return rows
    .map((row) => ({
      orderId: Number(row['Order Id']),
      status: String(row['Status'] || '').trim().toUpperCase(),
      numberOfPax: Number(row['Number of pax'] || 0),
      structure: String(row['Structure'] || '').trim(),
      createdAt: parseDate(row['Created at']),
      commissionOriginal: parseAmount(row['Commission/Discount']),
      commissionCurrency: String(row['Commission/Discount Currency'] || '').trim().toUpperCase(),
      flightCostOriginal: parseAmount(row['Flight cost']),
    }))
    .filter((row) => Number.isFinite(row.orderId) && row.orderId > 0);
}

function classifyBucket(order: ReportingOrderRow | undefined, lines: ReportingLineRow[], excelRow: ExcelRow): ReconciliationBucket {
  if (order?.hasIncompleteCoreCost) return 'incomplete_core_cost';
  if (order?.accountingClass === 'airticket_only' && order?.profitBasisUsed === 'amount_details_net_basis') {
    return 'airticket_amount_details_basis';
  }
  if (lines.some((line) => ['CNF', 'PEN'].includes(String(line.status || '').toUpperCase())
    && line.productGroup === 'other'
    && decimalToNumber(line.priceBuyOriginal) > 0)) {
    return 'ancillary_cost_issue';
  }
  if (order?.accountingClass === 'package_with_flight' || order?.accountingClass === 'combi_with_flight') {
    return 'package_revenue_basis';
  }
  if (order?.accountingClass === 'hotel_only_or_hotel_led' && excelRow.flightCostOriginal <= 0) {
    return 'hotel_no_flight_margin_mismatch';
  }
  if (lines.some((line) => {
    const currency = String(line.currency || '').trim().toUpperCase();
    const currencyBuy = String(line.currencyBuy || '').trim().toUpperCase();
    return currency && currencyBuy && currency !== currencyBuy;
  })) {
    return 'currency_label_issue';
  }
  return 'unknown_manual_logic';
}

async function main() {
  const xlsxPath = readArg('xlsx');
  const thresholdPct = Number(readArg('threshold-pct') || 10);
  const dateFromArg = readArg('from');
  const dateToArg = readArg('to');

  if (!xlsxPath) {
    throw new Error('Usage: tsx src/scripts/gto-looker-profit-reconciliation.ts --xlsx=/path/to/file.xlsx [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--threshold-pct=10]');
  }

  const allExcelRows = loadExcelRows(xlsxPath);
  const dateFrom = dateFromArg || allExcelRows.map((row) => toIsoDate(row.createdAt)).filter(Boolean).sort()[0] || null;
  const dateTo = dateToArg || allExcelRows.map((row) => toIsoDate(row.createdAt)).filter(Boolean).sort().slice(-1)[0] || null;
  const excelRows = allExcelRows.filter((row) => {
    const createdDate = toIsoDate(row.createdAt);
    if (!createdDate) return false;
    if (dateFrom && createdDate < dateFrom) return false;
    if (dateTo && createdDate > dateTo) return false;
    return true;
  });

  const orderIds = excelRows.map((row) => BigInt(row.orderId));
  const [orders, lines, config] = await Promise.all([
    prisma.reportingGtoOrder.findMany({
      where: { orderId: { in: orderIds } },
      select: {
        orderId: true,
        orderStatus: true,
        createdAt: true,
        touristsCount: true,
        totalAmountEur: true,
        profitEur: true,
        accountingClass: true,
        profitBasisUsed: true,
        hasIncompleteCoreCost: true,
        hasOrderDestination: true,
      },
    }),
    prisma.reportingGtoOrderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: {
        orderId: true,
        productGroup: true,
        status: true,
        currency: true,
        currencyBuy: true,
        priceBuyOriginal: true,
      },
    }),
    getGtoConfig(),
  ]);

  const orderMap = new Map<number, ReportingOrderRow>();
  for (const order of orders) {
    orderMap.set(Number(order.orderId), order as ReportingOrderRow);
  }

  const linesByOrderId = new Map<number, ReportingLineRow[]>();
  for (const line of lines) {
    const orderId = Number(line.orderId);
    const bucket = linesByOrderId.get(orderId) || [];
    bucket.push(line as ReportingLineRow);
    linesByOrderId.set(orderId, bucket);
  }

  const rateCache = new Map<string, Awaited<ReturnType<typeof CurrencyService.getRatesForDate>>>();
  const truthRows = [];
  for (const row of excelRows) {
    const order = orderMap.get(row.orderId);
    const bookingDate = toIsoDate(order?.createdAt || row.createdAt);
    let truthProfitEur = 0;
    if (row.commissionOriginal > 0) {
      const cacheKey = bookingDate || 'fallback';
      let rates = rateCache.get(cacheKey);
      if (!rates) {
        rates = bookingDate
          ? await CurrencyService.getRatesForDate(config.apiKey, config.v3BaseUrl, bookingDate)
          : await CurrencyService.getRatesForDate(config.apiKey, config.v3BaseUrl, new Date().toISOString().slice(0, 10));
        rateCache.set(cacheKey, rates);
      }
      truthProfitEur = round2(CurrencyService.toEur(row.commissionOriginal, row.commissionCurrency || 'EUR', rates) ?? 0);
    }

    const reportingProfitEur = round2(decimalToNumber(order?.profitEur));
    const deltaEur = round2(reportingProfitEur - truthProfitEur);
    const deltaPct = truthProfitEur > 0
      ? round2((Math.abs(deltaEur) / truthProfitEur) * 100)
      : (Math.abs(reportingProfitEur) > 10 ? 9999 : 0);
    const serious = deltaPct > thresholdPct;
    const orderLines = linesByOrderId.get(row.orderId) || [];
    truthRows.push({
      orderId: row.orderId,
      createdDate: toIsoDate(row.createdAt),
      status: row.status,
      numberOfPax: row.numberOfPax,
      structure: row.structure,
      flightCostOriginal: row.flightCostOriginal,
      profitTruthEur: truthProfitEur,
      profitReportingEur: reportingProfitEur,
      profitDeltaEur: deltaEur,
      profitDeltaPct: deltaPct,
      accountingClass: order?.accountingClass || null,
      profitBasisUsed: order?.profitBasisUsed || null,
      hasIncompleteCoreCost: Boolean(order?.hasIncompleteCoreCost),
      reconciliationBucket: classifyBucket(order, orderLines, row),
      serious,
      missingInReporting: !order,
    });
  }

  const seriousRows = truthRows.filter((row) => row.serious && !row.missingInReporting);
  const byBucket = Object.entries(seriousRows.reduce<Record<string, { count: number; profitDeltaEur: number }>>((acc, row) => {
    const key = row.reconciliationBucket;
    acc[key] = acc[key] || { count: 0, profitDeltaEur: 0 };
    acc[key].count += 1;
    acc[key].profitDeltaEur = round2(acc[key].profitDeltaEur + row.profitDeltaEur);
    return acc;
  }, {})).sort((left, right) => right[1].count - left[1].count);
  const byAccountingClass = Object.entries(seriousRows.reduce<Record<string, { count: number; profitDeltaEur: number }>>((acc, row) => {
    const key = row.accountingClass || 'unknown';
    acc[key] = acc[key] || { count: 0, profitDeltaEur: 0 };
    acc[key].count += 1;
    acc[key].profitDeltaEur = round2(acc[key].profitDeltaEur + row.profitDeltaEur);
    return acc;
  }, {})).sort((left, right) => right[1].count - left[1].count);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    xlsxPath,
    dateFrom,
    dateTo,
    thresholdPct,
    totalExcelRows: truthRows.length,
    matchedReportingOrders: truthRows.filter((row) => !row.missingInReporting).length,
    missingReportingOrders: truthRows.filter((row) => row.missingInReporting).map((row) => row.orderId),
    seriousMismatchCount: seriousRows.length,
    seriousMismatchOrderIds: seriousRows.map((row) => row.orderId),
    byBucket,
    byAccountingClass,
    topSeriousMismatches: seriousRows
      .sort((left, right) => Math.abs(right.profitDeltaEur) - Math.abs(left.profitDeltaEur))
      .slice(0, 50),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
