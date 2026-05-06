# Analytics Platform — Project Documentation

> **Updated:** 2026-04-08
> **Owner:** Dmytro Symonov
> **Production:** https://dsym.goodwin-soft.com/analytics-platform

---

## What This Is

An internal analytics back-office for a travel/tourism company. It collects data from multiple sources (GTO, GA4, Redmine, YouTrack), runs AI analysis via ChatGPT, and delivers reports via Telegram.

---

## Architecture

```
apps/
  api/      — Fastify + Prisma backend (port 4000)
  admin/    — Next.js admin panel (port 4001, served at /analytics-platform)
```

**Stack:** TypeScript, Fastify, Prisma, PostgreSQL, Redis, BullMQ, Next.js
**Process manager:** PM2 (`analytics-api` + `analytics-admin`)
**Server:** `46.225.220.88` → ssh root@46.225.220.88
**Deploy:** git push to `main` → GitHub Actions → SSH → `/opt/analytics-platform/deploy.sh`
**Deploy script source of truth:** tracked in repo as `deploy.sh` and expected to exist on the server at `/opt/analytics-platform/deploy.sh`

**Claude docs on server:** after each deploy GitHub Actions runs `bash scripts/refresh-claude-docs.sh`, which rebuilds `/opt/analytics-platform/CLAUDE.md` from this file and appends the latest deployed commit metadata for Claude handoff.

**GitHub access (verified 2026-04-01):**
- Local `gh` auth is valid for account `dmytrosymonov`
- Repo remote uses HTTPS: `https://github.com/dmytrosymonov/analytics-platform.git`
- `git push --dry-run origin HEAD:refs/heads/codex/github-access-check` succeeds
- SSH auth to GitHub is NOT configured yet for `~/.ssh/id_ed25519` (`Permission denied (publickey)`)
- Practical release path for agents: commit locally → push via HTTPS remote → GitHub Actions deploys to server

**Server deploy incident (2026-04-01):**
- GitHub Actions deploy failed because server checkout had a dirty worktree and an untracked `deploy.sh`
- Dirty server changes were preserved in `git stash` as `pre-deploy-safety-2026-04-01`
- `deploy.sh` was restored from that stash and is now tracked in the repo to prevent future missing-script failures
- `deploy.sh` now auto-stashes dirty server-local changes before `git pull`, so generated `CLAUDE.md` and other runtime edits do not block future deploys
- `deploy.sh` now retries `npm install` once after removing the target `node_modules` directory if npm fails with a broken install state (for example ENOENT inside `@esbuild/*`)
- `deploy.sh` now validates critical build artifacts before touching PM2: Prisma client must exist after `prisma generate`, and admin build must produce `.next/BUILD_ID`
- `deploy.sh` now restarts existing PM2 apps in place instead of deleting them first, reducing the chance of downtime if a later step fails
- `deploy.sh` now performs a post-restart API health check on `http://localhost:4000/health` and fails the deploy if the API does not come back

---

## Data Sources

| Source | Type | Notes |
|--------|------|-------|
| GTO Sales API | `gto` | Orders, payments, invoices via `api.gto.ua/api/private` |
| Google Analytics 4 | `ga4` | Web traffic |
| Redmine | `redmine` | Issue tracking |
| YouTrack | `youtrack` | Issue tracking |
| YouTrack Daily Progress | `youtrack_progress` | Daily progress digest based on issue status changes and comments |

**All monetary values are converted to EUR before AI analysis.**
Exchange rates are fetched from GTO v3 API (`/currency_rates`) and cached in Redis for 24 hours (refreshed daily on first use).

### Looker Studio / PostgreSQL Export

- A dedicated PostgreSQL export for Looker Studio is implemented in the API layer, not as a Telegram/report source
- Main tables:
  - `reporting_gto_orders` — one flattened row per order
  - `reporting_gto_order_lines` — flattened product/service rows per order
  - `reporting_gto_sync_runs` — operational sync log
- Sync service:
  - `apps/api/src/services/gto-looker-sync.service.ts`
  - manual CLI: `npm --workspace apps/api run sync:gto-looker -- --mode=backfill --from=YYYY-MM-DD --to=YYYY-MM-DD`
  - admin API routes: `/api/v1/looker/gto-orders/status`, `/api/v1/looker/gto-orders/default-window`, `/api/v1/looker/gto-orders/sync`
- Daily scheduler:
  - built into API startup via `startGtoLookerSyncScheduler()`
  - runs every day at `08:00` `Europe/Kyiv`
  - refresh window is the last 4 calendar days including the current Kyiv business date
- Currency conversion for this export must use GTO v3 historical rates for the booking creation day (`created_at` date), not today's rate
- Historical currency rates are fetched via `GET /api/v3/currency_rates?date=YYYY-MM-DD`
- Historical endpoint can return numeric currency ids, so the implementation must map ids through `GET /api/v3/currencies` before normalizing rates to EUR
- The export keeps historical rows in PostgreSQL and only rewrites rows for the refreshed order ids inside the current sync window

---

## Currency Handling

- **Service:** `apps/api/src/lib/currency.service.ts`
- **Source:** `https://api.gto.ua/api/v3/currency_rates?apikey=...`
- **Cache:** Redis key `gto:currency_rates:YYYY-MM-DD`, TTL 24h
- **API key:** taken from GTO source credentials (`api_key` field)
- **v3 base URL:** configurable in Settings → GTO API → `gto.v3_base_url`
- **Base currency:** configurable in Settings → GTO API → `currency.base` (default: EUR)

### GTO Cost Calculation Guardrails

- Daily/weekly/monthly P&L for GTO must include only `CNF` hotel/service rows in себестоимость; `PEN` rows are operationally important but must not reduce reported margin until confirmed
- Transfer `price_buy` is **not** universally EUR; supplier-specific handling is required
- Known rule: `SunTransfers` buy prices are treated as EUR, while suppliers like `ITRAVEX` can provide `price_buy` in `UAH` and must respect the row currency unless a supplier tag overrides it
- When investigating negative margin below the expected business floor (roughly worse than `-2%`), first compare computed cost against GTO `Total NETT` / package totals and inspect transfer currency interpretation plus any `PEN` extras

---

## GTO v3 API — Available Static Data

`https://api.gto.ua/api/v3` (same apikey as private API):

| Endpoint | Data |
|----------|------|
| `/currency_rates` | Daily exchange rates |
| `/currencies` | Currency list |
| `/countries` | Countries |
| `/cities` | Cities |
| `/regions` | Regions |
| `/destinations` | Tour destinations |
| `/hotels` | Hotel list |
| `/hotel_info` | Hotel details |
| `/airlines` | Airlines |
| `/airports` | Airports |
| `/departure_cities` | Departure cities |
| `/meals` | Meal plan types |

These can be used in future for enriching reports with geography/hotel context.

### Local GTO Analytics Memory

- Ad-hoc sales analytics for this workspace should first use the local process memo at `docs/gto-local-sales-analytics-process.md`
- Treat `docs/gto-local-sales-analytics-process.md` as the index of local GTO analytical artifacts before reading scripts or reprocessing raw JSONL data
- Current local GTO cache for follow-up analytics questions covers orders created from 2025-01-01 through 2026-05-04:
  - `tmp/gto-sales-2025-01-01_to_2026-05-04/orders-list.jsonl`
  - `tmp/gto-sales-2025-01-01_to_2026-05-04/order-details.jsonl`
  - `tmp/gto-sales-2025-01-01_to_2026-05-04/currency-rates.json`
  - `tmp/gto-sales-2025-01-01_to_2026-05-04/manifest.json`
- Previous cache snapshot remains available in `tmp/gto-sales-2025-01-01_to_2026-04-10/`
- Previous main snapshot also remains available in `tmp/gto-sales-2025-01-01_to_2026-04-29/`
- `tmp/cache-gto-sales-data.ts` now supports fallback credentials via env (`GTO_API_KEY`, `GTO_BASE_URL`, `GTO_V3_BASE_URL`, `GTO_TIMEOUT_SECONDS`) when local Prisma `DataSource` credentials are missing
- `tmp/cache-gto-sales-data.ts` now refreshes incrementally by default when a prior snapshot exists for the same `date_from`; default overlap is 7 days and full refetch can be forced with `GTO_CACHE_INCREMENTAL=0`
- Static GTO v3 dictionaries currently saved locally:
  - `tmp/gto-destinations.json`
  - `tmp/gto-cities.json`
- For Spain destination/supplier analytics, group by system destinations from GTO v3 `/destinations`, not by countries and not only by raw hotel text
- Use GTO v3 `/cities` only as a conservative helper for city-to-destination aliases; preserve unmatched rows instead of forcing uncertain matches
- Current Spain hotel supplier workbook: `output/spreadsheet/gto_spain_hotel_supplier_ranking_2025-12-01_to_2026-04-10.xlsx`
- Current Spain hotel supplier companion JSON: `reports/gto-spain-hotel-supplier-ranking-2025-12-01_to_2026-04-10.json`
- Current broad hotel supplier workbook for Spain, Turkey, Greece, Italy, Egypt, Montenegro, Croatia, and Cyprus: `output/spreadsheet/gto_hotel_supplier_ranking_8_countries_2025-10-01_to_2026-04-10.xlsx`
- Current broad hotel supplier JSON: `reports/gto-hotel-supplier-ranking-8-countries-2025-10-01_to_2026-04-10.json`
- Current CNX comment management DOCX: `output/doc/gto-cnx-comments-management-report-2025-01-01_to_2026-04-10.docx`
- Current CNX comment analysis JSON/Markdown:
  - `reports/gto-cnx-comments-analysis-2025-01-01_to_2026-04-10.json`
  - `reports/gto-cnx-comments-analysis-2025-01-01_to_2026-04-10.md`
- Current sales-depth-by-products DOCX: `output/doc/gto_sales_depth_products_2025_2026.docx`
- Current sales-depth-by-products JSON/Markdown:
  - `reports/gto-sales-depth-products-2025-01-01_to_2026-04-10.json`
  - `reports/gto-sales-depth-products-2025-01-01_to_2026-04-10.md`
- In sales depth by product group, `Packages` is an order-level basket category, while `Hotels`, `Tickets`, `Transfers`, and `Insurance` are non-exclusive presence categories; one order can belong to several groups
- For cancelled-order supplier analysis, supplier presence is multi-touch exposure, not fault attribution

---

## Pipeline: How a Report is Generated

```
Scheduler (node-cron)
  → BullMQ fetch queue
    → fetch.worker: GTOConnector.fetchData() → converts amounts to EUR
      → BullMQ analyze queue
        → analyze.worker: LLMService → ChatGPT
          → BullMQ deliver queue
            → deliver.worker: Telegram bot → sends to subscribers
```

---

## Database (PostgreSQL)

Key models:
- `DataSource` — source definitions (gto, ga4, etc.)
- `SourceCredential` — encrypted API keys per source
- `SourceSetting` — per-source settings (timeout, timezone, etc.)
- `ReportSchedule` — cron schedules per source (daily/weekly/monthly)
- `Report` — generated report records
- `SystemSetting` — global settings (OpenAI key, Telegram token, GTO v3 URL, etc.)
- `User` — admin users
- `TelegramSubscription` — bot subscribers
- `PromptTemplate` / `PromptVersion` — versioned ChatGPT prompts per source

---

## Key Settings (System Settings in Admin Panel)

| Key | Description |
|-----|-------------|
| `llm.api_key` | OpenAI API key |
| `llm.default_model` | GPT model (default: gpt-4o-mini) |
| `telegram.bot_token` | Telegram bot token from @BotFather |
| `telegram.admin_chat_id` | Admin's Telegram chat ID |
| `gto.v3_base_url` | GTO v3 API base URL for currency rates |
| `currency.base` | Base currency for analytics (default: EUR) |
| `scheduler.gto_cron` | Cron for GTO daily report |

---

## Scheduling and Time Zones

- Cron jobs are registered with the source-specific `timezone` from `source_settings` when present; otherwise they fall back to `UTC`
- `ReportSchedule` can optionally define a separate `weekend_cron_expression`; when present, the primary `cron_expression` is used on weekdays/default dates and the weekend cron is used on Saturday/Sunday in the source timezone
- Report period boundaries (`daily` / `weekly` / `monthly`) are also calculated in the source timezone
- Source schedule editing in the back office should label cron fields as source-timezone based, not UTC-based
- Default daily delivery target is `08:00` `Europe/Kyiv` on weekdays and `10:00` `Europe/Kyiv` on weekends when a schedule is configured with both cron fields

## Redmine Reports

- Redmine reports are grouped by project and should include per-project sections for newly created issues, newly answered issues, newly closed issues, and new public comments during the selected period
- Redmine `first response` means the first public comment with non-empty text from responder usernames `i.yarovyi` or `tina` after issue creation
- Redmine `answered` means the issue received at least one public comment with non-empty text from `i.yarovyi` or `tina` during the selected period
- Redmine reports should include a short issue description summary derived from the issue body, plus compact summaries of new public comments
- Redmine connector must page through issue lists and should not truncate datasets at the first 100 issues
- If no qualifying responder comment exists for an issue, `first_response_at`, `first_response_by`, and response-time metrics remain empty/null

## Telegram Bot Reports

- Telegram command menu should expose only two top-level entries: `reports` and `settings`
- `/reports` opens a nested report-generation menu, but only shows sections and buttons explicitly allowed for that user by admin-side access settings in the back office
- Telegram reports menu should use three top-level report sections: `Orders`, `Redmine tickets`, and `Youtrack`
- `Orders` is the umbrella Telegram section for all reports backed by the GTO Sales API
- `Orders -> Sales` should expose `Today`, `Yesterday`, `Last 7 days`, `Summer`, and `Custom period`
- `Orders -> Comments` should expose `Today`, `Yesterday`, `Last 7 days`, and `Custom period`
- `Orders -> Payments` should expose `Today`, `Yesterday`, `Last 7 days`, and `Custom period`
- `Orders -> Agents activity` should expose `Today`, `Yesterday`, `Last 7 days`, and `Custom period`
- `Orders -> Network sales` should expose a first submenu with `General`, `Поїхали з нами`, `TOURS&TICKETS`, `На канікули`, `ХО`, and `Хоттур`
- Each `Orders -> Network sales -> <section>` submenu should expose `7 days`, `30 days`, and `Custom period`
- Network identity for GTO reports is determined from bracketed labels in `agent_name` with fallback to `company_name`
- Network matching is case-insensitive and must only inspect text inside square brackets
- Current supported network matchers are partial matches for `Поїхали з нами`, `TOURS&TICKETS`, `На канікули`, `ХО`, and `Хоттур`
- `ХО` and `Хоттур` should intentionally match partial bracket labels such as `[АЛЬФА ХО]` or `[Хоттур намбер ту]`
- `Orders -> Network sales -> General` should show, for each configured network, orders, tourists, revenue, profitability, share of overall GTO sales by orders/tourists/revenue, and top products by order count with revenue in brackets
- `Orders -> Network sales -> <specific network>` should show orders, tourists, revenue, profitability, top 5 agents by orders with revenue/profit/product mix, product and profit structure, and the most popular destinations
- Telegram report menus should also offer `Custom Period` actions directly in-chat for supported manual reports, using inline calendar buttons inside Telegram
- Access to Telegram reports is admin-managed from the back office per user, and the primary permission is the per-source report access flag (`UserReportPreference`)
- Manual generation in Telegram must depend on source-level access, not on per-schedule subscription toggles
- A source that is allowed for a user may also expose finer per-user manual report permissions for individual Telegram actions built on that source (for example GTO `Yesterday`, `Today`, `Payments Yesterday`, `Payments Today`, `Summer`, `Agents activity`, Redmine rolling windows, YouTrack manual runs, and YouTrack Daily Progress rolling windows)
- Individual manual-report permissions are a second layer under the source-level access: the source must be enabled first, then specific manual report buttons may be enabled or disabled per user
- Per-schedule user preferences are secondary and control only regular delivery/subscription behavior for schedules tied to an already-allowed source
- Regular schedule subscriptions are self-managed by end users in Telegram via `/settings`; users choose which enabled schedules they want to receive
- The Telegram admin whose chat ID matches system setting `telegram.admin_chat_id` should also use `/settings` as an admin console entry point inside the bot
- Admin `/settings` in Telegram should expose pending registration requests and the user list, with inline actions for approving, blocking, deleting users, and toggling global report delivery
- Back office should not grant schedule subscriptions anymore; it should only display saved subscriptions and allow admins to remove them if needed
- In the back-office Users access UI, `YouTrack` and `YouTrack Daily Progress` should be grouped visually under a single `YouTrack` section, while keeping their permissions separate inside that group
- `/settings` should let end users opt into or out of regular schedule subscriptions, but it must not let Telegram users grant themselves source access or re-enable blocked manual report buttons
- `Redmine tickets` submenu should expose manual activity reports for rolling windows `24 hours`, `48 hours`, `7 days`, and `Custom period`
- Redmine rolling-window buttons are manual-only and should use the current moment minus the selected window, not calendar-day boundaries
- `Today` is a same-day GTO sales snapshot for the current business date, not yesterday
- Custom Telegram periods should be chosen with inline calendar buttons: first click selects the start date, second click selects the end date, and `Apply` confirms the range; a single selected day may also be applied as a one-day report
- Custom Telegram periods are limited to 31 calendar days to avoid heavy ad-hoc loads
- Daily GTO sales report no longer includes the seasonal `☀️ Лето` block in the delivered Telegram message
- Summer season overview is exposed from the Telegram `Orders -> Sales` submenu as a dedicated action button: `Summer`
- Current implementation keeps `section4_summer` in connector metrics for reuse, but presents it only in the dedicated summer report flow
- GTO relative report windows (`yesterday`, `last 7 days`, `upcoming`) are anchored to the requested run period end, so manual `/generate` and scheduled runs use the same business date reference
- Manual Telegram `/generate` runs are persisted in `report_runs`, `report_jobs`, `report_results`, and `sent_messages` for later investigation
- `report_runs` should record who initiated a manual run: admin-side launches keep the admin user, and Telegram manual launches should keep the Telegram user so the back office can show the initiator in Report Runs
- New Telegram `/start` registration requests must notify the configured admin chat and include inline moderation actions directly in the notification message

## GTO Date Windows

- GTO `orders_list` treats `date_to` as inclusive
- Daily sales snapshot must therefore query a single target day as `date_from = date_to = target_day`
- Rolling GTO windows (`last 7 days`, `upcoming`) must be calculated explicitly for inclusive `date_to`
- Production/business timezone for GTO should be `Europe/Kyiv`, not `UTC`
- In GTO daily/7-day reports, tourists, destinations, product mix, and top agent are calculated for all orders in the period, while revenue/profit/avg check remain CNF-only and must be labeled `по CNF` in Telegram text
- Telegram GTO daily/7-day reports should also include a short note after the financial block: `Все денежные показатели приведены к EUR.`
- Orders from test agent `GTO for Test-Goodwin` must be excluded from all GTO report metrics and rankings, not just the top-agent block
- Telegram GTO daily/7-day reports should render `🌍 Направления` and `📦 Продукты` as vertical lists with section headers `---🌍 Направления---` and `---📦 Продукты---`, separated by a blank line
- Telegram GTO daily/7-day reports should keep only the `🔴 Отрицательная маржа` anomaly block; generic `⚠️ Прочие аномалии` should not be shown
- In `🔮` upcoming blocks, destination lines should be sorted by tourist count descending
- Telegram GTO daily reports should also keep blank lines between major sections, including before `---📦 Продукты---`, before `🔮 Старт Ближ. 7 дней`, and before `Старт ближ. 30 дней`
- `🔮 Старт Ближ. 7 дней` and `Старт ближ. 30 дней` should render their summary as multiline blocks: orders, tourists, GMV, and gross profit on separate lines
- `Today` GTO report should use the current business day period; `revenue` and `tourists` are calculated over all non-cancelled orders, while `profit` and `avg check` remain CNF-only to avoid overstating margin from ORQ/PEN orders
- `Yesterday` and `Today` GTO reports should include a `Старт туров` block grouped by start month (for example `июнь 2026 - 10 туристов, GMV 2034 EUR, profit 432 EUR`)
- Average sales depth is the number of days between order creation date and travel start date; show it in Telegram `Продукты` lines as `ср. глубина X дн.`, not in the `Старт туров` block
- Telegram GTO `Продукты` blocks should include average sales depth per product line as `ср. глубина X дн.`
- Telegram GTO `Продукты` blocks should include separate lines for `Трансферы` and `Страховки`, but only for standalone orders where that is the only active product in the order
- GTO payments reports should use `/payments_list` with exact business-date filters and convert all amounts to EUR
- Telegram GTO payments reports should present `Payments Today` and `Payments Yesterday` separately, with separate incoming (`type=in`) and outgoing (`type=out`) sections and grouping by `payment_form`
- Telegram GTO `Agents activity` report should show the number of unique active agents for the selected period and the top agents by revenue with their main products
- GTO agent activity should exclude cancelled (`CNX`) orders and test agent `GTO for Test-Goodwin`; product mix should be derived from order details and revenue should be shown in EUR
- For custom Telegram GTO periods, the connector should expose exact requested-period sales and agent-activity sections in metrics, rather than only windows anchored to the run end date
- GTO Comments reports must use the actual requested run period (`daily` / `weekly` / `monthly` or manual equivalent) from `report_period_start` to `report_period_end`; they must not be hardcoded to only `today` and `yesterday`

---

## Telegram Delivery Notes

- Manual `/generate` replies and background report delivery first try `Markdown` in Telegram
- If Telegram rejects the message with a parse-entities error, the bot automatically retries the same text without `parse_mode`
- This fallback is intended to keep report generation working even when LLM output contains unsafe Markdown
- Long Telegram reports are automatically split into smaller chunks before send/reply, preferring paragraph and line boundaries to avoid `message is too long` failures
- `YouTrack Daily Progress` post-processes Telegram text and expands bare issue keys to `KEY — task title`, so blocks like `кто что сделал` and `основные проблемы` stay readable even if the LLM omits the summary after a task key
- In `YouTrack Daily Progress`, the `Кто что сделал` block is normalized into per-person sections with one task per line in the form `KEY — task title — action taken`, so each task line includes both the task name and what actually changed
- `Youtrack` submenu should expose manual rolling-window actions `24 hours`, `48 hours`, `7 days`, and `Custom period`
- These rolling-window buttons are manual-only and use the current moment minus the selected number of hours, not calendar-day boundaries

---

## Deploy Process

```bash
# Automatic on git push to main (GitHub Actions)
# Manual:
ssh root@46.225.220.88 'bash /opt/analytics-platform/deploy.sh'
```

Tracked `deploy.sh` does:
1. if the server checkout is dirty, creates an automatic stash `auto-pre-deploy-<UTC timestamp>`
2. `git pull`
3. `npm install --include=dev` with one clean-reinstall retry if `node_modules` is corrupted
4. `prisma migrate deploy` + `prisma generate` (using local node_modules/.bin/prisma), then verifies Prisma client output exists
5. `npx tsx src/db/seed.ts` (upsert — never overwrites existing data)
6. `next build`, then verifies `.next/BUILD_ID` exists
7. PM2 restart/update cycle without deleting healthy apps first
8. API health check on `http://localhost:4000/health`
9. GitHub Actions then runs `cd /opt/analytics-platform && bash scripts/refresh-claude-docs.sh`

**Important:** seed uses `update: {}` for all upserts — existing settings/credentials are NEVER overwritten by deploy.

**Operational rule for AI agents:** after any documentation-affecting code or config change, update `AGENTS.md` first, then regenerate `CLAUDE.md` with `bash scripts/refresh-claude-docs.sh` so Claude sees the latest operational context.

---

## Prisma Notes

- Local project uses Prisma **v5.22.0**
- Server has global Prisma v7 — always use `node_modules/.bin/prisma`, never `npx prisma`
- Migrations: `apps/api/prisma/migrations/`
- Schema: `apps/api/prisma/schema.prisma`

---

## Admin Panel Login

- URL: https://dsym.goodwin-soft.com/analytics-platform
- Email: `admin@analytics.local`
- Password: `admin123` (change after first login)

---

## Common Commands

```bash
# Check API health
curl http://localhost:4000/health

# PM2 logs
pm2 logs analytics-api --lines 50
pm2 logs analytics-admin --lines 50

# Run seed manually
cd /opt/analytics-platform/apps/api && npx tsx src/db/seed.ts

# Run migration manually
set -a && source /opt/analytics-platform/.env && set +a
cd /opt/analytics-platform/apps/api
node /opt/analytics-platform/node_modules/.bin/prisma migrate deploy

# Invalidate currency cache (force refresh tomorrow's first run)
redis-cli DEL gto:currency_rates:$(date +%Y-%m-%d)
```
