import XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { decrypt } from '../lib/encryption';
import { CurrencyService } from '../lib/currency.service';

type ExcelRow = {
  orderId: number;
  status: string;
  createdAt: Date | null;
  priceBruttoOriginal: number;
  priceBruttoCurrency: string;
  commissionOriginal: number;
  commissionCurrency: string;
};

type ReportingOrderRow = {
  orderId: bigint;
  orderStatus: string;
  createdAt: Date;
  orderCurrency: string | null;
  totalAmountOriginal: any;
  totalAmountEur: any;
  grossAmountOriginal: any;
  grossAmountCurrency: string | null;
  grossAmountEur: any;
  commissionAmountOriginal: any;
  commissionAmountCurrency: string | null;
  commissionAmountEur: any;
  salesBasisUsed: string | null;
};

type ReconciliationBucket =
  | 'net_used_instead_of_gross'
  | 'mixed_currency_commission_fx'
  | 'cnx_negative_net_vs_zero_gross'
  | 'missing_amount_details_gross'
  | 'unknown_sales_mismatch';

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
      createdAt: parseDate(row['Created at']),
      priceBruttoOriginal: parseAmount(row['Price brutto']),
      priceBruttoCurrency: String(row['Price brutto Currency'] || '').trim().toUpperCase(),
      commissionOriginal: parseAmount(row['Commission/Discount']),
      commissionCurrency: String(row['Commission/Discount Currency'] || '').trim().toUpperCase(),
    }))
    .filter((row) => Number.isFinite(row.orderId) && row.orderId > 0);
}

function classifyBucket(order: ReportingOrderRow | undefined, excelGrossEur: number, reportingGrossEur: number): ReconciliationBucket {
  if (!order) return 'unknown_sales_mismatch';

  const reportingNetEur = round2(decimalToNumber(order.totalAmountEur));
  if (Math.abs(reportingNetEur - excelGrossEur) <= 1 && Math.abs(reportingGrossEur - excelGrossEur) > 1) {
    return 'net_used_instead_of_gross';
  }

  if (order.orderStatus === 'CNX' && excelGrossEur <= 1 && reportingNetEur < -1 && reportingGrossEur <= 1) {
    return 'cnx_negative_net_vs_zero_gross';
  }

  if (order.salesBasisUsed === 'net_fallback_warning') {
    if (order.commissionAmountCurrency && order.orderCurrency && order.commissionAmountCurrency !== order.orderCurrency) {
      return 'mixed_currency_commission_fx';
    }
    return 'missing_amount_details_gross';
  }

  return 'unknown_sales_mismatch';
}

async function main() {
  const xlsxPath = readArg('xlsx');
  const thresholdEur = Number(readArg('threshold-eur') || 1);
  const dateFromArg = readArg('from');
  const dateToArg = readArg('to');

  if (!xlsxPath) {
    throw new Error('Usage: tsx src/scripts/gto-looker-sales-reconciliation.ts --xlsx=/path/to/file.xlsx [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--threshold-eur=1]');
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
  const [orders, config] = await Promise.all([
    prisma.reportingGtoOrder.findMany({
      where: { orderId: { in: orderIds } },
      select: {
        orderId: true,
        orderStatus: true,
        createdAt: true,
        orderCurrency: true,
        totalAmountOriginal: true,
        totalAmountEur: true,
        grossAmountOriginal: true,
        grossAmountCurrency: true,
        grossAmountEur: true,
        commissionAmountOriginal: true,
        commissionAmountCurrency: true,
        commissionAmountEur: true,
        salesBasisUsed: true,
      },
    }),
    getGtoConfig(),
  ]);

  const orderMap = new Map<number, ReportingOrderRow>();
  for (const order of orders) {
    orderMap.set(Number(order.orderId), order as unknown as ReportingOrderRow);
  }

  const rateCache = new Map<string, Awaited<ReturnType<typeof CurrencyService.getRatesForDate>>>();
  const rows = [];

  for (const row of excelRows) {
    const order = orderMap.get(row.orderId);
    const bookingDate = toIsoDate(order?.createdAt || row.createdAt);
    let rates = rateCache.get(bookingDate || 'fallback');
    if (!rates) {
      rates = bookingDate
        ? await CurrencyService.getRatesForDate(config.apiKey, config.v3BaseUrl, bookingDate)
        : await CurrencyService.getRatesForDate(config.apiKey, config.v3BaseUrl, new Date().toISOString().slice(0, 10));
      rateCache.set(bookingDate || 'fallback', rates);
    }

    const excelGrossEur = round2(CurrencyService.toEur(row.priceBruttoOriginal, row.priceBruttoCurrency || 'EUR', rates) ?? 0);
    const reportingGrossEur = round2(decimalToNumber(order?.grossAmountEur));
    const reportingNetEur = round2(decimalToNumber(order?.totalAmountEur));
    const deltaGrossEur = round2(reportingGrossEur - excelGrossEur);
    const grossOriginalDelta = order?.grossAmountCurrency === row.priceBruttoCurrency
      ? round2(decimalToNumber(order?.grossAmountOriginal) - row.priceBruttoOriginal)
      : null;
    const serious = Math.abs(deltaGrossEur) > thresholdEur;

    rows.push({
      orderId: row.orderId,
      createdDate: toIsoDate(row.createdAt),
      status: row.status,
      excelGrossOriginal: row.priceBruttoOriginal,
      excelGrossCurrency: row.priceBruttoCurrency,
      excelGrossEur,
      reportingGrossOriginal: round2(decimalToNumber(order?.grossAmountOriginal)),
      reportingGrossCurrency: order?.grossAmountCurrency || null,
      reportingGrossEur,
      reportingNetEur,
      reportingCommissionOriginal: round2(decimalToNumber(order?.commissionAmountOriginal)),
      reportingCommissionCurrency: order?.commissionAmountCurrency || null,
      reportingCommissionEur: round2(decimalToNumber(order?.commissionAmountEur)),
      salesBasisUsed: order?.salesBasisUsed || null,
      deltaGrossEur,
      grossOriginalDelta,
      serious,
      missingInReporting: !order,
      reconciliationBucket: classifyBucket(order, excelGrossEur, reportingGrossEur),
    });
  }

  const seriousRows = rows.filter((row) => row.serious && !row.missingInReporting);
  const byBucket = Object.entries(seriousRows.reduce<Record<string, { count: number; deltaGrossEur: number }>>((acc, row) => {
    const key = row.reconciliationBucket;
    acc[key] = acc[key] || { count: 0, deltaGrossEur: 0 };
    acc[key].count += 1;
    acc[key].deltaGrossEur = round2(acc[key].deltaGrossEur + row.deltaGrossEur);
    return acc;
  }, {})).sort((left, right) => right[1].count - left[1].count);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    xlsxPath,
    dateFrom,
    dateTo,
    thresholdEur,
    totalExcelRows: rows.length,
    matchedReportingOrders: rows.filter((row) => !row.missingInReporting).length,
    missingReportingOrders: rows.filter((row) => row.missingInReporting).map((row) => row.orderId),
    seriousMismatchCount: seriousRows.length,
    byBucket,
    topSeriousMismatches: seriousRows
      .sort((left, right) => Math.abs(right.deltaGrossEur) - Math.abs(left.deltaGrossEur))
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
