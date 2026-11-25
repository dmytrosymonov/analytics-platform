export type FinancialAdjustmentSnapshot = {
  id: string | null;
  type: string;
  amount: number;
  currency: string;
  status: string | null;
  bonus_status: string | null;
  created_at: string | null;
  updated_at: string | null;
  amount_eur: number | null;
  eligible: boolean;
  source: JsonRecord;
};

type JsonRecord = Record<string, any>;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function isEligibleFinancialAdjustment(type: string, status: string | null, bonusStatus: string | null) {
  if (type === 'kickback') return String(status || '').trim().toLowerCase() === 'confirmed';
  if (type === 'bonus') return String(bonusStatus || '').trim().toLowerCase() !== 'accrued_and_expired';
  return false;
}

export function buildFinancialAdjustmentSnapshots(
  rawAdjustments: unknown,
  parseAmount: (value: unknown) => number | null,
  normalizeCurrency: (value: unknown) => string | null,
  defaultCurrency: string,
  toEur: (amount: number, currency: string) => number | null,
): FinancialAdjustmentSnapshot[] {
  if (!Array.isArray(rawAdjustments)) {
    throw new Error('financial_adjustments is missing or is not an array');
  }

  return rawAdjustments.flatMap((value: JsonRecord) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('financial_adjustments contains a non-object entry');
    }
    const type = String(value.type || '').trim().toLowerCase();
    const amount = parseAmount(value.amount);
    const isCostAdjustment = type === 'bonus' || type === 'kickback';
    if (isCostAdjustment && (amount === null || amount <= 0)) {
      throw new Error(`financial_adjustments ${type} has a non-positive or invalid amount`);
    }
    const currency = normalizeCurrency(value.currency) || defaultCurrency;
    const status = value.status == null ? null : String(value.status);
    const bonusStatus = value.bonus_status == null ? null : String(value.bonus_status);
    const eligible = isCostAdjustment && isEligibleFinancialAdjustment(type, status, bonusStatus);
    const amountEur = amount === null ? null : toEur(amount, currency);
    if (eligible && (amountEur === null || !Number.isFinite(amountEur))) {
      throw new Error(`financial_adjustments ${type} could not be converted to EUR`);
    }
    return [{
      id: value.id == null ? null : String(value.id),
      type,
      amount: round2(amount || 0),
      currency,
      status,
      bonus_status: bonusStatus,
      created_at: value.created_at == null ? null : String(value.created_at),
      updated_at: value.updated_at == null ? null : String(value.updated_at),
      amount_eur: amountEur,
      eligible,
      source: value,
    }];
  });
}

export function sumEligibleStoredAdjustments(rawAdjustments: unknown) {
  if (!Array.isArray(rawAdjustments)) {
    throw new Error('Stored financial_adjustments is missing or is not an array');
  }
  let total = 0;
  for (const item of rawAdjustments as JsonRecord[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Stored financial_adjustments contains a non-object entry');
    }
    const type = String(item.type || '').trim().toLowerCase();
    if (type !== 'bonus' && type !== 'kickback') continue;
    if (!isEligibleFinancialAdjustment(type, item.status, item.bonus_status)) continue;
    if (item.amount_eur == null) {
      throw new Error(`Stored financial_adjustments ${type} has no EUR amount`);
    }
    const amountEur = Number(item.amount_eur);
    if (!Number.isFinite(amountEur) || amountEur < 0) {
      throw new Error(`Stored financial_adjustments ${type} has invalid amount_eur`);
    }
    total += amountEur;
  }
  return round2(total);
}
