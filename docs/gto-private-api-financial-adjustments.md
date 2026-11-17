# GTO Private API Financial Adjustments Contract

## Purpose

Allow reporting consumers to calculate the same final order economics as the
back office without guessing from unrelated fields. The private `order_data`
response must expose order-level kickbacks and bonus accruals separately from
service lines, discounts, commissions, and payments.

## Proposed response field

`order_data` returns `financial_adjustments`; the API contract specifies an
empty array when the order has no eligible adjustments. Bonus entries derived
from kickback are omitted by the API to prevent double counting. Promotional
and referral bonuses are outside this contract.

```json
{
  "financial_adjustments": [
    {
      "id": 12345,
      "type": "kickback",
      "amount": 41.63,
      "currency": "EUR",
      "status": "confirmed",
      "created_at": "2026-10-31 13:23:00",
      "updated_at": "2026-10-31 13:23:00"
    },
    {
      "id": 12346,
      "type": "bonus",
      "amount": 10.00,
      "currency": "EUR",
      "bonus_status": "accrued_not_redeemed",
      "created_at": "2026-10-31 13:23:00",
      "updated_at": "2026-10-31 13:23:00"
    }
  ]
}
```

`amount` is always positive. Its effect is determined by `type` and, for a
bonus, `bonus_status`.

## Business rules

- Every confirmed `kickback` is an expense and reduces final order profit.
- Cancelled kickbacks are returned with `status = cancelled` and do not reduce
  profit.
- A bonus with `accrued_not_redeemed` is an expense and reduces final order
  profit.
- A bonus with `accrued_and_redeemed` is an expense and reduces final order
  profit.
- A bonus with `accrued_and_expired` must be returned for audit, but must not
  reduce final order profit.
- Return each adjustment as a separate record. Do not merge adjustments into
  `discount`, `commission`, payment totals, or service `price_buy`.
- The API does not return bonuses created from kickback, promotional bonuses,
  or referral bonuses. Do not synthesize them on the reporting side.
- An edit to an adjustment must update both the adjustment `updated_at` and
  the order `updated_at` so incremental consumers refresh the order.

## Reporting formula after API delivery

```text
final_profit_eur = api_visible_service_margin_eur
                   - confirmed_kickback_eur
                   - non_expired_accrued_bonus_eur
```

The reporting pipeline performs conversion to EUR using the booking-date
historical FX rate and persists eligible adjustment details for audit. Looker Studio must consume
the resulting order-level field rather than recalculate this logic.

## Reference case

For order `739359`, the private API currently yields a service margin of
`95.42 EUR`. The back office additionally displays `kickback = 41.63 EUR` and
`Real income = 53.70 EUR`. This demonstrates why the adjustment must be
supplied by the API as a first-class financial record.
