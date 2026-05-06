# GTO Looker Studio Guide for ChatGPT

> Updated: 2026-05-06
> Purpose: upload this file into ChatGPT when continuing Google Looker Studio setup, so ChatGPT has the right project context without re-reading code.

## What Is Already Done

- PostgreSQL export is already built and running.
- Refresh is already scheduled every `2` hours in `Europe/Kyiv` timezone.
- Currency conversion to EUR is already handled in the backend using GTO v3 historical FX rates on the booking creation date.
- Data sources are already connected in Looker Studio.

## PostgreSQL Source

- Host: `46.225.220.88`
- Port: `5432`
- Database: `analytics_db`
- Username: `looker_studio_reader`
- SSL: disabled

## Available Reporting Tables

### 1. `public.reporting_gto_orders`

Use this for order-level reporting.

Granularity:

- `1 row = 1 order`

Best use cases:

- total orders
- GMV by order
- order status analysis
- agents and networks
- booking lead time
- package vs single-product orders
- comment workload

Typical fields:

- `order_id`
- `created_at`
- `updated_at`
- `confirmed_at`
- `date_start`
- `date_end`
- `order_status`
- `order_status_name`
- `agent_name`
- `agent_network`
- `company_name`
- `order_currency`
- `total_amount_original`
- `total_amount_eur`
- `balance_amount_original`
- `balance_amount_eur`
- `primary_country_name`
- `country_names`
- `supplier_names`
- `destination_names`
- `has_hotel`
- `has_airticket`
- `has_transfer`
- `has_insurance`
- `has_other`
- `is_package`
- `tourists_count`
- `comment_count`
- `urgent_comment_count`
- `sales_lead_days`

### 2. `public.reporting_gto_order_lines`

Use this for product-level and supplier-level reporting.

Granularity:

- `1 row = 1 product/service line inside an order`

Best use cases:

- supplier analysis
- product mix
- GMV by supplier
- destination by line
- hotel / airticket / transfer / insurance cuts

Typical fields:

- `order_id`
- `line_id`
- `created_at`
- `date_start`
- `order_status`
- `product_group`
- `supplier_id`
- `supplier_name`
- `status`
- `currency`
- `price_original`
- `price_eur`
- `price_buy_original`
- `price_buy_eur`
- `destination_raw`

### 3. `public.reporting_gto_sync_runs`

Use this for operational monitoring only.

Granularity:

- `1 row = 1 sync run`

Best use cases:

- verify last refresh
- check sync status
- display last successful run

## Very Important Modeling Rule

Do not treat `reporting_gto_orders` and `reporting_gto_order_lines` as if they had the same granularity.

- `reporting_gto_orders` is for order metrics
- `reporting_gto_order_lines` is for line metrics

If you build charts from line data and count orders there, order counts can be duplicated.
If you build supplier or product charts from order data, supplier/product GMV will be incomplete or misleading.

Recommended approach:

- create one Looker Studio data source for `reporting_gto_orders`
- create a second Looker Studio data source for `reporting_gto_order_lines`
- use them on separate pages or separate charts
- avoid blending unless absolutely necessary

## Recommended Data Source Names in Looker Studio

- `GTO Orders`
- `GTO Order Lines`
- optional: `GTO Sync Runs`

## Recommended Dashboard Structure

### Page 1. Executive Overview

Source:

- `GTO Orders`

Recommended scorecards:

- Orders
- GMV EUR
- Average GMV per order
- Tourists
- Cancelled orders

Recommended charts:

- Orders by `created_at` month
- GMV by `created_at` month
- Orders by `order_status`
- Orders by `primary_country_name`
- Orders by `agent_network`

### Page 2. Booking Depth

Source:

- `GTO Orders`

Recommended charts:

- distribution of `sales_lead_days`
- lead time by country
- lead time by network
- lead time by package flag

Recommended calculated field:

- `Lead Time Bucket`

Example logic:

- `0-7`
- `8-14`
- `15-30`
- `31-60`
- `61-90`
- `91-180`
- `181+`

### Page 3. Agent and Network Performance

Source:

- `GTO Orders`

Recommended charts:

- GMV by `agent_name`
- Orders by `agent_name`
- GMV by `agent_network`
- Tourists by `agent_network`
- Cancelled share by network

### Page 4. Product Mix

Primary source:

- `GTO Orders`

Optional detailed source:

- `GTO Order Lines`

Recommended charts:

- orders with hotel
- orders with airticket
- orders with transfer
- orders with insurance
- package vs non-package
- line GMV by `product_group`

### Page 5. Supplier Analysis

Source:

- `GTO Order Lines`

Recommended charts:

- GMV by `supplier_name`
- line count by `supplier_name`
- GMV by `supplier_name` and `product_group`
- GMV by `supplier_name` and `destination_raw`

Recommended filters:

- `product_group`
- `supplier_name`
- `date_start`
- `created_at`
- `order_status`

### Page 6. Destination Analysis

Source:

- `GTO Orders` for high-level order view
- `GTO Order Lines` for line-level supplier and product drilldown

Recommended charts:

- Orders by `primary_country_name`
- GMV by `destination_names`
- Supplier GMV by `destination_raw`

## Recommended Calculated Fields

Use these in Looker Studio if needed.

### Orders source

- `Created Date`
- `Created Month`
- `Travel Month`
- `Is Cancelled`
- `Is Confirmed`
- `Avg GMV per Tourist`
- `Package Label`
- `Lead Time Bucket`

Suggested formulas:

- `Is Cancelled`:
  - `CASE WHEN order_status = "CNX" THEN "Cancelled" ELSE "Not Cancelled" END`
- `Is Confirmed`:
  - `CASE WHEN order_status = "CNF" THEN "Confirmed" ELSE "Other" END`
- `Package Label`:
  - `CASE WHEN is_package = true THEN "Package" ELSE "Single product" END`

### Order lines source

- `Line GMV EUR`
- `Line Cost EUR`
- `Supplier Label`
- `Destination Label`

Suggested formula:

- `Supplier Label`:
  - `CASE WHEN supplier_name IS NULL OR supplier_name = "" THEN "Unknown supplier" ELSE supplier_name END`

## Filters to Put on Most Pages

Recommended global controls:

- booking creation date (`created_at`)
- travel start date (`date_start`)
- order status
- agent network
- supplier name
- product group
- country

## Important Business Rules

- EUR is already precomputed in the exported tables.
- EUR must be treated as authoritative for reporting.
- FX is based on booking creation date, not current date.
- Main scheduled refresh covers only the rolling last 4 days by `created_at`.
- This is intentional.
- A one-time backfill was already done for orders with `date_start` in `2025` but `created_at` in `2024`.
- That one-time supplement added:
  - `521` orders
  - `1,196` order lines
- Do not assume the system refreshes all old historical orders every day.

## Common Mistakes to Avoid

- Do not sum order metrics from `reporting_gto_order_lines` unless you intentionally want line-level duplication.
- Do not build supplier ranking from `reporting_gto_orders`.
- Do not mix order-level and line-level metrics in one chart without careful modeling.
- Do not recalculate EUR inside Looker Studio from original currencies.
- Do not assume `destination_names` and `destination_raw` are the same thing.

## Good Prompt to Give ChatGPT Next Time

When uploading this file into ChatGPT, use a prompt like:

`I have already connected the PostgreSQL sources in Looker Studio. Based on the attached guide, help me design the report structure, calculated fields, filters, charts, and page layout. Keep order-level and line-level sources separate unless blending is truly necessary.`

## If You Need ChatGPT Help for a Specific Dashboard

Give ChatGPT these inputs:

- which business question you want to answer
- which page you are building
- which source you are using: `GTO Orders` or `GTO Order Lines`
- what dimensions and metrics you already placed
- what result looks wrong

That will let ChatGPT give much better Looker Studio guidance without needing access to project code.
