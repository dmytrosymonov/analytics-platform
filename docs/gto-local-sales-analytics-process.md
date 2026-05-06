# GTO Local Sales Analytics Process

> Updated: 2026-05-06
> Scope: local analytics in the current workspace for GTO sales data, destination/supplier analytics, sales depth, and cancelled-order comments.

## Purpose

This document is the working memory for ad-hoc GTO analytics in this workspace.
When the user asks follow-up questions in this chat about sales, suppliers, destinations, booking depth, or product mix, use the local datasets and artifacts listed here first.
Do not re-investigate code or refetch remote data unless the requested period or metric is not covered by these local files.

Use this document as the entry point before reading scripts. Most follow-up questions can be answered from the JSON, XLSX, DOCX, PDF, and CSV artifacts listed below.

## Local Data Cache

Primary sales cache:

- `tmp/gto-sales-2025-01-01_to_2026-05-04/orders-list.jsonl`
- `tmp/gto-sales-2025-01-01_to_2026-05-04/order-details.jsonl`
- `tmp/gto-sales-2025-01-01_to_2026-05-04/currency-rates.json`
- `tmp/gto-sales-2025-01-01_to_2026-05-04/manifest.json`

Coverage:

- Order creation period requested by the user: all of 2025 through 2026-05-04.
- `orders-list.jsonl`: 20,055 rows.
- `order-details.jsonl`: 20,055 rows, with 20,054 successful details and one detail error.
- Compared with the earlier `2026-04-29` cache, this incremental refresh added 223 new orders.
- Previous cache is still available as an archived snapshot in `tmp/gto-sales-2025-01-01_to_2026-04-10/`.
- Previous main snapshot is also available in `tmp/gto-sales-2025-01-01_to_2026-04-29/`.
- This refresh used the same inclusive `created_at` logic and the same output format as the earlier cache.
- Important distinction: the local JSONL cache remains creation-date based. A later one-time supplement for orders created in `2024` but starting travel in `2025` was applied only to the PostgreSQL reporting export, not to these local JSONL files.

Static GTO v3 dictionaries:

- `tmp/gto-destinations.json`: GTO v3 `/destinations`, 837 records.
- `tmp/gto-cities.json`: GTO v3 `/cities`, 13,544 records.

For Spain, `country_id = 21` in the GTO v3 dictionaries.

Country IDs repeatedly used in local analytics:

- Spain: `21`
- Turkey: `47`
- Greece: `11`
- Italy: `22`
- Egypt: `14`
- Montenegro: `86`
- Croatia: `66`
- Cyprus: `23`
- Northern Cyprus appears separately in raw GTO as `360`; it is not merged into Cyprus unless explicitly requested.

## Core Rules

Use local data unless the user explicitly asks to refresh or the requested period falls outside the local cache.

Use order creation date (`order.created_at`) for sales-period questions unless the user says to use travel start date.

Exclude cancelled orders and rows by default:

- `order.status = CNF`
- product/service row status must also be `CNF` where row-level status exists.

Exclude test agent:

- `GTO for Test-Goodwin`

All monetary values for analysis must be converted to EUR.
Use `tmp/gto-sales-2025-01-01_to_2026-05-04/currency-rates.json` for conversion when reading raw order detail rows.

For supplier and sales ranking requested without profit/margin:

- Do not use profit.
- Do not use margin.
- Use sales counts and GMV only.

For cancelled-order comments:

- Use `order.status = CNX`.
- Exclude test agent `GTO for Test-Goodwin`.
- Comments live in `order.comment` as `{type, comment, created_at}`.
- Comment analysis can be read two ways:
  - by order creation period: all comments inside orders created in the selected period;
  - by comment creation period: only comments whose own `created_at` is inside the selected period.
- The current local cache was fetched on 2026-05-06, so comments inside orders created through 2026-05-04 can include later comments up to the fetch moment.
- For management analysis, split automatic/noise comments from useful operational comments.

## Cache Refresh Workflow

Primary helper:

- `tmp/cache-gto-sales-data.ts`

Refresh behavior:

- Default mode is incremental when a prior snapshot with the same `date_from` already exists.
- Incremental mode finds the latest local snapshot whose `date_to` is not later than the requested target period.
- It fetches only the new tail plus a small overlap window and merges refreshed rows into the previous snapshot.
- Default overlap is `7` days and can be changed via `GTO_CACHE_OVERLAP_DAYS`.
- Full refresh is still available by setting `GTO_CACHE_INCREMENTAL=0`.
- Saves `orders-list.jsonl`, `order-details.jsonl`, `detail-errors.json`, `currency-rates.json`, and `manifest.json`.

Credential resolution:

- First tries local Prisma `DataSource(type='gto')` credentials.
- If local credentials are absent, can use environment fallback:
  - `GTO_API_KEY`
  - `GTO_BASE_URL`
  - `GTO_V3_BASE_URL`
  - `GTO_TIMEOUT_SECONDS`

This fallback was added because the local workspace DB may not contain the production GTO credential payload even when the project code and analytics artifacts are present.

Practical usage:

```bash
GTO_CACHE_DATE_FROM=2025-01-01 \
GTO_CACHE_DATE_TO=2026-04-29 \
GTO_CACHE_OVERLAP_DAYS=7 \
npx tsx tmp/cache-gto-sales-data.ts
```

Notes:

- `manifest.json` now records whether the refresh was `full` or `incremental`.
- In incremental mode, detail refresh errors do not overwrite an already successful older detail row for the same `order_id`.

## Looker Studio / PostgreSQL Export

Use this section when the question is about the Google Looker Studio source or the reporting database rather than the local JSONL cache.

Reporting tables:

- `public.reporting_gto_orders`
- `public.reporting_gto_order_lines`
- `public.reporting_gto_sync_runs`

Operational rules:

- Scheduled refresh runs every `2` hours in `Europe/Kyiv` timezone.
- Each refresh rewrites only the order ids found in the rolling last-4-days created-at window.
- EUR conversion uses GTO v3 historical rates for the booking creation date.
- This export is intentionally not a full rolling refresh of all historical finished orders.

One-time supplemental backfill already completed:

- Date executed: `2026-05-06`
- Purpose: add orders with `date_start` in `2025` that were created in `2024`, because they are relevant for 2025 travel analysis but were outside the main creation-date export window
- Inserted into PostgreSQL:
  - `521` orders
  - `1,196` order lines
- Status mix:
  - `CNF`: `380`
  - `CNX`: `140`
  - `XNP`: `1`

Recorded decision with the user:

- Do not widen the daily refresh to revisit old already-finished orders.
- Keep the regular daily sync focused on recent created-at changes only.
- Treat the `2024 created / 2025 start` layer as a one-time reporting supplement unless a future request says otherwise.

## Product Interpretation

For hotel supplier analytics:

- Include orders that have a confirmed hotel row, even if the same order also contains other products such as flight, transfer, or insurance.
- Count hotel GMV from the hotel row only: `hotel.price` converted to EUR.
- Do not count full package GMV for a hotel supplier ranking unless the user explicitly asks for package/order-level GMV.

For product-specific analyses:

- Hotels: use `order.hotel` rows.
- Aviation: use the relevant flight/avia rows in order details.
- Transfers: use transfer rows.
- Insurance should be excluded when the user asks for products except insurance.

## Existing Analysis Artifacts

### Product/Supplier/Destination Management Memo

Use these when the user asks about broad product performance, supplier roles, top destinations, product split, or trend memo from the 2025-01-01 to 2026-04-10 local cache.

Core memo:

- DOCX: `output/doc/gto_product_supplier_destination_memo_2025_2026.docx`
- JSON: `reports/gto-product-supplier-destination-memo-2025-01-01_to_2026-04-10.json`
- Markdown: `reports/gto-product-supplier-destination-memo-2025-01-01_to_2026-04-10.md`
- Builder: `tmp/build_gto_product_supplier_docx.py`

GMV/date-trends memo:

- DOCX: `output/doc/gto_product_supplier_destination_gmv_trends_memo_2025_2026.docx`
- Mobile-oriented PDF: `output/pdf/gto_product_supplier_destination_gmv_trends_mobile.pdf`
- JSON: `reports/gto-product-supplier-destination-gmv-trends-memo-2025-01-01_to_2026-04-10.json`
- Markdown: `reports/gto-product-supplier-destination-gmv-trends-memo-2025-01-01_to_2026-04-10.md`
- Builders:
  - `tmp/build_gto_gmv_trends_docx.py`
  - `tmp/build_gto_mobile_pdf.py`

Supporting destination/supplier line data:

- JSON: `reports/gto-supplier-destinations-2025-01-01_to_2026-04-10.json`
- Markdown: `reports/gto-supplier-destinations-2025-01-01_to_2026-04-10.md`
- CSV detail lines: `reports/gto-supplier-destinations-lines-2025-01-01_to_2026-04-10.csv`

Important methodology:

- The user asked to remove profit and margin from management reporting. Unless explicitly requested otherwise, use only sales counts and GMV.
- Section 6 supplier shares should be calculated as supplier share of the full destination, not only among top 5 suppliers.
- Product analyses should be split by hotels, aviation, and transfers when requested.
- Exclude insurance unless the user asks to include it.

### Sales Depth By Top 20 Destinations

Use this when the user asks about booking depth / lead time: how far in advance each destination is booked by month.

- DOCX: `output/doc/gto_sales_depth_top20_destinations_2025_2026.docx`
- JSON: `reports/gto-sales-depth-top20-destinations-2025-01-01_to_2026-04-10.json`
- Markdown: `reports/gto-sales-depth-top20-destinations-2025-01-01_to_2026-04-10.md`
- Builder: `tmp/build_gto_sales_depth_docx.py`

Lead-time definitions used in the report:

- `Lead time`: days between `order.created_at` and travel `date_start`.
- `Median`: middle value.
- `P25`: 25th percentile.
- `P75`: 75th percentile.
- Buckets such as `0-7`, `8-14`, `15-30`, `31-60`, `61-90`, `91-180`, `181+` represent count/share of orders in that lead-time range.

If the user asks how to read the lead-time distribution table, explain that each destination row shows how many orders and what percent of that destination's orders were booked within each advance-purchase bucket.

### Sales Depth By Product Group

Use this when the user asks about booking depth by products or product baskets rather than by destination.

- DOCX: `output/doc/gto_sales_depth_products_2025_2026.docx`
- JSON: `reports/gto-sales-depth-products-2025-01-01_to_2026-04-10.json`
- Markdown: `reports/gto-sales-depth-products-2025-01-01_to_2026-04-10.md`
- Builder: `tmp/build_gto_sales_depth_products_docx.py`

Basis:

- Period: `created_at` from 2025-01-01 through 2026-04-10.
- Only `CNF` orders.
- Lead time = `date_start - created_at`.
- Product groups:
  - `Packages`: orders with 2 or more active non-CNX service lines in one order.
  - `Hotels`: orders with active hotel lines.
  - `Tickets`: orders with active airticket lines.
  - `Transfers`: orders with active transfer lines.
  - `Insurance`: orders with active insurance lines.

Important methodology:

- These groups are not mutually exclusive.
- One order can appear in several product groups.
- `Packages` is an order-level basket category.
- `Hotels / Tickets / Transfers / Insurance` are product presence categories.
- GMV for Hotels/Tickets/Transfers/Insurance is the GMV of the respective active lines.
- GMV for Packages is the sum of all active lines in orders with 2+ services.

Latest results:

- Unique CNF orders covered: 14,098.
- Total product-group observations: 29,928.

Product depth summary:

- Packages: 5,595 observations, median 31 days, `<=14d` 27.5%, `>90d` 16.0%, GMV 9.94M EUR.
- Hotels: 6,850 observations, median 29 days, `<=14d` 29.3%, `>90d` 16.9%, GMV 9.21M EUR.
- Tickets: 6,700 observations, median 30 days, `<=14d` 27.7%, `>90d` 15.0%, GMV 5.79M EUR.
- Transfers: 4,169 observations, median 30 days, `<=14d` 29.1%, `>90d` 17.0%, GMV 0.41M EUR.
- Insurance: 6,614 observations, median 18 days, `<=14d` 43.6%, `>90d` 11.9%, GMV 0.14M EUR.

Management interpretation:

- Insurance is the most last-minute group and should not be used as an early demand signal.
- Packages have a slightly longer and more stable depth than single-product insurance and are useful as a broader planning signal.
- Hotels, Tickets, and Transfers sit in a similar median band around 29-30 days, but their last-minute and early-booking shares still differ enough to track separately.

## Destination Matching

Destination matching should be based on system destinations, not free-form country names and not only raw text from the hotel.

Primary dictionary:

- GTO v3 `/destinations` from `tmp/gto-destinations.json`.

Auxiliary dictionary:

- GTO v3 `/cities` from `tmp/gto-cities.json`.

Spain destination logic used for the current XLSX:

1. Filter GTO `/destinations` to Spain by `country_id = 21` or `countries_list` containing `21|`.
2. Canonicalize system destination variants:
   - remove suffixes like `_PL`, `_KZ`, `_KG`, `_edu`, `_cache`;
   - map `Costa Dorada` to `Costa Daurada`;
   - map `Costa Del Sol` / `Costa del Sol` to `Costa Del Sol (Malaga)`;
   - map `Costa Blanca` to `Costa Blanca (Alicante)`;
   - map `UA_precache_PMI` to `Mallorca`.
3. Match hotel rows against the system destination aliases using:
   - raw destination from hotel full name brackets, for example `[Costa Daurada]`;
   - `hotel.full_name`;
   - `hotel.hotel_address`;
   - `hotel.hotel_name`.
4. Preserve the raw hotel destination in output detail rows for auditability.
5. Use `/cities` only as a conservative helper for city-to-destination aliases. System destination remains the grouping key.

Manual conservative city aliases currently used for Spain:

- `Coma-Ruga`, `Tarragona`, `Salou`, `La Pineda`, `Cambrils`, `Reus` -> `Costa Daurada`
- `Lloret de Mar`, `Girona`, `Gerona`, `Roses` -> `Costa Brava`
- `Alicante` -> `Costa Blanca (Alicante)`
- `Malaga` -> `Costa Del Sol (Malaga)`

Rows that cannot be safely matched to a system destination must stay in an `Unmatched` output rather than being forced into a destination.

Known unmatched examples after the Spain supplier rebuild:

- `Almeria`
- `Pontevedra`
- `A Сoruna`
- `Budapest`
- `Bucharest`
- `Warsaw`

These are not force-mapped in the current methodology because either the system destination is absent from `/destinations`, or the raw destination conflicts with the Spain country filter.

## Hotel Supplier Ranking Workbooks

### Spain, December 2025 To April 2026

- `output/spreadsheet/gto_spain_hotel_supplier_ranking_2025-12-01_to_2026-04-10.xlsx`

Companion JSON:

- `reports/gto-spain-hotel-supplier-ranking-2025-12-01_to_2026-04-10.json`

Builder script:

- `tmp/build_spain_hotel_supplier_xlsx.py`

Analysis period:

- 2025-12-01 through 2026-04-10, inclusive by `order.created_at`.

Basis:

- Confirmed hotel rows only.
- Spain country filter from `order.country`.
- Destination grouped through GTO v3 `/destinations` with conservative `/cities` assisted aliases.
- GMV converted to EUR.
- Profit and margin excluded.

Latest workbook counts:

- Matched hotel rows: 522.
- Unmatched hotel rows: 11.
- System destinations: 12.
- Suppliers: 11.
- Total hotel GMV: 721,343.65 EUR.

Top system destinations by hotel GMV:

1. `Costa Daurada`: 197,168.22 EUR.
2. `Tenerife`: 178,063.88 EUR.
3. `Mallorca`: 151,418.14 EUR.
4. `Costa Brava`: 89,985.44 EUR.
5. `Barcelona`: 50,595.37 EUR.

Top hotel suppliers by Spain hotel GMV:

1. `W2M`: 375,640.83 EUR.
2. `Hotelbeds`: 104,558.37 EUR.
3. `Hotelston`: 71,221.23 EUR.
4. `Expedia`: 48,545.72 EUR.
5. `Go Global Travel`: 26,878.46 EUR.

Workbook sheets:

- `README`: scope, filters, metrics, and counts.
- `Destination Ranking`: system destination ranking by hotel GMV.
- `Supplier Ranking`: supplier ranking by hotel GMV.
- `By Destination Supplier`: supplier ranking inside each system destination, including share of destination GMV.
- `Detail Rows`: matched hotel rows with raw and system destination fields.
- `System Destinations`: system destination IDs, city IDs, variants, and match aliases.
- `Unmatched`: rows not safely mapped to a system destination.

### Greece, Turkey, Italy, December 2025 To April 2026

This was created as a direct analogue to the Spain supplier ranking.

- XLSX: `output/spreadsheet/gto_hotel_supplier_ranking_greece_turkey_italy_2025-12-01_to_2026-04-10.xlsx`
- JSON: `reports/gto-hotel-supplier-ranking-greece-turkey-italy-2025-12-01_to_2026-04-10.json`
- Builder: `tmp/build_multi_country_hotel_supplier_xlsx.py`

Period:

- 2025-12-01 through 2026-04-10, inclusive by `order.created_at`.

Latest counts:

- Matched hotel rows: 322.
- Unmatched hotel rows: 13.
- Countries: Greece, Turkey, Italy.
- Total hotel GMV: 359,849.26 EUR.

Top country totals:

- Italy: 136,517.64 EUR.
- Greece: 115,416.75 EUR.
- Turkey: 107,914.87 EUR.

Top supplier highlights:

- Greece: Hotelbeds, W2M, Hotelston.
- Turkey: Hotelston, W2M, Best Travel Service.
- Italy: Hotelbeds, Hotelston, W2M.

### Eight-Country Hotel Supplier Workbook

Use this as the current broad hotel supplier ranking workbook across the main leisure countries requested by the user.

- XLSX: `output/spreadsheet/gto_hotel_supplier_ranking_8_countries_2025-10-01_to_2026-04-10.xlsx`
- JSON: `reports/gto-hotel-supplier-ranking-8-countries-2025-10-01_to_2026-04-10.json`
- Builder: `tmp/build_multi_country_hotel_supplier_xlsx.py`

Period:

- 2025-10-01 through 2026-04-10, inclusive by `order.created_at`.

Countries:

- Spain, Turkey, Greece, Italy, Egypt, Montenegro, Croatia, Cyprus.

Basis:

- Confirmed hotel rows only.
- `order.status = CNF`, `hotel.status = CNF`.
- Country filter from `order.country`.
- Destination matched to GTO v3 `/destinations` where the local dictionary is reliable.
- GTO v3 `/cities` is used only for conservative aliases.
- Montenegro, Croatia, and Cyprus use raw hotel destination fallback because the local `/destinations` file contains clearly irrelevant destinations for those country IDs.
- GMV is `hotel.price` converted to EUR.
- Profit and margin excluded.

Latest counts:

- Matched hotel rows: 1,501.
- Unmatched hotel rows: 41.
- Total hotel GMV: about 1.76M EUR.

Country totals:

- Spain: 880,919.03 EUR.
- Egypt: 281,231.63 EUR.
- Turkey: 182,172.54 EUR.
- Italy: 160,834.49 EUR.
- Greece: 147,353.77 EUR.
- Cyprus: 53,957.40 EUR.
- Croatia: 50,899.49 EUR.
- Montenegro: 2,554.54 EUR.

Top destinations in the eight-country workbook:

- Spain / Tenerife: 257,967.28 EUR.
- Spain / Costa Daurada: 217,615.25 EUR.
- Egypt / Sharm El-Sheikh: 196,301.36 EUR.
- Spain / Mallorca: 169,966.51 EUR.
- Spain / Costa Brava: 93,612.31 EUR.
- Egypt / Hurghada: 67,449.86 EUR.
- Spain / Barcelona: 64,655.71 EUR.
- Cyprus / Cyprus: 53,957.40 EUR.
- Turkey / Kemer: 51,837.77 EUR.
- Italy / Sardinia: 46,297.87 EUR.

Top suppliers across all eight countries:

- W2M: 603,621.06 EUR.
- Hotelbeds: 302,555.54 EUR.
- Hotelston: 240,974.72 EUR.
- Joyce Tour: 122,915.45 EUR.
- Expedia: 107,431.49 EUR.
- Go Global Travel: 78,927.93 EUR.
- Restel: 51,943.75 EUR.
- Webbeds: 51,087.83 EUR.
- EscalaBeds: 40,052.91 EUR.
- GEPARD TRAVEL: 34,511.86 EUR.

Workbook sheets:

- `README`: scope, filters, and methodology.
- `Country Summary`: country-level orders, hotel rows, destinations, suppliers, GMV, share.
- `Destination Ranking`: destination-level GMV and top supplier by destination.
- `Supplier Ranking`: supplier ranking in `ALL` scope and per country.
- `By Destination Supplier`: supplier ranking inside each destination, with full destination share.
- `Detail Rows`: matched hotel rows with raw and system destination fields.
- `System Destinations`: system IDs, city IDs, variants, aliases.
- `Unmatched`: rows not safely mapped.
- `Chart Data`: chart helper data.

Important caveats:

- Montenegro/Croatia/Cyprus destination grouping is raw fallback in this workbook, not system `/destinations`.
- Unmatched rows should stay visible and should not be forced into a destination unless the user approves a manual mapping.
- Some raw hotel destinations conflict with the order country, for example `Paris`, `Munich`, `Warsaw`, `Budapest`, or `Bucharest`; leave those in `Unmatched` or audit them explicitly.

## Cancelled Order Comment Analysis

Use this when the user asks about cancellation reasons, comment themes, supplier-related cancellation exposure, operational bottlenecks, or management recommendations from comments.

Artifacts:

- DOCX: `output/doc/gto-cnx-comments-management-report-2025-01-01_to_2026-04-10.docx`
- Markdown: `reports/gto-cnx-comments-analysis-2025-01-01_to_2026-04-10.md`
- JSON: `reports/gto-cnx-comments-analysis-2025-01-01_to_2026-04-10.json`
- Analysis builder: `tmp/analyze_cnx_comments.py`
- DOCX builder: `tmp/build_cnx_comments_docx.py`

Basis:

- CNX orders from the local GTO details cache.
- Test agent excluded.
- Comments read from `order.comment`.
- Personal tourist data is not included in management artifacts.
- Automatic/noise comments are split from useful operational comments.
- Classification is pattern-based and should be treated as management segmentation, not a legally exact cancellation reason.

Latest counts:

- CNX orders without test agent: 4,579.
- Orders with comments: 3,982.
- Total comments: 21,504.
- Useful operational comments: 19,199.
- Auto/noise comments: 2,305.
- Urgent comments: 6,288 (29.2%).
- Median comments per CNX order: 3.
- P90 comments per CNX order: 10.
- High-touch CNX orders with more than 10 useful comments: 390.

Main comment themes by order:

- Price/tariff/currency/net-gross.
- Availability/confirmation/supplier waiting.
- Explicit cancellation or rebooking request.
- Hotel/room/property issue.
- Payment/invoice/debt.
- Flight/schedule issue.
- Documents/vouchers/ticketing.
- Passport/visa/compliance.
- Transfer/logistics.

Supplier cancellation section:

- Supplier analysis is multi-touch exposure: one CNX order can contain several suppliers.
- Supplier exposure is not supplier fault.
- The DOCX includes top suppliers in CNX orders and per-supplier primary reasons/themes for the top 10 suppliers.
- If the user asks who is responsible for cancellations, explain that a separate `fault owner` field is needed; current comments do not reliably assign fault.

Management recommendations captured in the DOCX:

- Add mandatory cancellation reason fields.
- Track high-touch cancellations weekly.
- Add SLA/escalation for supplier or agent waiting.
- Make tariff fixation and time limits explicit.
- Separate automatic payment comments from operational comments.
- Pre-check passport/visa/compliance for risky products.
- Standardize transfer checklist.
- Add supplier cancellation dashboard with exposure, top reasons, price/availability themes, urgent comments per order, high-touch CNX.

## Other Existing GTO Analytical Artifacts

These artifacts exist in the workspace and may be useful for follow-up questions, although they were not the latest focus:

- `reports/gto-cnx-tariff-availability-suppliers-2026-01-01_to_2026-04-13.md`
- `reports/gto-cnx-tariff-availability-suppliers-2026-01-01_to_2026-04-13.xlsx`
- `reports/gto-cnx-tariff-suppliers-2026-01-01_to_2026-04-13.md`
- `reports/gto-cnx-tariff-suppliers-2026-01-01_to_2026-04-13.xlsx`
- `reports/gto-comment-response-speed-2026-01-13_to_2026-04-13.json`
- `reports/gto-comment-response-speed-2026-01-13_to_2026-04-13.md`
- `reports/gto-comment-response-speed-clustered-2026-01-13_to_2026-04-13.json`
- `reports/gto-comment-response-speed-clustered-2026-01-13_to_2026-04-13.md`
- `reports/gto-comment-response-speed-clustered-2026-01-13_to_2026-04-13.xlsx`
- `reports/gto-product-profitability-2026-01-01_to_2026-04-13.md`
- `reports/gto-product-profitability-2026-01-01_to_2026-04-13.xlsx`
- `reports/gto-product-profitability-yoy-2026_vs_2025.json`
- `reports/gto-product-profitability-yoy-2026_vs_2025.md`
- `reports/gto-product-profitability-yoy-2026_vs_2025.xlsx`
- `reports/gto-status-rates-yoy-2026_vs_2025.json`

If using older profitability artifacts, remember that later management requests excluded profit and margin from the main supplier/destination reports.

## How To Answer Future Questions In This Chat

For questions about the current Spain hotel supplier analysis:

1. Prefer reading `reports/gto-spain-hotel-supplier-ranking-2025-12-01_to_2026-04-10.json` for rankings and totals.
2. Use the XLSX when the user asks about workbook contents, supplier shares by destination, detail rows, or unmatched rows.
3. Use `tmp/build_spain_hotel_supplier_xlsx.py` only if the workbook must be regenerated or the methodology must be changed.

For questions about current multi-country hotel supplier rankings:

1. Prefer `reports/gto-hotel-supplier-ranking-8-countries-2025-10-01_to_2026-04-10.json`.
2. Use `output/spreadsheet/gto_hotel_supplier_ranking_8_countries_2025-10-01_to_2026-04-10.xlsx` for workbook-level detail and filtering.
3. Use `tmp/build_multi_country_hotel_supplier_xlsx.py` only for regeneration or methodology changes.

For questions about cancellation comments:

1. Prefer `reports/gto-cnx-comments-analysis-2025-01-01_to_2026-04-10.json`.
2. Use `output/doc/gto-cnx-comments-management-report-2025-01-01_to_2026-04-10.docx` for management-ready narrative.
3. Use `tmp/analyze_cnx_comments.py` only for reclassification/regeneration.
4. Be explicit that supplier cancellation analysis is exposure, not fault attribution.

For questions about sales depth:

1. Prefer `reports/gto-sales-depth-top20-destinations-2025-01-01_to_2026-04-10.json`.
2. Use `output/doc/gto_sales_depth_top20_destinations_2025_2026.docx` for management explanation.

For questions about sales depth by products:

1. Prefer `reports/gto-sales-depth-products-2025-01-01_to_2026-04-10.json`.
2. Use `output/doc/gto_sales_depth_products_2025_2026.docx` for management explanation.
3. Be explicit that Packages vs Hotels/Tickets/Transfers/Insurance is not an exclusive partition; one order can belong to several product groups.

For broader GTO analytics over 2025 through 2026-04-10:

1. Use `order-details.jsonl` as the primary source.
2. Apply the core rules above.
3. Convert money to EUR before aggregation.
4. Keep product row GMV separate from full-order GMV unless the user asks for package/order-level totals.
5. For destinations, prefer system `/destinations` matching and preserve raw destination values in any audit output.

If the user asks for a new period outside the current cache, ask whether to fetch fresh data from GTO before proceeding.
