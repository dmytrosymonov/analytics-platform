import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { createHttpClient } from '../lib/http';
import { CurrencyService } from '../lib/currency.service';
import { AirlineService } from '../lib/airline.service';
import { DestinationService } from '../lib/destination.service';
import { logger } from '../lib/logger';
import { isIgnoredLookerTestAgentName } from './gto-looker-test-agents';

const DEFAULT_BASE_URL = 'https://api.gto.ua/api/private';
const DEFAULT_V3_BASE_URL = 'https://api.gto.ua/api/v3';
const DEFAULT_TIMEZONE = 'Europe/Kyiv';
const DEFAULT_SYNC_CRON = '0 * * * *';
const DEFAULT_REFRESH_WINDOW_DAYS = 2;
const DETAIL_CONCURRENCY = 4;
const DETAIL_BATCH_SIZE = 100;
const BATCH_PAUSE_MS = 750;
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

type ProductGroup = 'hotel' | 'airticket' | 'transfer' | 'insurance' | 'excursion' | 'other';
type ProductSegment = 'Package' | 'Transfer' | 'Insurance' | 'Excursion' | 'Combi' | 'Hotel' | 'Airtickets' | 'Other';
type AccountingClass =
  | 'airticket_only'
  | 'package_with_flight'
  | 'combi_with_flight'
  | 'hotel_only_or_hotel_led'
  | 'standalone_transfer'
  | 'standalone_insurance'
  | 'other';
type ProfitBasis =
  | 'zero_for_non_cnf'
  | 'raw_margin'
  | 'amount_details_net_basis'
  | 'discount_fallback'
  | 'special_reconciliation_rule';

type DetailEnvelope = {
  orderId: number;
  summary?: JsonRecord;
  detail?: JsonRecord;
  error?: string;
};

type CarrierStats = {
  code: string;
  name: string | null;
  segmentCount: number;
};

type BuildContext = {
  rateCache: Map<string, Awaited<ReturnType<typeof CurrencyService.getRatesForDate>>>;
  airlineDictionary: Awaited<ReturnType<typeof AirlineService.getAirlineDictionary>>;
  destinationDictionary: Awaited<ReturnType<typeof DestinationService.getDestinationDictionary>>;
  unknownAirlineCodes: Set<string>;
  reuseExistingEnrichment: boolean;
  existingOrderEnrichment: Map<number, ExistingOrderEnrichment>;
  existingLineEnrichment: Map<string, ExistingLineEnrichment>;
};

type ExistingOrderEnrichment = {
  destinationId: string | null;
  hasOrderDestination: boolean;
  packageDestinationName: string | null;
};

type ExistingLineEnrichment = {
  airlineCodes: string[];
  airlineNames: string[];
  carriers: CarrierStats[];
};

type OrderFinancials = {
  costEur: number;
  profitEur: number;
  profitPct: number;
  accountingClass: AccountingClass;
  profitBasisUsed: ProfitBasis;
  hasIncompleteCoreCost: boolean;
};

let schedulerStarted = false;
let syncInFlight = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function isIgnoredTestAgentName(value?: string | null) {
  return isIgnoredLookerTestAgentName(value);
}

function isIgnoredLookerOrder(summary?: JsonRecord, detail?: JsonRecord) {
  return isIgnoredTestAgentName(detail?.agent_name) || isIgnoredTestAgentName(summary?.company_name);
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

function cleanSupplierName(name?: string | null) {
  return String(name || '').replace(/\s*\[.*?\]/g, '').trim();
}

function buildSupplierNameMap(detail: JsonRecord) {
  const map = new Map<string, string>();
  for (const supplier of (Array.isArray(detail.supplier) ? detail.supplier : [])) {
    if (supplier?.id) {
      map.set(String(supplier.id), String(supplier.name || ''));
    }
  }
  return map;
}

function supplierTagCurrency(supplierNameMap: Map<string, string>, supplierId: unknown): string | null {
  const name = supplierNameMap.get(String(supplierId || '')) || '';
  const match = name.match(/\[(UAH|EUR|KZT|USD|PLN)\]/i);
  return match ? match[1].toUpperCase() : null;
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

const EXCURSION_SERVICE_TYPE_NAMES = new Set([
  'excursion',
]);

function normalizeServiceTypeName(value?: string | null) {
  return String(value || '').trim().toLocaleLowerCase('uk-UA');
}

function isExcursionServiceType(value?: string | null) {
  return EXCURSION_SERVICE_TYPE_NAMES.has(normalizeServiceTypeName(value));
}

function productGroupForService(row: JsonRecord): ProductGroup {
  const rawType = String(row.type || '').toLowerCase();
  const serviceTypeName = normalizeServiceTypeName(row.service_type_name);

  if (rawType === 'airticket') return 'airticket';
  if (rawType === 'transfer') return 'transfer';
  if (rawType === 'service' && serviceTypeName.includes('insurance')) return 'insurance';
  if (rawType === 'service' && isExcursionServiceType(serviceTypeName)) return 'excursion';
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

function extractCarrierStats(raw: JsonRecord, codeToName: Record<string, string>) {
  const segments = Array.isArray(raw.flight_details?.segment) ? raw.flight_details.segment : [];
  const byCode = new Map<string, CarrierStats>();

  for (const segment of segments) {
    const code = String(segment?.airline || '').trim().toUpperCase();
    if (!code) continue;
    const current = byCode.get(code);
    if (current) {
      current.segmentCount += 1;
      continue;
    }

    const mappedName = String(codeToName[code] || '').trim();
    byCode.set(code, {
      code,
      name: mappedName || code,
      segmentCount: 1,
    });
  }

  return Array.from(byCode.values()).sort((left, right) => left.code.localeCompare(right.code));
}

const ORDER_DESTINATION_CANDIDATE_KEYS = [
  'destination',
  'destination_name',
  'destination_label',
  'package_destination',
  'package_destination_name',
  'order_destination',
  'order_destination_name',
];

function normalizeOrderDestinationValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeOrderDestinationValue(item);
      if (normalized) return normalized;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as JsonRecord;
    for (const key of ['name', 'label', 'title', 'destination', 'value']) {
      const normalized = normalizeOrderDestinationValue(record[key]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function extractOrderDestinationFallback(detail: JsonRecord, summary: JsonRecord): string | null {
  for (const source of [detail, summary]) {
    for (const key of ORDER_DESTINATION_CANDIDATE_KEYS) {
      const normalized = normalizeOrderDestinationValue(source?.[key]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function extractOrderDestinationId(detail: JsonRecord, summary: JsonRecord): string | null {
  for (const source of [detail, summary]) {
    const normalized = String(source?.destination_id || '').trim();
    if (normalized) return normalized;
  }
  return null;
}

function resolveOrderDestination(
  detail: JsonRecord,
  summary: JsonRecord,
  destinationDictionary: Record<string, string>,
) {
  const destinationId = extractOrderDestinationId(detail, summary);
  const resolvedById = destinationId ? String(destinationDictionary[destinationId] || '').trim() : '';
  const fallbackName = extractOrderDestinationFallback(detail, summary);

  return {
    destinationId,
    packageDestinationName: resolvedById || fallbackName || null,
    hasOrderDestination: Boolean(destinationId && resolvedById),
  };
}

function normalizeCurrencyCode(value: unknown): string | null {
  const text = String(value || '').trim().toUpperCase();
  return text || null;
}

function classifyProductSegment(
  orderLines: Array<{ productGroup: ProductGroup; raw: JsonRecord }>,
  hasOrderDestination: boolean,
): ProductSegment {
  if (hasOrderDestination) return 'Package';

  if (orderLines.length === 0) return 'Other';

  const groups = new Set(orderLines.map((line) => line.productGroup));
  if (groups.size === 1) {
    const onlyGroup = orderLines[0]?.productGroup;
    if (onlyGroup === 'transfer') return 'Transfer';
    if (onlyGroup === 'insurance') return 'Insurance';
    if (onlyGroup === 'excursion') return 'Excursion';
  }

  if (groups.has('hotel') && groups.has('airticket')) return 'Combi';
  if (groups.has('hotel')) return 'Hotel';
  if (groups.has('airticket')) return 'Airtickets';
  return 'Other';
}

function classifyAccountingClass(
  orderLines: Array<{ productGroup: ProductGroup; raw: JsonRecord }>,
  hasOrderDestination: boolean,
): AccountingClass {
  if (orderLines.length === 0) return 'other';

  const groups = new Set(orderLines.map((line) => line.productGroup));
  const hasHotel = groups.has('hotel');
  const hasAirticket = groups.has('airticket');

  if (groups.size === 1) {
    const onlyGroup = orderLines[0]?.productGroup;
    if (onlyGroup === 'airticket') return 'airticket_only';
    if (onlyGroup === 'transfer') return 'standalone_transfer';
    if (onlyGroup === 'insurance') return 'standalone_insurance';
  }

  if (hasHotel && hasAirticket && hasOrderDestination) return 'package_with_flight';
  if (hasHotel && hasAirticket) return 'combi_with_flight';
  if (hasHotel || hasOrderDestination) return 'hotel_only_or_hotel_led';

  return 'other';
}

function isCoreServiceRow(row: JsonRecord) {
  const rawType = String(row.type || '').toLowerCase();
  return rawType === 'airticket' || rawType === 'transfer';
}

function hasMissingBuyCost(row: JsonRecord) {
  return (parseAmount(row.price_buy) || 0) <= 0;
}

function isAncillaryServiceRow(row: JsonRecord) {
  const rawType = String(row.type || '').toLowerCase();
  if (rawType !== 'service') return false;

  const productGroup = productGroupForService(row);
  return productGroup === 'other' || productGroup === 'insurance' || productGroup === 'excursion';
}

function shouldUseSpecialReconciliationRule(
  accountingClass: AccountingClass,
  rawProfitEur: number,
  discountEur: number,
) {
  if (!['package_with_flight', 'combi_with_flight', 'hotel_only_or_hotel_led'].includes(accountingClass)) {
    return false;
  }

  if (discountEur <= 0 || rawProfitEur <= 0) return false;
  return rawProfitEur >= discountEur * 3 && rawProfitEur - discountEur >= 100;
}

function discountFallbackEur(
  detail: JsonRecord,
  orderCurrency: string,
  toEur: (amount: number | null, currency?: string | null) => number | null,
) {
  const amountDetails = Array.isArray(detail.amount_details) ? detail.amount_details : [];
  let discountEur = 0;

  for (const row of amountDetails) {
    const discountOriginal = parseAmount(row?.discount) || 0;
    if (discountOriginal <= 0) continue;
    discountEur += toEur(discountOriginal, row?.currency || orderCurrency) ?? 0;
  }

  return round2(discountEur);
}

function amountDetailsTotals(
  detail: JsonRecord,
  orderCurrency: string,
  toEur: (amount: number | null, currency?: string | null) => number | null,
) {
  const amountDetails = Array.isArray(detail.amount_details) ? detail.amount_details : [];
  let sellEur = 0;
  let discountEur = 0;

  for (const row of amountDetails) {
    const totalSellOriginal = parseAmount(row?.total_sell) || 0;
    const discountOriginal = parseAmount(row?.discount) || 0;
    const currency = row?.currency || orderCurrency;
    sellEur += toEur(totalSellOriginal, currency) ?? 0;
    discountEur += toEur(discountOriginal, currency) ?? 0;
  }

  return {
    rowCount: amountDetails.length,
    sellEur: round2(sellEur),
    discountEur: round2(discountEur),
    netEur: round2(sellEur - discountEur),
    rows: amountDetails,
  };
}

function singleAirticketOrderImpliedTotals(
  detail: JsonRecord,
  orderCurrency: string,
  toEur: (amount: number | null, currency?: string | null) => number | null,
) {
  const hotels = Array.isArray(detail.hotel) ? detail.hotel : [];
  const services = Array.isArray(detail.service) ? detail.service : [];
  if (hotels.length !== 0 || services.length !== 1) return null;

  const service = services[0];
  if (String(service?.type || '').toLowerCase() !== 'airticket') return null;

  const totals = amountDetailsTotals(detail, orderCurrency, toEur);
  if (totals.rowCount !== 1) return null;
  const balanceAmount = parseAmount(detail.balance_amount) || 0;
  const balanceEur = toEur(balanceAmount, detail.balance_currency || orderCurrency) ?? 0;

  if (totals.discountEur > 0 && balanceEur > 0 && Math.abs(balanceEur - totals.netEur) <= 1) {
    return {
      impliedSellEur: round2(totals.sellEur),
      impliedBuyEur: round2(totals.sellEur - totals.discountEur),
      discountEur: totals.discountEur,
      netRevenueEur: round2(totals.sellEur),
    };
  }

  const amountDetail = totals.rows[0];
  const sellOriginal = parseAmount(service?.price) || 0;
  const buyOriginal = parseAmount(service?.price_buy) || 0;
  const totalSellEur = toEur(parseAmount(amountDetail?.total_sell) || 0, amountDetail?.currency || orderCurrency) ?? 0;
  const directSellEur = toEur(sellOriginal, service?.currency || orderCurrency) ?? 0;

  if (sellOriginal <= 0 || buyOriginal <= 0 || totalSellEur <= 0 || directSellEur <= 0) return null;
  if (Math.abs(totalSellEur - directSellEur) / directSellEur > 0.25) return null;

  const impliedRate = totalSellEur / sellOriginal;
  return {
    impliedSellEur: round2(totalSellEur),
    impliedBuyEur: round2(buyOriginal * impliedRate),
    discountEur: totals.discountEur,
    netRevenueEur: totals.netEur,
  };
}

function computeOrderFinancials(
  detail: JsonRecord,
  summary: JsonRecord,
  toEur: (amount: number | null, currency?: string | null) => number | null,
  hasOrderDestination: boolean,
): OrderFinancials {
  const orderStatus = String(detail.status || summary.status || '');
  const orderCurrency = String(detail.currency || summary.currency || 'UAH');
  const balanceCurrency = String(detail.balance_currency || orderCurrency);
  const balanceAmount = parseAmount(detail.balance_amount) || 0;
  const totalAmount = parseAmount(detail.total_amount) || 0;
  const hotelLines = Array.isArray(detail.hotel) ? detail.hotel : [];
  const serviceLines = Array.isArray(detail.service) ? detail.service : [];
  const allLines: Array<{ productGroup: ProductGroup; raw: JsonRecord }> = [
    ...hotelLines.map((line: JsonRecord) => ({ productGroup: 'hotel' as ProductGroup, raw: line })),
    ...serviceLines.map((line: JsonRecord) => ({ productGroup: productGroupForService(line), raw: line })),
  ];
  const accountingClass = classifyAccountingClass(allLines, hasOrderDestination);
  const amountDetailTotals = amountDetailsTotals(detail, orderCurrency, toEur);
  const impliedSingleAirticket = singleAirticketOrderImpliedTotals(detail, orderCurrency, toEur);
  const priceEur = amountDetailTotals.netEur > 0
    ? amountDetailTotals.netEur
    : balanceAmount > 0
    ? (toEur(balanceAmount, balanceCurrency) ?? 0)
    : (toEur(totalAmount, orderCurrency) ?? 0);

  if (orderStatus !== 'CNF') {
    return {
      costEur: 0,
      profitEur: 0,
      profitPct: 0,
      accountingClass,
      profitBasisUsed: 'zero_for_non_cnf',
      hasIncompleteCoreCost: false,
    };
  }

  let costEur = 0;
  const hotels = hotelLines;
  const services = serviceLines;
  const confirmedHotels = hotels.filter((row: any) => row.status === 'CNF');
  const confirmedCoreServices = services.filter((row: any) => row.status === 'CNF' && isCoreServiceRow(row));
  const hasIncompleteCoreCost = confirmedHotels.some(hasMissingBuyCost)
    || confirmedCoreServices.some(hasMissingBuyCost);
  const hasConfirmedMainTravelProduct = confirmedHotels.length > 0 || confirmedCoreServices.length > 0;
  const costBearingServices = services.filter((row: any) => {
    const status = normalizeLineStatus(row.status);
    if (status === 'CNF') return true;
    if (status === 'PEN' && hasConfirmedMainTravelProduct && isAncillaryServiceRow(row)) {
      return (parseAmount(row.price_buy) || 0) > 0;
    }
    return false;
  });
  const eurTransferSuppliers = new Set(['suntransfers']);
  const supplierNameMap = buildSupplierNameMap(detail);

  if (hasIncompleteCoreCost) {
    const discountEur = amountDetailTotals.discountEur > 0
      ? amountDetailTotals.discountEur
      : discountFallbackEur(detail, orderCurrency, toEur);
    return {
      costEur: round2(Math.max(priceEur - discountEur, 0)),
      profitEur: discountEur,
      profitPct: priceEur > 0 ? Math.round((discountEur / priceEur) * 100) : 0,
      accountingClass,
      profitBasisUsed: 'discount_fallback',
      hasIncompleteCoreCost,
    };
  }

  if (impliedSingleAirticket) {
    const profitEur = round2(impliedSingleAirticket.netRevenueEur - impliedSingleAirticket.impliedBuyEur);
    return {
      costEur: impliedSingleAirticket.impliedBuyEur,
      profitEur,
      profitPct: impliedSingleAirticket.netRevenueEur > 0
        ? Math.round((profitEur / impliedSingleAirticket.netRevenueEur) * 100)
        : 0,
      accountingClass,
      profitBasisUsed: 'amount_details_net_basis',
      hasIncompleteCoreCost,
    };
  }

  for (const hotel of confirmedHotels) {
    const priceBuy = parseAmount(hotel.price_buy) || 0;
    const priceSell = parseAmount(hotel.price) || 0;
    if (priceBuy <= 0) continue;

    const explicitBuyCurrency = normalizeCurrencyCode(hotel.currency_buy);
    const hotelCurrency = explicitBuyCurrency || String(hotel.currency || orderCurrency);
    const costConverted = toEur(priceBuy, hotelCurrency) ?? 0;
    const sellConverted = toEur(priceSell, hotel.currency || orderCurrency) ?? 0;
    const costUah = toEur(priceBuy, 'UAH') ?? costConverted;

    const hotelCost = !explicitBuyCurrency && ((sellConverted > 0 && costConverted > sellConverted) ||
      (priceEur > 0 && costConverted > priceEur)
    )
      ? costUah
      : costConverted;

    costEur += hotelCost;
  }

  for (const service of costBearingServices) {
    const priceBuy = parseAmount(service.price_buy) || 0;
    const priceSell = parseAmount(service.price) || 0;
    if (priceBuy <= 0) continue;

    let serviceCostEur: number;

    if (service.type === 'transfer') {
      const transferSupplier = cleanSupplierName(service.supplier_name || service.service_supplier_name).toLowerCase();
      const explicitBuyCurrency = normalizeCurrencyCode(service.currency_buy);
      const transferCurrency = explicitBuyCurrency || (eurTransferSuppliers.has(transferSupplier)
        ? 'EUR'
        : String(service.currency || orderCurrency));
      const transferCostConverted = toEur(priceBuy, transferCurrency) ?? 0;
      const transferSellConverted = toEur(priceSell, service.currency || orderCurrency) ?? 0;
      const transferCostUah = toEur(priceBuy, 'UAH') ?? transferCostConverted;

      serviceCostEur = !explicitBuyCurrency && transferCurrency !== 'UAH' && (
        (transferSellConverted > 0 && transferCostConverted > transferSellConverted * 2) ||
        (priceEur > 0 && transferCostConverted > priceEur)
      )
        ? transferCostUah
        : transferCostConverted;
    } else if (service.type === 'airticket') {
      const explicitBuyCurrency = normalizeCurrencyCode(service.currency_buy);
      const buyCurrency = explicitBuyCurrency
        || supplierTagCurrency(supplierNameMap, service.supplier_id)
        || String(service.currency || orderCurrency);
      const airCostConverted = toEur(priceBuy, buyCurrency) ?? 0;
      const airSellConverted = toEur(priceSell, service.currency || orderCurrency) ?? 0;
      const airCostUah = toEur(priceBuy, 'UAH') ?? airCostConverted;

      serviceCostEur = !explicitBuyCurrency && ((airSellConverted > 0 && airCostConverted > airSellConverted * 2) ||
        (priceEur > 0 && airCostConverted > priceEur)
      )
        ? airCostUah
        : airCostConverted;
    } else {
      const explicitBuyCurrency = normalizeCurrencyCode(service.currency_buy);
      const serviceCurrency = explicitBuyCurrency || String(service.currency || orderCurrency);
      const costConverted = toEur(priceBuy, serviceCurrency) ?? 0;
      const sellConverted = toEur(priceSell, service.currency || orderCurrency) ?? 0;
      const costUah = toEur(priceBuy, 'UAH') ?? costConverted;

      serviceCostEur = !explicitBuyCurrency && ((sellConverted > 0 && costConverted > sellConverted) ||
        (priceEur > 0 && costConverted > priceEur)
      )
        ? costUah
        : costConverted;
    }

    costEur += serviceCostEur;
  }

  const rawCostEur = round2(costEur);
  const rawProfitEur = round2(priceEur - rawCostEur);
  const discountEur = amountDetailTotals.discountEur > 0
    ? amountDetailTotals.discountEur
    : discountFallbackEur(detail, orderCurrency, toEur);
  if (shouldUseSpecialReconciliationRule(accountingClass, rawProfitEur, discountEur)) {
    return {
      costEur: round2(Math.max(priceEur - discountEur, 0)),
      profitEur: discountEur,
      profitPct: priceEur > 0 ? Math.round((discountEur / priceEur) * 100) : 0,
      accountingClass,
      profitBasisUsed: 'special_reconciliation_rule',
      hasIncompleteCoreCost,
    };
  }

  return {
    costEur: rawCostEur,
    profitEur: rawProfitEur,
    profitPct: priceEur > 0 ? Math.round((rawProfitEur / priceEur) * 100) : 0,
    accountingClass,
    profitBasisUsed: 'raw_margin',
    hasIncompleteCoreCost,
  };
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
  let excluded = 0;

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

    const keptRows = pageRows.filter((row: JsonRecord) => !isIgnoredTestAgentName(String(row.company_name || '')));
    excluded += pageRows.length - keptRows.length;
    rows.push(...keptRows);
    logger.info(
      { page, pageRows: pageRows.length, keptRows: keptRows.length, excludedRows: excluded, total: rows.length, dateFrom, dateTo },
      'Fetched GTO orders_list page',
    );

    if (pageRows.length < perPage) break;
    page += 1;
    if (page > 500) {
      throw new Error('orders_list exceeded 500 pages');
    }
  }

  if (excluded > 0) {
    logger.info({ excluded, dateFrom, dateTo }, 'Excluded test-agent orders from GTO orders_list window before detail fetch');
  }

  return rows;
}

async function fetchOrderDetails(
  http: ReturnType<typeof createHttpClient>,
  summaries: JsonRecord[],
  progressOffset = 0,
  progressTotal = summaries.length,
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
      logger.info({ progress: `${progressOffset + index}/${progressTotal}` }, 'Fetching GTO order_data');
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

async function fetchExistingEnrichment(orderIds: bigint[]) {
  const [orders, lines, lineAirlines] = await Promise.all([
    (prisma as any).reportingGtoOrder.findMany({
      where: { orderId: { in: orderIds } },
      select: {
        orderId: true,
        destinationId: true,
        hasOrderDestination: true,
        packageDestinationName: true,
      },
    }),
    (prisma as any).reportingGtoOrderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: {
        lineId: true,
        airlineCodes: true,
        airlineNames: true,
      },
    }),
    (prisma as any).reportingGtoOrderLineAirline.findMany({
      where: { orderId: { in: orderIds } },
      select: {
        lineId: true,
        airlineCode: true,
        airlineName: true,
        segmentCount: true,
      },
    }),
  ]);

  const existingOrderEnrichment = new Map<number, ExistingOrderEnrichment>();
  for (const row of orders) {
    existingOrderEnrichment.set(Number(row.orderId), {
      destinationId: row.destinationId || null,
      hasOrderDestination: Boolean(row.hasOrderDestination),
      packageDestinationName: row.packageDestinationName || null,
    });
  }

  const carriersByLineId = new Map<string, CarrierStats[]>();
  for (const row of lineAirlines) {
    const lineId = String(row.lineId);
    const carriers = carriersByLineId.get(lineId) || [];
    carriers.push({
      code: String(row.airlineCode || '').trim().toUpperCase(),
      name: String(row.airlineName || '').trim() || null,
      segmentCount: Number(row.segmentCount || 0),
    });
    carriersByLineId.set(lineId, carriers);
  }

  const existingLineEnrichment = new Map<string, ExistingLineEnrichment>();
  for (const row of lines) {
    const lineId = String(row.lineId);
    const airlineCodes = String(row.airlineCodes || '')
      .split('|')
      .map((value) => value.trim())
      .filter(Boolean);
    const airlineNames = String(row.airlineNames || '')
      .split('|')
      .map((value) => value.trim())
      .filter(Boolean);
    existingLineEnrichment.set(lineId, {
      airlineCodes,
      airlineNames,
      carriers: (carriersByLineId.get(lineId) || []).sort((left, right) => left.code.localeCompare(right.code)),
    });
  }

  return {
    existingOrderEnrichment,
    existingLineEnrichment,
  };
}

function decimalValue(value: number | null): string | null {
  return value === null || value === undefined ? null : round2(value).toFixed(2);
}

async function buildReportingRows(
  details: DetailEnvelope[],
  config: GtoConfig,
  context: BuildContext,
) {
  const successful = details.filter((row) => row.detail && !row.error);
  const failed = details.filter((row) => row.error);

  const getRatesForDate = async (date: string) => {
    const normalized = date.slice(0, 10);
    const cached = context.rateCache.get(normalized);
    if (cached) return cached;
    const rates = await CurrencyService.getRatesForDate(config.apiKey, config.v3BaseUrl, normalized);
    context.rateCache.set(normalized, rates);
    return rates;
  };

  const orderRows: any[] = [];
  const lineRows: any[] = [];
  const lineAirlineRows: any[] = [];

  for (const row of successful) {
    const detail = row.detail as JsonRecord;
    const summary = row.summary || {};
    if (isIgnoredLookerOrder(summary, detail)) {
      continue;
    }
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
    const allLines: Array<{ productGroup: ProductGroup; raw: JsonRecord }> = [
      ...hotelLines.map((line: JsonRecord) => ({ productGroup: 'hotel' as ProductGroup, raw: line })),
      ...serviceLines.map((line: JsonRecord) => ({ productGroup: productGroupForService(line), raw: line })),
    ];
    const activeLines = allLines.filter(({ raw }) => isActiveStatus(raw.status));
    const activeProductGroups = Array.from(new Set(activeLines.map(({ productGroup }) => productGroup)));

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
    const existingOrderEnrichment = context.existingOrderEnrichment.get(orderId);
    const resolvedDestination = resolveOrderDestination(
      detail,
      summary,
      context.destinationDictionary.idToName,
    );
    const destinationId = context.reuseExistingEnrichment && existingOrderEnrichment?.destinationId
      ? existingOrderEnrichment.destinationId
      : resolvedDestination.destinationId;
    const packageDestinationName = context.reuseExistingEnrichment && existingOrderEnrichment?.packageDestinationName
      ? existingOrderEnrichment.packageDestinationName
      : resolvedDestination.packageDestinationName;
    const hasOrderDestination = context.reuseExistingEnrichment && existingOrderEnrichment?.hasOrderDestination
      ? existingOrderEnrichment.hasOrderDestination
      : resolvedDestination.hasOrderDestination;
    const financials = computeOrderFinancials(detail, summary, toEur, hasOrderDestination);
    const productSegment = classifyProductSegment(allLines, hasOrderDestination);
    const orderAirlineCodes = new Set<string>();
    const orderAirlineNames = new Set<string>();

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
      structureId: String(detail.structure_id || '') || null,
      structureName: String(detail.structure_name || '') || null,
      orderCurrency: String(detail.currency || '') || null,
      balanceCurrency: String(detail.balance_currency || '') || null,
      totalAmountOriginal: decimalValue(totalAmountOriginal),
      totalAmountEur: decimalValue(toEur(totalAmountOriginal, detail.currency)),
      balanceAmountOriginal: decimalValue(balanceAmountOriginal),
      balanceAmountEur: decimalValue(toEur(balanceAmountOriginal, detail.balance_currency || detail.currency)),
      costAmountEur: decimalValue(financials.costEur),
      profitEur: decimalValue(financials.profitEur),
      profitPct: financials.profitPct,
      accountingClass: financials.accountingClass,
      profitBasisUsed: financials.profitBasisUsed,
      hasIncompleteCoreCost: financials.hasIncompleteCoreCost,
      bookingRateDate: bookingDate ? parseDateOnly(bookingDate) : null,
      touristsCount: Array.isArray(detail.tourist) ? detail.tourist.length : 0,
      countriesCount: countries.length,
      countryNames: countries.map((country: any) => country.name).filter(Boolean).join(' | ') || null,
      primaryCountryName: String(countries[0]?.name || '') || null,
      suppliersCount: suppliers.length,
      supplierNames: suppliers.map((supplier: any) => supplier.name).filter(Boolean).join(' | ') || null,
      airlineCodes: null,
      airlineNames: null,
      destinationId,
      hasOrderDestination,
      packageDestinationName,
      destinationNames: destinations.join(' | ') || null,
      productGroups: activeProductGroups.join(' | ') || null,
      productSegment,
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
      activeLinesCount: activeLines.length,
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
      const existingLineEnrichment = context.existingLineEnrichment.get(lineId);
      const carrierStats = productGroup === 'airticket'
        ? (
          context.reuseExistingEnrichment && existingLineEnrichment?.carriers.length
            ? existingLineEnrichment.carriers
            : extractCarrierStats(raw, context.airlineDictionary.codeToName)
        )
        : [];
      const airlineCodes = productGroup === 'airticket' && context.reuseExistingEnrichment && existingLineEnrichment?.airlineCodes.length
        ? existingLineEnrichment.airlineCodes
        : carrierStats.map((carrier) => carrier.code);
      const airlineNames = productGroup === 'airticket' && context.reuseExistingEnrichment && existingLineEnrichment?.airlineNames.length
        ? existingLineEnrichment.airlineNames
        : carrierStats.map((carrier) => carrier.name).filter((value): value is string => Boolean(value));

      for (const carrier of carrierStats) {
        if (!context.airlineDictionary.codeToName[carrier.code]) {
          context.unknownAirlineCodes.add(carrier.code);
        }
        orderAirlineCodes.add(carrier.code);
        if (carrier.name) orderAirlineNames.add(carrier.name);
        lineAirlineRows.push({
          lineId,
          orderId: BigInt(orderId),
          airlineCode: carrier.code,
          airlineName: carrier.name,
          segmentCount: carrier.segmentCount,
          syncedAt: new Date(),
        });
      }

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
        airlineCodes: airlineCodes.join(' | ') || null,
        airlineNames: airlineNames.join(' | ') || null,
        destinationRaw: extractDestinationRaw(raw, productGroup),
        dateFrom: parseDateOnly(raw.date_from),
        dateTo: parseDateOnly(raw.date_to),
        currency: String(raw.currency || '') || null,
        currencyBuy: normalizeCurrencyCode(raw.currency_buy),
        priceOriginal: decimalValue(priceOriginal),
        priceEur: decimalValue(toEur(priceOriginal, raw.currency)),
        priceBuyOriginal: decimalValue(priceBuyOriginal),
        priceBuyEur: decimalValue(toEur(priceBuyOriginal, normalizeCurrencyCode(raw.currency_buy) || raw.currency)),
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

    const lastOrderRow = orderRows[orderRows.length - 1];
    lastOrderRow.airlineCodes = Array.from(orderAirlineCodes).sort().join(' | ') || null;
    lastOrderRow.airlineNames = Array.from(orderAirlineNames).sort((left, right) => left.localeCompare(right)).join(' | ') || null;
  }

  return {
    orderRows,
    lineRows,
    lineAirlineRows,
    failed,
  };
}

function chunk<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    result.push(rows.slice(index, index + size));
  }
  return result;
}

async function replaceReportingRows(orderRows: any[], lineRows: any[], lineAirlineRows: any[]) {
  const orderIds = orderRows.map((row) => row.orderId);
  let deletedLineRows = 0;
  let deletedOrderRows = 0;
  let insertedOrderRows = 0;
  let insertedLineRows = 0;

  for (const ids of chunk(orderIds, DELETE_CHUNK)) {
    await (prisma as any).reportingGtoOrderLineAirline.deleteMany({
      where: { orderId: { in: ids } },
    });

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

  for (const rows of chunk(lineAirlineRows, INSERT_CHUNK)) {
    if (!rows.length) continue;
    await (prisma as any).reportingGtoOrderLineAirline.createMany({
      data: rows,
    });
  }

  return {
    deletedLineRows,
    deletedOrderRows,
    insertedOrderRows,
    insertedLineRows,
  };
}

async function updateSyncRunProgress(runId: string, data: {
  fetchedOrderRows: number;
  fetchedUniqueOrderIds: number;
  syncedOrderRows: number;
  syncedLineRows: number;
  detailErrorRows: number;
  insertedOrderRows: number;
  insertedLineRows: number;
  deletedOrderRows: number;
  deletedLineRows: number;
}) {
  await (prisma as any).reportingGtoSyncRun.update({
    where: { id: runId },
    data,
  });
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
    const fetchedUniqueOrderIds = new Set(summaries.map((row) => Number(row.order_id))).size;
    const buildContext: BuildContext = {
      rateCache: new Map(),
      airlineDictionary: await AirlineService.getAirlineDictionary(config.apiKey, config.v3BaseUrl),
      destinationDictionary: await DestinationService.getDestinationDictionary(config.apiKey, config.v3BaseUrl),
      unknownAirlineCodes: new Set(),
      reuseExistingEnrichment: params.mode !== 'backfill',
      existingOrderEnrichment: new Map(),
      existingLineEnrichment: new Map(),
    };
    const warnings = [
      ...buildContext.airlineDictionary.duplicateCodeWarnings,
      ...buildContext.airlineDictionary.duplicateNameWarnings,
    ];

    let syncedOrderRows = 0;
    let syncedLineRows = 0;
    let detailErrorRows = 0;
    let insertedOrderRows = 0;
    let insertedLineRows = 0;
    let deletedOrderRows = 0;
    let deletedLineRows = 0;

    for (let offset = 0; offset < summaries.length; offset += DETAIL_BATCH_SIZE) {
      const summaryBatch = summaries.slice(offset, offset + DETAIL_BATCH_SIZE);
      const batchOrderIds = summaryBatch
        .map((row) => Number(row.order_id))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => BigInt(value));
      if (buildContext.reuseExistingEnrichment) {
        const existing = await fetchExistingEnrichment(batchOrderIds);
        buildContext.existingOrderEnrichment = existing.existingOrderEnrichment;
        buildContext.existingLineEnrichment = existing.existingLineEnrichment;
      } else {
        buildContext.existingOrderEnrichment = new Map();
        buildContext.existingLineEnrichment = new Map();
      }
      const details = await fetchOrderDetails(http, summaryBatch, offset, summaries.length);
      const { orderRows, lineRows, lineAirlineRows, failed } = await buildReportingRows(details, config, buildContext);
      const replaceStats = await replaceReportingRows(orderRows, lineRows, lineAirlineRows);

      syncedOrderRows += orderRows.length;
      syncedLineRows += lineRows.length;
      detailErrorRows += failed.length;
      insertedOrderRows += replaceStats.insertedOrderRows;
      insertedLineRows += replaceStats.insertedLineRows;
      deletedOrderRows += replaceStats.deletedOrderRows;
      deletedLineRows += replaceStats.deletedLineRows;

      await updateSyncRunProgress(run.id, {
        fetchedOrderRows: summaries.length,
        fetchedUniqueOrderIds,
        syncedOrderRows,
        syncedLineRows,
        detailErrorRows,
        insertedOrderRows,
        insertedLineRows,
        deletedOrderRows,
        deletedLineRows,
      });

      logger.info({
        runId: run.id,
        batchStart: offset,
        batchSize: summaryBatch.length,
        processed: Math.min(offset + summaryBatch.length, summaries.length),
        total: summaries.length,
        syncedOrderRows,
        syncedLineRows,
      }, 'Committed GTO Looker sync batch');

      if (offset + DETAIL_BATCH_SIZE < summaries.length && BATCH_PAUSE_MS > 0) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    if (detailErrorRows > 0) {
      warnings.push(`Failed to refresh ${detailErrorRows} orders in current sync window`);
    }
    if (buildContext.unknownAirlineCodes.size > 0) {
      warnings.push(`Unknown airline codes in GTO airticket segments: ${Array.from(buildContext.unknownAirlineCodes).sort().join(', ')}`);
    }

    const result: SyncResult = {
      runId: run.id,
      mode: params.mode,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      fetchedOrderRows: summaries.length,
      fetchedUniqueOrderIds,
      syncedOrderRows,
      syncedLineRows,
      detailErrorRows,
      insertedOrderRows,
      insertedLineRows,
      deletedOrderRows,
      deletedLineRows,
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
