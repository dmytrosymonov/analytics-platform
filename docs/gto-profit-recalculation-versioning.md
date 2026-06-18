# GTO Profit Recalculation Versioning

## Purpose

Keep Data Studio on the current PostgreSQL reporting tables while separating:

- source refresh from GTO API
- derived profit recalculation on existing reporting rows

## Rules

- API refresh updates source-derived order state:
  - status
  - dates
  - tourists
  - source amounts
  - line composition
- DB-only recalculation updates only derived profit fields on `reporting_gto_orders`.
- Profit math changes must default to DB-only recalculation, not full API backfill.

## Reporting Fields

`reporting_gto_orders` keeps rollout metadata:

- `profit_logic_version`
- `profit_recalculated_at`

These fields do not change the Data Studio datasource contract. They only show which rows have already been recalculated by the active canonical engine.

## Operational Contract

- All sync paths and the DB-only recalculation CLI must use the same canonical profit engine.
- API refresh must not overwrite rows back to legacy profit logic.
- Full API backfill is needed only when source data itself is stale or when new source fields must be ingested.
