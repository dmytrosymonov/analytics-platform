# GTO.UA Agent Segmentation Model

> Updated: 2026-07-31
> Production source: `mart_gto_ua_agent_segment_*` in PostgreSQL
> Scope: commercial GTO.UA agents

## Production Rules

The production model is defined by the approved 2026-07-27 Looker Studio specification and is calculated in PostgreSQL, never in Looker Studio calculated fields.

- source: `reporting_gto_orders`, one row per order;
- scope: normalized `structure_name = gto.ua`, commercial agents only;
- scope exceptions: `reporting_gto_agent_scope_overrides` with audited include/exclude rules;
- identity: `agent:<agent_id>`; a normalized-name key is a lower-confidence fallback only;
- time axis: `created_at` in `Europe/Kyiv`;
- segment input: CNF only; CNX is a quality signal and may create a Ghost, but never demotes a segment;
- GMV: `COALESCE(balance_amount_eur, total_amount_eur)`; EUR is already normalized in reporting and is not recalculated in Looker Studio;
- snapshots: daily from `2025-01-01`; earlier snapshots are not built because the required 2023 rolling history is incomplete;
- movements: consecutive completed Friday snapshots.

Segment precedence is: Flagships (`CNF >= 100` and GMV share `>= 0.89%`), Key Accounts (`31`, `0.28%`), Risers (`11`, `0.10%`), Sprouts (`>=4`), Dippers (`2-3`), One-Timers (`1`), Ghosts (`0 CNF` with CNX).

The historical v2 rules below are retained only as local-analysis background. They must not be used to build or modify production marts when they conflict with the production rules above.

## Purpose

This document is the local working specification for agent segmentation and segment-movement analysis.
Use it as the source of truth for future analytics questions about:

- current agent segment;
- movement between segments over time;
- growth, retention, and quality-risk queues;
- commercial prioritization of agents inside GTO.UA.

This spec is derived from the June 24, 2026 segmentation document and translated into execution rules for the canonical local SQLite database.

As of 2026-06-29, the working model in this repo is **Segmentation v2: Count + Money**:

- count-based monthly segment remains the official segment;
- money becomes a second official axis through `value_tier_365`;
- movement is tracked independently for segment and value tier;
- commercial analysis should use the combined matrix `segment_current x value_tier_365`.

## Source Summary

The source document defines a hybrid segmentation model for GTO.UA agents:

- lower segments are behavioral;
- upper segments are based on both absolute CNF volume and share of total rolling-365 CNF base;
- official segment is recalculated monthly;
- short-term movement is monitored weekly via 30 / 90 / 365 day windows;
- CNX is not part of the segment itself, but acts as a quality overlay.

Reference source snapshot figures from the document:

- snapshot 1: as of 2026-05-01, rolling-365 window `2025-05-01..2026-04-30`, total CNF base `11,261`;
- snapshot 2: as of 2026-06-20, rolling-365 window `2025-06-21..2026-06-20`, total CNF base `11,781`;
- segment movements between those snapshots:
  - stayed in same segment: `923`
  - moved up: `141`
  - moved down: `114`
  - appeared in rolling-365 base: `81`
  - dropped out of rolling-365 base: `57`

## Local Data Inputs

Use `output/database/gto_analytics.sqlite`.

Required fields:

- order grain:
  - `order_id`
  - `created_at`
  - `status`
  - `structure_id`
  - `structure_name`
- agent grain:
  - `agent_id`
  - `agent_name`
- service grain for package approximation:
  - `hotel[]`
  - `service[]`
  - `service[].service_type_name`

Use `orders` and `order_details` as the primary source. Use `order_financials_eur` for EUR-normalized totals and the normalized hotel/service tables for product composition.

## Eligibility and Filters

For official GTO.UA agent segmentation:

- market filter: only orders where normalized `structure_name = gto.ua`;
- time basis: `created_at`;
- volume basis: `CNF` orders only;
- unit of count: one order = one CNF;
- agent basis: external agents only.

Exclude:

- internal GTO accounts;
- explicit test accounts;
- obvious technical or training entries.

Minimum exclusion set from the source document:

- `GTO.UA`
- `GTO для внутрішнього користування`
- `TestAgency`
- explicit names containing `test`

For future analytics, use a normalized exclusion rule and preserve the excluded rows separately if audit is needed.

## Agent Identity

For movement tracking, use:

- primary key: `agent_id`
- display label: latest non-empty `agent_name`

Do not use raw `agent_name` alone as the movement key, because naming can change while the commercial entity remains the same.

If `agent_id` is missing for a row, fall back to normalized `agent_name`, but mark that result as lower-confidence identity matching.

## Official Segment Model

Segment order from lowest to highest:

1. `ghosts`
2. `hello_bye`
3. `swiped`
4. `sprouts`
5. `risers`
6. `key`
7. `flagships`

Business labels from the source:

- `ghosts` = `0 CNF`, but there were attempts / CNX
- `hello_bye` = `1 CNF`
- `swiped` = `2-3 CNF`
- `sprouts` = `4+ CNF`, but below `risers`
- `risers` = hybrid threshold
- `key` = hybrid threshold
- `flagships` = hybrid threshold

### Hybrid thresholds

Upper segments use both:

- an absolute minimum CNF floor;
- a minimum share of the total rolling-365 CNF base.

Threshold definitions from the source:

- `risers`: `>= max(11 CNF, 0.10% of total CNF 365)`
- `key`: `>= max(31 CNF, 0.28% of total CNF 365)`
- `flagships`: `>= max(100 CNF, 0.89% of total CNF 365)`

Important implementation rule:

- persist the effective integer thresholds used in each monthly snapshot;
- do not recalculate historical snapshots later using a different rounding assumption.

The source document shows these effective thresholds:

- snapshot as of 2026-05-01: `risers=11`, `key=31`, `flagships=100`
- snapshot as of 2026-06-20: `risers=12`, `key=33`, `flagships=105`

For future monthly runs, store both:

- raw share thresholds;
- final integer thresholds actually applied in that snapshot.

## Snapshot Cadence

Use two layers of monitoring:

### 1. Official monthly segment

- recompute once per month;
- window: rolling 365 days by `created_at`;
- metric: `CNF` only;
- this is the authoritative segment for reporting and movement history.

### 2. Weekly dynamics

Update weekly operational signals for:

- `cnf_30`
- `cnf_90`
- `cnf_365`
- `cnf_share_30`
- `cnf_share_90`
- `cnf_share_365`
- `momentum_index`
- `cnx_rate_365`
- `package_rate_365`
- `last_cnf_date`

Weekly dynamics do not replace the official monthly segment.

## Movement Logic

Movement must be calculated between two official monthly snapshots.

Possible movement outcomes:

- `same_segment`
- `moved_up`
- `moved_down`
- `new_in_base`
- `dropped_from_base`

Use segment ranks:

- `ghosts=1`
- `hello_bye=2`
- `swiped=3`
- `sprouts=4`
- `risers=5`
- `key=6`
- `flagships=7`

Rules:

- if agent exists in both snapshots:
  - higher rank -> `moved_up`
  - lower rank -> `moved_down`
  - same rank -> `same_segment`
- if absent in previous and present in current -> `new_in_base`
- if present in previous and absent in current -> `dropped_from_base`

For upper-segment governance:

- upward move into top segments should preferably be confirmed by two consecutive monthly snapshots or by manual commercial confirmation;
- downward move from `key` or `flagships` should not trigger automatic demotion without manual review.

## Momentum and Risk Signals

Primary dynamics signal from the source:

- `momentum_index = cnf_share_90 / cnf_share_365`

Interpretation:

- `> 1.30` -> growing faster than base
- `0.85 .. 1.30` -> stable
- `0.65 .. 0.85` -> losing share
- `< 0.65` -> risk zone

Growth queue criteria:

- `cnf_365 >= 4`
- `cnf_90 >= 4`
- `momentum_index >= 1.30`

Risk queue criteria:

- current segment `risers+`
- and either `momentum_index < 0.65`
- or `last_cnf_date` older than `60` days

Interpret risk as a retention signal, not as an automatic demotion.

## Quality Overlay

CNX does not define the segment.
It is a quality overlay that can block auto-promotion or trigger investigation.

Quality-risk criteria from the source:

- `cnf_365 >= 4`
- total orders `>= 10`
- `cnx_rate_365 >= 30%`

Interpretation:

- high CNX may indicate booking-confirmation issues, agent behavior, weak support, or poor supply fit;
- quality-risk should open a curator / reservation / supply review, especially for commercially important agents.

## Package Rate Approximation

The source document uses a working approximation:

- package-like order = CNF order with `2+` different `service_type_name` values

This is operationally useful, but not yet a final BI-grade package classifier.
Preserve it as `package_rate_365_working` or clearly label it as approximate.

## Value Tier v2

The repo now uses a second official axis for commercial value.

### Principle

- do not replace the count-based official segment with a revenue-only segment;
- classify commercial value separately from booking maturity;
- use EUR-normalized rolling-365 GMV share as the money signal.

### Value tier rules

Use `gmv_share_365` as the primary value signal.

Current default tiers:

- `immature`: `cnf_365 < 4`
- `low_value`: `cnf_365 >= 4`, but below medium threshold
- `medium_value`: `gmv_share_365 >= 0.10%` and `cnf_365 >= 4`
- `high_value`: `gmv_share_365 >= 0.28%` and `cnf_365 >= 12`
- `strategic_value`: `gmv_share_365 >= 0.89%` and `cnf_365 >= 12`

Implementation note:

- share thresholds are frozen per snapshot through absolute EUR thresholds saved in the snapshot output;
- top value tiers should be confirmed by two consecutive monthly snapshots or by manual commercial confirmation.

### Composite view

The operational default is the combined label:

- `composite_view = segment_current + value_tier_365`

Examples:

- `Sprouts + High Value`
- `Key + Medium Value`
- `Flagships + Strategic Value`

### Weekly value dynamics

Weekly monitoring should include:

- `gmv_30_eur`
- `gmv_90_eur`
- `gmv_365_eur`
- `gmv_share_90`
- `gmv_share_365`
- `value_momentum = gmv_share_90 / gmv_share_365`

If a future composite score is needed, use it only as an analytical helper.
Do not replace the official segment with that score.

Recommended starting formula:

- `composite_score_365 = sqrt(cnf_share_365 * gmv_share_365)`

This remains optional and is not required for the current official model.

## Recommended Output Fields

Persist these fields for every monthly snapshot:

- `snapshot_date`
- `window_from`
- `window_to`
- `agent_id`
- `agent_name`
- `segment_current`
- `segment_rank`
- `effective_risers_threshold`
- `effective_key_threshold`
- `effective_flagships_threshold`
- `cnf_365`
- `cnf_share_365`
- `gmv_365_eur`
- `gmv_share_365`
- `avg_order_value_365_eur`
- `value_tier_365`
- `value_tier_rank`
- `composite_view`
- `cnx_365`
- `cnx_rate_365`
- `package_rate_365`
- `last_cnf_date`
- `included_in_base`

Persist these fields for weekly monitoring:

- `snapshot_date`
- `agent_id`
- `agent_name`
- `segment_current`
- `segment_previous`
- `cnf_30`
- `cnf_90`
- `cnf_365`
- `cnf_share_90`
- `cnf_share_365`
- `gmv_30_eur`
- `gmv_90_eur`
- `gmv_365_eur`
- `gmv_share_90`
- `gmv_share_365`
- `momentum_index`
- `value_momentum`
- `cnx_rate_365`
- `package_rate_365`
- `last_cnf_date`
- `growth_flag`
- `risk_flag`
- `quality_risk_flag`

Persist these fields for movement analysis:

- `snapshot_date_prev`
- `snapshot_date_curr`
- `agent_id`
- `agent_name_prev`
- `agent_name_curr`
- `segment_prev`
- `segment_curr`
- `segment_movement_type`
- `value_tier_prev`
- `value_tier_curr`
- `value_movement_type`
- `rank_prev`
- `rank_curr`
- `cnf_365_prev`
- `cnf_365_curr`
- `gmv_365_eur_prev`
- `gmv_365_eur_curr`
- `cnf_90_curr`
- `gmv_90_eur_curr`
- `momentum_index_curr`
- `value_momentum_curr`
- `cnx_rate_365_curr`

## Operational Use

Use the model for:

- monthly commercial review;
- curator action queues;
- retention watchlists for large agents;
- promotion candidates in `sprouts` and `risers`;
- quality escalation for high-CNX agents;
- future dashboards and CRM enrichment.

This model should be the default reference when the user asks:

- which segment an agent belongs to;
- who moved up or down;
- who is accelerating;
- who is at risk;
- how the structure of the GTO.UA agent base is changing.

## Local Limitations

Important limitations from the source and local snapshot:

- segment metric is based on `CNF` orders only;
- official window is rolling 365 by `created_at`, not by `date_start`;
- June 24 source analysis used a local cache refreshed on 2026-06-23;
- late changes to older orders after that refresh were not included in the source document;
- package-rate logic is approximate;
- exclusion rules for internal/test agents should stay explicit and auditable.

As of the current local cache refreshed on 2026-06-29:

- we have a newer local base than the source document used;
- future movement analyses should continue to follow the same model, but metrics may differ from the source document because the underlying local cache is fresher.

## Local Builder

Current local builder:

- `tmp/build_gto_agent_segmentation_v2.js`

Frozen historical overrides currently baked into the local builder:

- count thresholds for `2026-05-01`: `11 / 31 / 100`
- count thresholds for `2026-06-20`: `12 / 33 / 105`
- snapshot window end override for `2026-05-01` -> `2026-04-30`, to stay aligned with the source document framing

Current outputs:

- `reports/gto-agent-segmentation-v2/summary.json`
- `reports/gto-agent-segmentation-v2/monthly-snapshots.json`
- `reports/gto-agent-segmentation-v2/monthly-snapshots.csv`
- `reports/gto-agent-segmentation-v2/movements.json`
- `reports/gto-agent-segmentation-v2/movements.csv`
- `reports/gto-agent-segmentation-v2/weekly-dynamics-<snapshot_date>.json`
- `reports/gto-agent-segmentation-v2/weekly-dynamics-<snapshot_date>.csv`
