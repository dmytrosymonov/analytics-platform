# GTO.UA Agent Performance Marts

> Updated: 2026-08-01
> Source: PostgreSQL reporting database
> Scope: commercial `gto.ua` agents, using `created_at` in `Europe/Kyiv`

These views are the backend contract for the agent-movement pages in Looker Studio. They calculate scope, status handling, EUR amounts, relative comparison windows, and GMV-driver arithmetic in PostgreSQL. Looker Studio must not recreate these rules with blends.

All revenue is `COALESCE(balance_amount_eur, total_amount_eur)`. Financial metrics use `CNF` only unless a field explicitly says otherwise. The commercial-agent scope, identity, and technical/test exclusions are exactly the same as in `mart_gto_ua_agent_segment_snapshots`.

## Sources

| View | Grain | Use |
| --- | --- | --- |
| `mart_gto_ua_agent_performance_summary` | agent x created date | Use the display name `Agent Performance Daily`; it provides custom periods, CNX monitoring, New Active and Reactivated activity flags. |
| `mart_gto_ua_agent_performance_current` | one row per agent | Top-20, current/previous week, MTD, YoY MTD, eight-week benchmark, segment and quality/momentum fields. |
| `mart_gto_ua_agent_performance_product_destination` | agent x created date x product x order-level destination | Product and destination profile without line-level duplication. |
| `mart_gto_ua_agent_performance_gmv_drivers` | completed week | GMV WoW bridge: active-agent base, order frequency, average check, new/re-activated/stopped agents. |

## Common Calendar Anchor

All four views are anchored to the last fully completed Friday in `Europe/Kyiv`. A reporting week is Saturday through Friday. Rows after that Friday are intentionally excluded, so no chart mixes an in-progress day with completed weekly and monthly comparisons.

## Status and Lifecycle Rules

- `CNF` is the only status contributing GMV, profit, tourists and completed-order counts.
- `CNX` is separately counted in the daily summary. Other statuses remain visible as `open_or_other_orders` but do not contribute financial metrics.
- `is_new_active` marks the first recorded CNF activity date for the agent in the reporting history.
- `is_reactivated` marks a CNF date following more than 90 days without a prior CNF.
- `stopped_agents` in the weekly drivers view counts agents whose last CNF passed the 90-day inactivity boundary in that week.

## GMV Bridge

For each week, the GMV change versus the previous week is decomposed exactly as:

```text
active-agent base effect
+ order-frequency effect
+ average-check effect
= GMV week-over-week delta
```

The first available week has no prior comparator, so its comparison and driver fields are `NULL`.

## Looker Access

The migration grants `SELECT` on all four views to `looker_studio_reader`. Existing reporting tables and current Data Studio sources remain unchanged.
