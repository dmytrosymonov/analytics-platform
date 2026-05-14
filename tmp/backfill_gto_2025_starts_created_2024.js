const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');

const prisma = new PrismaClient();

const DEFAULT_BASE_URL = 'https://api.gto.ua/api/private';
const DEFAULT_V3_BASE_URL = 'https://api.gto.ua/api/v3';
const DETAIL_CONCURRENCY = 8;
const INSERT_CHUNK = 500;
const DELETE_CHUNK = 500;
const LOOKER_IGNORED_TEST_AGENT_NAMES = new Set([
  'gto for test-goodwin',
  'ocoo мтревел test agent for gto-test website',
  'esky_test',
  'kg goodwin test agent гранд турс паруса',
  'test_b2b',
  'tina test online.gto.global',
  'o2_test',
  'test new',
  'tina test agent mtp gto pl',
  'goodwin test kz',
  'tina test agent mtp gto kz',
  'test1watt',
  'test verify',
  'reg travel test',
  'test goodwin agent gto.online.global',
  'gto global kazakhstan test goodwin agent (gto.kz)',
  'kz test agency',
  'gto global poland test goodwin agent (gto.pl)',
  'test registration pl',
  'pl test agent',
  'your brand travel (test agent. view only)',
  'testuser',
  '2025 test agent',
  'testagency',
  'test-',
  'test',
]);

const rateCache = new Map();
let currencyCodeMapPromise = null;
const unknownCurrencies = new Map();

function decrypt(payload) {
  const key = Buffer.from(process.env.ENCRYPTION_MASTER_KEY, 'hex');
  const [ivB64, tagB64, encryptedB64] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return decipher.update(Buffer.from(encryptedB64, 'base64')).toString('utf8') + decipher.final('utf8');
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function normalizeAgentName(value) {
  return String(value || '').trim().toLocaleLowerCase('uk-UA');
}

function isIgnoredTestAgentName(value) {
  return LOOKER_IGNORED_TEST_AGENT_NAMES.has(normalizeAgentName(value));
}

function isIgnoredLookerOrder(summary, detail) {
  return isIgnoredTestAgentName(detail?.agent_name) || isIgnoredTestAgentName(summary?.company_name);
}

function decimalValue(value) {
  return value === null || value === undefined ? null : round2(value).toFixed(2);
}

function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function parseDateTime(value) {
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

function parseDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) return parseDateTime(value);
  const match = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function normalizeLineStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function isCancelledStatus(value) {
  return normalizeLineStatus(value) === 'CNX';
}

function isActiveStatus(value) {
  const status = normalizeLineStatus(value);
  return status !== 'CNX' && status !== '';
}

function cleanSupplierName(name) {
  return String(name || '').replace(/\s*\[.*?\]/g, '').trim();
}

function buildSupplierNameMap(detail) {
  const map = new Map();
  for (const supplier of (Array.isArray(detail.supplier) ? detail.supplier : [])) {
    if (supplier?.id) map.set(String(supplier.id), String(supplier.name || ''));
  }
  return map;
}

function supplierTagCurrency(supplierNameMap, supplierId) {
  const name = supplierNameMap.get(String(supplierId || '')) || '';
  const match = name.match(/\[(UAH|EUR|KZT|USD|PLN)\]/i);
  return match ? match[1].toUpperCase() : null;
}

function extractBracketLabels(name) {
  return [...String(name || '').matchAll(/\[([^\]]+)\]/g)]
    .map((match) => (match[1] || '').trim())
    .filter(Boolean);
}

function detectAgentNetwork(name) {
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

function salesLeadDays(createdAt, startDate) {
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

function normalizeServiceTypeName(value) {
  return String(value || '').trim().toLocaleLowerCase('uk-UA');
}

function isExcursionServiceType(value) {
  return EXCURSION_SERVICE_TYPE_NAMES.has(normalizeServiceTypeName(value));
}

function productGroupForService(row) {
  const rawType = String(row.type || '').toLowerCase();
  const serviceTypeName = normalizeServiceTypeName(row.service_type_name);
  if (rawType === 'airticket') return 'airticket';
  if (rawType === 'transfer') return 'transfer';
  if (rawType === 'service' && serviceTypeName.includes('insurance')) return 'insurance';
  if (rawType === 'service' && isExcursionServiceType(serviceTypeName)) return 'excursion';
  return 'other';
}

function extractDestinationRaw(line, productGroup) {
  if (productGroup === 'hotel') {
    const fullName = String(line.full_name || '');
    const match = fullName.match(/\[([^\]]+)\]/);
    if (match && match[1]) return match[1].trim();
    return String(line.hotel_name || '').trim() || null;
  }
  if (productGroup === 'transfer') {
    return String(line.point_to || line.point_from || '').trim() || null;
  }
  return null;
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

function normalizeOrderDestinationValue(value) {
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
    for (const key of ['name', 'label', 'title', 'destination', 'value']) {
      const normalized = normalizeOrderDestinationValue(value[key]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function extractOrderDestination(detail, summary) {
  for (const source of [detail, summary]) {
    for (const key of ORDER_DESTINATION_CANDIDATE_KEYS) {
      const normalized = normalizeOrderDestinationValue(source?.[key]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function classifyProductSegment(activeLines, hasOrderDestination) {
  if (hasOrderDestination) return 'Package';

  if (activeLines.length === 1) {
    const onlyGroup = activeLines[0]?.productGroup;
    if (onlyGroup === 'transfer') return 'Transfer';
    if (onlyGroup === 'insurance') return 'Insurance';
    if (onlyGroup === 'excursion') return 'Excursion';
  }

  const groups = new Set(activeLines.map((line) => line.productGroup));
  if (groups.has('hotel') && groups.has('airticket')) return 'Combi';
  if (groups.has('hotel')) return 'Hotel';
  if (groups.has('airticket')) return 'Airtickets';
  return 'Other';
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(label, request, retries = 3, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (attempt === retries || (status && status < 500 && status !== 429)) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`${label}: retry ${attempt + 1}/${retries} after ${delay}ms (${error.message})`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
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

async function getConfig() {
  const source = await prisma.dataSource.findUnique({
    where: { type: 'gto' },
    include: { credentials: true, settings: true },
  });
  if (!source?.credentials) throw new Error('GTO credentials not found');
  const creds = JSON.parse(decrypt(source.credentials.encryptedPayload));
  const settings = Object.fromEntries((source.settings || []).map((row) => [row.key, row.value]));
  return {
    apiKey: creds.api_key,
    baseUrl: (creds.base_url || DEFAULT_BASE_URL).replace(/\/$/, ''),
    v3BaseUrl: (settings['gto.v3_base_url'] || DEFAULT_V3_BASE_URL).replace(/\/$/, ''),
    timeoutMs: Number(settings.request_timeout_seconds || 30) * 1000,
  };
}

async function getCurrencyCodeMap(httpV3) {
  if (currencyCodeMapPromise) return currencyCodeMapPromise;
  currencyCodeMapPromise = (async () => {
    const resp = await fetchWithRetry('currencies', () => httpV3.get('/currencies'));
    const items = Array.isArray(resp.data) ? resp.data : (Array.isArray(resp.data?.data) ? resp.data.data : []);
    return Object.fromEntries(
      items
        .map((item) => [String(item.id), String(item.code || '').toUpperCase()])
        .filter(([, code]) => Boolean(code)),
    );
  })();
  return currencyCodeMapPromise;
}

function parseRatesResponse(data, codeMap) {
  const items = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  const graph = {};
  const addEdge = (from, to, rate) => {
    if (!graph[from]) graph[from] = {};
    if (!graph[to]) graph[to] = {};
    graph[from][to] = rate;
    graph[to][from] = 1 / rate;
  };
  for (const item of items) {
    const fromRaw = String(item.currency_from || '').toUpperCase();
    const toRaw = String(item.currency_to || '').toUpperCase();
    const from = codeMap[fromRaw] || fromRaw;
    const to = codeMap[toRaw] || toRaw;
    const valueFrom = parseFloat(item.value_from) || 0;
    const valueTo = parseFloat(item.value_to) || 0;
    if (!from || !to || !valueFrom) continue;
    addEdge(from, to, valueTo / valueFrom);
  }
  const rates = { EUR: 1 };
  const queue = ['EUR'];
  while (queue.length) {
    const current = queue.shift();
    const currentRate = rates[current];
    const neighbors = graph[current] || {};
    for (const [neighbor, edgeRate] of Object.entries(neighbors)) {
      if (rates[neighbor] !== undefined) continue;
      rates[neighbor] = currentRate * edgeRate;
      queue.push(neighbor);
    }
  }
  return rates;
}

async function getRatesForDate(httpV3, date) {
  const normalized = String(date).slice(0, 10);
  if (rateCache.has(normalized)) return rateCache.get(normalized);
  const codeMap = await getCurrencyCodeMap(httpV3);
  const resp = await fetchWithRetry(`currency_rates:${normalized}`, () =>
    httpV3.get('/currency_rates', { params: { date: normalized } }),
  );
  const rates = parseRatesResponse(resp.data, codeMap);
  const payload = { base: 'EUR', rates };
  rateCache.set(normalized, payload);
  return payload;
}

function toEur(amount, fromCode, rates) {
  if (amount === null || amount === undefined) return null;
  const code = String(fromCode || 'EUR').toUpperCase();
  if (code === 'EUR') return round2(amount);
  const rate = rates?.rates?.[code];
  if (!rate || rate === 0) {
    unknownCurrencies.set(code, (unknownCurrencies.get(code) || 0) + 1);
    return round2(amount);
  }
  return round2(amount / rate);
}

function computeOrderFinancials(detail, summary, convertToEur) {
  const orderCurrency = String(detail.currency || summary.currency || 'UAH');
  const balanceCurrency = String(detail.balance_currency || orderCurrency);
  const balanceAmount = parseAmount(detail.balance_amount) || 0;
  const totalAmount = parseAmount(detail.total_amount) || 0;
  const priceEur = balanceAmount > 0
    ? (convertToEur(balanceAmount, balanceCurrency) ?? 0)
    : (convertToEur(totalAmount, orderCurrency) ?? 0);

  let costEur = 0;
  const hotels = Array.isArray(detail.hotel) ? detail.hotel : [];
  const services = Array.isArray(detail.service) ? detail.service : [];
  const confirmedHotels = hotels.filter((row) => row.status === 'CNF');
  const confirmedServices = services.filter((row) => row.status === 'CNF');
  const eurTransferSuppliers = new Set(['suntransfers']);
  const supplierNameMap = buildSupplierNameMap(detail);

  for (const hotel of confirmedHotels) {
    const priceBuy = parseAmount(hotel.price_buy) || 0;
    const priceSell = parseAmount(hotel.price) || 0;
    if (priceBuy <= 0) continue;

    const hotelCurrency = String(hotel.currency || orderCurrency);
    const costConverted = convertToEur(priceBuy, hotelCurrency) ?? 0;
    const sellConverted = convertToEur(priceSell, hotelCurrency) ?? 0;
    const costUah = convertToEur(priceBuy, 'UAH') ?? costConverted;

    const hotelCost = (sellConverted > 0 && costConverted > sellConverted) ||
      (priceEur > 0 && costConverted > priceEur)
      ? costUah
      : costConverted;

    costEur += hotelCost;
  }

  for (const service of confirmedServices) {
    const priceBuy = parseAmount(service.price_buy) || 0;
    const priceSell = parseAmount(service.price) || 0;
    if (priceBuy <= 0) continue;

    let serviceCostEur;

    if (service.type === 'transfer') {
      const transferSupplier = cleanSupplierName(service.supplier_name || service.service_supplier_name).toLowerCase();
      const transferCurrency = eurTransferSuppliers.has(transferSupplier)
        ? 'EUR'
        : String(service.currency || orderCurrency);
      const transferCostConverted = convertToEur(priceBuy, transferCurrency) ?? 0;
      const transferSellConverted = convertToEur(priceSell, transferCurrency) ?? 0;
      const transferCostUah = convertToEur(priceBuy, 'UAH') ?? transferCostConverted;

      serviceCostEur = transferCurrency !== 'UAH' && (
        (transferSellConverted > 0 && transferCostConverted > transferSellConverted * 2) ||
        (priceEur > 0 && transferCostConverted > priceEur)
      )
        ? transferCostUah
        : transferCostConverted;
    } else if (service.type === 'airticket') {
      const buyCurrency = supplierTagCurrency(supplierNameMap, service.supplier_id) || String(service.currency || orderCurrency);
      const airCostConverted = convertToEur(priceBuy, buyCurrency) ?? 0;
      const airSellConverted = convertToEur(priceSell, buyCurrency) ?? 0;
      const airCostUah = convertToEur(priceBuy, 'UAH') ?? airCostConverted;

      serviceCostEur = (airSellConverted > 0 && airCostConverted > airSellConverted * 2) ||
        (priceEur > 0 && airCostConverted > priceEur)
        ? airCostUah
        : airCostConverted;
    } else {
      const serviceCurrency = String(service.currency || orderCurrency);
      const costConverted = convertToEur(priceBuy, serviceCurrency) ?? 0;
      const sellConverted = convertToEur(priceSell, serviceCurrency) ?? 0;
      const costUah = convertToEur(priceBuy, 'UAH') ?? costConverted;

      serviceCostEur = (sellConverted > 0 && costConverted > sellConverted) ||
        (priceEur > 0 && costConverted > priceEur)
        ? costUah
        : costConverted;
    }

    costEur += serviceCostEur;
  }

  const profitEur = priceEur - costEur;
  const profitPct = priceEur > 0 ? Math.round((profitEur / priceEur) * 100) : 0;
  return { costEur: round2(costEur), profitEur: round2(profitEur), profitPct };
}

async function fetchAllOrders(http, params) {
  const perPage = 1000;
  const rows = [];
  let page = 1;
  for (;;) {
    const resp = await fetchWithRetry(`orders_list page ${page}`, () =>
      http.get('/orders_list', { params: { ...params, per_page: perPage, page } }),
    );
    const body = resp.data;
    const data = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
    const keptRows = data.filter((row) => !isIgnoredTestAgentName(String(row.company_name || '')));
    rows.push(...keptRows);
    console.log(`orders_list page ${page}: ${data.length}, kept ${keptRows.length}, total ${rows.length}`);
    if (data.length < perPage) break;
    page += 1;
  }
  return rows;
}

function chunk(rows, size) {
  const result = [];
  for (let i = 0; i < rows.length; i += size) {
    result.push(rows.slice(i, i + size));
  }
  return result;
}

async function main() {
  const config = await getConfig();
  const http = axios.create({
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    params: { apikey: config.apiKey },
  });
  const httpV3 = axios.create({
    baseURL: config.v3BaseUrl,
    timeout: config.timeoutMs,
    params: { apikey: config.apiKey },
  });

  console.log('Fetching orders by start date for 2025...');
  const rows = await fetchAllOrders(http, {
    date_from: '2025-01-01',
    date_to: '2025-12-31',
    sort_by: 'date_start',
  });

  const candidateRows = rows.filter((row) => String(row.created_at || '').slice(0, 10) < '2025-01-01');
  console.log(`Candidate orders created in 2024 with start in 2025: ${candidateRows.length}`);

  const existingIds = new Set(
    (await prisma.reportingGtoOrder.findMany({
      where: { orderId: { in: candidateRows.map((row) => BigInt(Number(row.order_id))) } },
      select: { orderId: true },
    })).map((row) => Number(row.orderId)),
  );

  const missingRows = candidateRows.filter((row) => !existingIds.has(Number(row.order_id)));
  console.log(`Missing orders to insert: ${missingRows.length}`);
  if (!missingRows.length) {
    console.log(JSON.stringify({ insertedOrders: 0, insertedLines: 0, unknownCurrencies: Object.fromEntries(unknownCurrencies) }, null, 2));
    return;
  }

  const summaryById = new Map(missingRows.map((row) => [Number(row.order_id), row]));
  const details = await mapLimit(
    missingRows.map((row) => Number(row.order_id)),
    DETAIL_CONCURRENCY,
    async (orderId, index) => {
      if (index > 0 && index % 100 === 0) {
        console.log(`order_data progress: ${index}/${missingRows.length}`);
      }
      try {
        const resp = await fetchWithRetry(`order_data:${orderId}`, () =>
          http.get('/order_data', { params: { order_id: orderId } }),
        );
        return { orderId, summary: summaryById.get(orderId), detail: resp.data?.data ?? resp.data };
      } catch (error) {
        console.warn(`order_data failed for ${orderId}: ${error.message}`);
        return { orderId, summary: summaryById.get(orderId), error: error.message };
      }
    },
  );

  const successful = details.filter((row) => row.detail && !row.error);
  const orderRows = [];
  const lineRows = [];

  for (const row of successful) {
    const detail = row.detail;
    const summary = row.summary || {};
    if (isIgnoredLookerOrder(summary, detail)) {
      continue;
    }
    const createdAtText = String(detail.created_at || summary.created_at || '');
    const bookingDate = createdAtText.slice(0, 10);
    const rates = await getRatesForDate(httpV3, bookingDate);

    const hotelLines = Array.isArray(detail.hotel) ? detail.hotel : [];
    const serviceLines = Array.isArray(detail.service) ? detail.service : [];
    const allLines = [
      ...hotelLines.map((line) => ({ productGroup: 'hotel', raw: line })),
      ...serviceLines.map((line) => ({ productGroup: productGroupForService(line), raw: line })),
    ];

    const activeLines = allLines.filter(({ raw }) => isActiveStatus(raw.status));
    const activeProductGroups = Array.from(new Set(
      activeLines.map(({ productGroup }) => productGroup),
    ));
    const destinations = Array.from(new Set(
      allLines.map(({ productGroup, raw }) => extractDestinationRaw(raw, productGroup)).filter(Boolean),
    ));
    const comments = Array.isArray(detail.comment) ? detail.comment : [];
    const urgentCommentCount = comments.filter((comment) => String(comment.type || '').toLowerCase() === 'urgent').length;
    const countries = Array.isArray(detail.country) ? detail.country : [];
    const suppliers = Array.isArray(detail.supplier) ? detail.supplier : [];

    const orderId = Number(detail.order_id || row.orderId);
    const totalAmountOriginal = parseAmount(detail.total_amount);
    const balanceAmountOriginal = parseAmount(detail.balance_amount);
    const financials = computeOrderFinancials(detail, summary, (amount, currency) => toEur(amount, currency, rates));
    const packageDestinationName = extractOrderDestination(detail, summary);
    const hasOrderDestination = Boolean(packageDestinationName);
    const productSegment = classifyProductSegment(activeLines, hasOrderDestination);

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
      totalAmountEur: decimalValue(toEur(totalAmountOriginal, detail.currency, rates)),
      balanceAmountOriginal: decimalValue(balanceAmountOriginal),
      balanceAmountEur: decimalValue(toEur(balanceAmountOriginal, detail.balance_currency || detail.currency, rates)),
      costAmountEur: decimalValue(financials.costEur),
      profitEur: decimalValue(financials.profitEur),
      profitPct: financials.profitPct,
      bookingRateDate: bookingDate ? parseDateOnly(bookingDate) : null,
      touristsCount: Array.isArray(detail.tourist) ? detail.tourist.length : 0,
      countriesCount: countries.length,
      countryNames: countries.map((country) => country.name).filter(Boolean).join(' | ') || null,
      primaryCountryName: String(countries[0]?.name || '') || null,
      suppliersCount: suppliers.length,
      supplierNames: suppliers.map((supplier) => supplier.name).filter(Boolean).join(' | ') || null,
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
        priceEur: decimalValue(toEur(priceOriginal, raw.currency, rates)),
        priceBuyOriginal: decimalValue(priceBuyOriginal),
        priceBuyEur: decimalValue(toEur(priceBuyOriginal, raw.currency, rates)),
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

  const orderIds = orderRows.map((row) => row.orderId);

  for (const ids of chunk(orderIds, DELETE_CHUNK)) {
    await prisma.reportingGtoOrderLine.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.reportingGtoOrder.deleteMany({ where: { orderId: { in: ids } } });
  }

  let insertedOrders = 0;
  let insertedLines = 0;
  for (const rows of chunk(orderRows, INSERT_CHUNK)) {
    const result = await prisma.reportingGtoOrder.createMany({ data: rows });
    insertedOrders += result.count;
  }
  for (const rows of chunk(lineRows, INSERT_CHUNK)) {
    const result = await prisma.reportingGtoOrderLine.createMany({ data: rows });
    insertedLines += result.count;
  }

  console.log(JSON.stringify({
    candidateOrders: candidateRows.length,
    missingOrders: missingRows.length,
    successfulDetails: successful.length,
    failedDetails: details.filter((row) => row.error).length,
    insertedOrders,
    insertedLines,
    unknownCurrencies: Object.fromEntries(unknownCurrencies),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
