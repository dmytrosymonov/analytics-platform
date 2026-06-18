export const CURRENT_PROFIT_LOGIC_VERSION = 2;

export type ProfitBasis =
  | 'zero_for_non_cnf'
  | 'raw_margin'
  | 'amount_details_row_margin'
  | 'amount_details_net_basis'
  | 'discount_fallback'
  | 'special_reconciliation_rule';

export type CostBasis =
  | 'api_rate_direct'
  | 'amount_details_row_margin'
  | 'amount_details_implied_fx'
  | 'discount_adjusted_margin'
  | 'incomplete_core_fallback';

export type CanonicalProfitLine = {
  productGroup: string;
  rawType?: string | null;
  serviceTypeName?: string | null;
  status?: string | null;
  priceOriginal?: number | null;
  priceBuyOriginal?: number | null;
  priceBuyEur?: number | null;
};

export type CanonicalProfitResult = {
  costAmountEur: number;
  profitEur: number;
  profitPct: number;
  profitBasisUsed: ProfitBasis;
  costBasisUsed: CostBasis;
  hasIncompleteCoreCost: boolean;
};

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeStatus(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function isConfirmedLine(line: CanonicalProfitLine) {
  return normalizeStatus(line.status) === 'CNF';
}

function isCoreLine(line: CanonicalProfitLine) {
  return ['hotel', 'airticket', 'transfer'].includes(String(line.productGroup || '').toLowerCase());
}

function isZeroValueLine(line: CanonicalProfitLine) {
  return (line.priceOriginal || 0) <= 0 && (line.priceBuyOriginal || 0) <= 0;
}

function isExplicitZeroCostAddon(line: CanonicalProfitLine) {
  if ((line.priceOriginal || 0) <= 0 || (line.priceBuyOriginal || 0) > 0) return false;
  const text = [
    line.productGroup,
    line.rawType,
    line.serviceTypeName,
  ].map((value) => String(value || '').toLocaleLowerCase('uk-UA')).join(' ');
  return ['luggage', 'baggage', 'багаж', 'доплата', 'addon', 'add-on', 'supplement'].some((needle) => text.includes(needle));
}

export function hasMissingRequiredBuyCost(line: CanonicalProfitLine) {
  if (!isCoreLine(line)) return false;
  if (!isConfirmedLine(line)) return false;
  if (isZeroValueLine(line)) return false;
  if (isExplicitZeroCostAddon(line)) return false;
  return (line.priceOriginal || 0) > 0 && (line.priceBuyOriginal || 0) <= 0;
}

function isCostBearingLine(line: CanonicalProfitLine) {
  return isConfirmedLine(line) && (line.priceBuyEur || 0) > 0;
}

export function calculateCanonicalProfit(
  orderStatus: string | null | undefined,
  revenueEur: number,
  lines: CanonicalProfitLine[],
): CanonicalProfitResult {
  if (normalizeStatus(orderStatus) !== 'CNF') {
    return {
      costAmountEur: 0,
      profitEur: 0,
      profitPct: 0,
      profitBasisUsed: 'zero_for_non_cnf',
      costBasisUsed: 'api_rate_direct',
      hasIncompleteCoreCost: false,
    };
  }

  const hasIncompleteCoreCost = lines.some(hasMissingRequiredBuyCost);
  const costAmountEur = round2(lines
    .filter(isCostBearingLine)
    .reduce((sum, line) => sum + (line.priceBuyEur || 0), 0));
  const profitEur = round2(revenueEur - costAmountEur);

  return {
    costAmountEur,
    profitEur,
    profitPct: revenueEur > 0 ? Math.round((profitEur / revenueEur) * 100) : 0,
    profitBasisUsed: 'raw_margin',
    costBasisUsed: 'api_rate_direct',
    hasIncompleteCoreCost,
  };
}
