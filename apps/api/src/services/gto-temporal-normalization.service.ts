const MIN_VALID_GTO_DATE = Date.UTC(2000, 0, 1);
const KYIV_TIMEZONE = 'Europe/Kyiv';

export type GtoDateSource = 'orders_list' | 'order_data' | 'service_window' | 'unresolved';

export type GtoTemporalLine = {
  dateFrom?: unknown;
  dateTo?: unknown;
};

export type GtoTemporalNormalizationInput = {
  ordersListDateStart?: unknown;
  ordersListDateEnd?: unknown;
  orderDataDateStart?: unknown;
  orderDataDateEnd?: unknown;
  createdAt?: unknown;
  lines: GtoTemporalLine[];
};

export type GtoLineDateRange = {
  dateFrom: Date | null;
  dateTo: Date | null;
  hasInvalidDateRange: boolean;
  isUsableForOrderWindow: boolean;
};

export type GtoTemporalNormalizationResult = {
  dateStart: Date | null;
  dateEnd: Date | null;
  sourceDateStart: Date | null;
  sourceDateEnd: Date | null;
  dateStartSource: GtoDateSource;
  dateEndSource: GtoDateSource;
  dateQualityStatus: 'valid' | 'warning' | 'unresolved';
  dateQualityFlags: string[];
  salesLeadDays: number | null;
  validServiceLines: number;
  invalidServiceLines: number;
};

function utcDate(year: number, month: number, day: number) {
  const result = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(result.getTime()) ? null : result;
}

function dateFromTimestamp(value: number) {
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
  const instant = new Date(milliseconds);
  if (Number.isNaN(instant.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  return utcDate(part('year'), part('month'), part('day'));
}

export function parseGtoDateOnly(value?: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : utcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number' && Number.isFinite(value)) return dateFromTimestamp(value);

  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return dateFromTimestamp(Number(text));
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? utcDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function isValidGtoDate(value: Date | null) {
  return Boolean(value && value.getTime() >= MIN_VALID_GTO_DATE);
}

function dayDifference(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function hasDateValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function evaluateGtoLineDateRange(line: GtoTemporalLine): GtoLineDateRange {
  const dateFrom = parseGtoDateOnly(line.dateFrom);
  const dateTo = parseGtoDateOnly(line.dateTo);
  const hasBothDates = hasDateValue(line.dateFrom) && hasDateValue(line.dateTo);
  const isUsableForOrderWindow = Boolean(
    isValidGtoDate(dateFrom)
    && isValidGtoDate(dateTo)
    && dateFrom
    && dateTo
    && dateTo.getTime() >= dateFrom.getTime(),
  );

  return {
    dateFrom,
    dateTo,
    hasInvalidDateRange: hasBothDates && !isUsableForOrderWindow,
    isUsableForOrderWindow,
  };
}

function firstValidDate(candidates: Array<{ source: GtoDateSource; value: Date | null }>) {
  return candidates.find((candidate) => isValidGtoDate(candidate.value)) || null;
}

export function normalizeGtoOrderTemporalData(input: GtoTemporalNormalizationInput): GtoTemporalNormalizationResult {
  const lines = input.lines.map(evaluateGtoLineDateRange);
  const usableLines = lines.filter((line) => line.isUsableForOrderWindow);
  const invalidServiceLines = lines.filter((line) => line.hasInvalidDateRange).length;
  const serviceStart = usableLines.reduce<Date | null>(
    (earliest, line) => !earliest || (line.dateFrom && line.dateFrom < earliest) ? line.dateFrom : earliest,
    null,
  );
  const serviceEnd = usableLines.reduce<Date | null>(
    (latest, line) => !latest || (line.dateTo && line.dateTo > latest) ? line.dateTo : latest,
    null,
  );

  const ordersListStart = parseGtoDateOnly(input.ordersListDateStart);
  const ordersListEnd = parseGtoDateOnly(input.ordersListDateEnd);
  const sourceDateStart = parseGtoDateOnly(input.orderDataDateStart);
  const sourceDateEnd = parseGtoDateOnly(input.orderDataDateEnd);
  const flags: string[] = [];

  if (hasDateValue(input.ordersListDateStart) && !isValidGtoDate(ordersListStart)) flags.push('invalid_orders_list_date_start');
  if (hasDateValue(input.ordersListDateEnd) && !isValidGtoDate(ordersListEnd)) flags.push('invalid_orders_list_date_end');
  if (hasDateValue(input.orderDataDateStart) && !isValidGtoDate(sourceDateStart)) flags.push('invalid_order_data_date_start');
  if (hasDateValue(input.orderDataDateEnd) && !isValidGtoDate(sourceDateEnd)) flags.push('invalid_order_data_date_end');
  if (invalidServiceLines > 0) flags.push('invalid_service_date_range');

  const startCandidate = firstValidDate([
    { source: 'orders_list', value: ordersListStart },
    { source: 'order_data', value: sourceDateStart },
    { source: 'service_window', value: serviceStart },
  ]);
  const dateStart = startCandidate?.value || null;
  const dateStartSource = startCandidate?.source || 'unresolved';

  const endCandidates = [
    { source: 'orders_list' as GtoDateSource, value: ordersListEnd },
    { source: 'order_data' as GtoDateSource, value: sourceDateEnd },
    { source: 'service_window' as GtoDateSource, value: serviceEnd },
  ];
  const endCandidate = endCandidates.find((candidate) => {
    return isValidGtoDate(candidate.value) && (!dateStart || Boolean(candidate.value && candidate.value >= dateStart));
  }) || null;
  const dateEnd = endCandidate?.value || null;
  const dateEndSource = endCandidate?.source || 'unresolved';

  if (!dateStart) flags.push('unresolved_date_start');
  if (!dateEnd && (hasDateValue(input.ordersListDateEnd) || hasDateValue(input.orderDataDateEnd) || usableLines.length > 0)) {
    flags.push('unresolved_date_end');
  }
  if (dateStartSource === 'service_window') flags.push('date_start_from_service_window');
  if (dateEndSource === 'service_window') flags.push('date_end_from_service_window');

  const createdAt = parseGtoDateOnly(input.createdAt);
  const salesLeadDays = createdAt && dateStart ? dayDifference(createdAt, dateStart) : null;

  return {
    dateStart,
    dateEnd,
    sourceDateStart,
    sourceDateEnd,
    dateStartSource,
    dateEndSource,
    dateQualityStatus: !dateStart ? 'unresolved' : flags.length ? 'warning' : 'valid',
    dateQualityFlags: flags,
    salesLeadDays,
    validServiceLines: usableLines.length,
    invalidServiceLines,
  };
}
