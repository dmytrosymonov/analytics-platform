import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialAdjustmentSnapshots, sumEligibleStoredAdjustments } from './gto-financial-adjustments';

const amount = (value: unknown) => value == null || value === '' ? null : Number(value);
const currency = (value: unknown) => value == null ? null : String(value).toUpperCase();
const toEur = (value: number, code: string) => code === 'EUR' ? value : value / 2;

test('records all bonuses except expired and confirmed kickbacks', () => {
  const adjustments = buildFinancialAdjustmentSnapshots([
    { id: 1, type: 'bonus', amount: 10, currency: 'EUR', bonus_status: 'accrued_not_redeemed' },
    { id: 2, type: 'bonus', amount: 20, currency: 'EUR', bonus_status: 'accrued_and_redeemed' },
    { id: 3, type: 'bonus', amount: 30, currency: 'EUR', bonus_status: 'accrued_and_expired' },
    { id: 4, type: 'kickback', amount: 8, currency: 'EUR', status: 'confirmed' },
    { id: 5, type: 'kickback', amount: 9, currency: 'EUR', status: 'cancelled' },
    { id: 6, type: 'future_type', vendor_field: 'keep-me' },
  ], amount, currency, 'UAH', toEur);

  assert.deepEqual(adjustments.map((item) => item.eligible), [true, true, false, true, false, false]);
  assert.deepEqual(adjustments[5].source, { id: 6, type: 'future_type', vendor_field: 'keep-me' });
  assert.equal(sumEligibleStoredAdjustments(adjustments), 38);
});

test('converts each adjustment using its own currency', () => {
  const [adjustment] = buildFinancialAdjustmentSnapshots([
    { type: 'bonus', amount: 12, currency: 'KZT', bonus_status: 'accrued_not_redeemed' },
  ], amount, currency, 'EUR', toEur);
  assert.equal(adjustment.amount_eur, 6);
});

test('rejects missing arrays and malformed adjustment amounts', () => {
  assert.throws(() => buildFinancialAdjustmentSnapshots(undefined, amount, currency, 'EUR', toEur));
  assert.throws(() => buildFinancialAdjustmentSnapshots([
    { type: 'kickback', amount: 0, currency: 'EUR', status: 'confirmed' },
  ], amount, currency, 'EUR', toEur));
});
