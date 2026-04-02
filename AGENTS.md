# Analytics Platform — Project Documentation

> **Updated:** 2026-03-25
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
- Report period boundaries (`daily` / `weekly` / `monthly`) are also calculated in the source timezone
- `youtrack_progress` defaults to `Europe/Kyiv` and is intended to run after the daily standup
- Default `youtrack_progress` schedule: `Daily Progress Report` at `12:15` `Europe/Kyiv`

## Telegram Bot Reports

- Telegram command menu should expose only two top-level entries: `reports` and `settings`
- `/reports` opens a nested report-generation menu with sections `Sales`, `Comments`, and `Youtrack`
- `Sales` submenu currently includes `Yesterday`, `Today`, and `Summer`
- `Today` is a same-day GTO sales snapshot for the current business date, not yesterday
- Daily GTO sales report no longer includes the seasonal `☀️ Лето` block in the delivered Telegram message
- Summer season overview is exposed from the Telegram `Sales` submenu as a dedicated action button: `Summer`
- Current implementation keeps `section4_summer` in connector metrics for reuse, but presents it only in the dedicated summer report flow
- GTO relative report windows (`yesterday`, `last 7 days`, `upcoming`) are anchored to the requested run period end, so manual `/generate` and scheduled runs use the same business date reference
- Manual Telegram `/generate` runs are persisted in `report_runs`, `report_jobs`, `report_results`, and `sent_messages` for later investigation

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
- `Yesterday` and `Today` GTO reports should include a `Старт туров` block grouped by start month (for example `июнь 2026 - 10 туристов, GMV 2034 EUR, profit 432 EUR, ср. глубина 24 дн.`)
- Average sales depth is the number of days between order creation date and travel start date; show it in the `Старт туров` block as `ср. глубина X дн.`
- Telegram GTO `Продукты` blocks should include average sales depth per product line as `ср. глубина X дн.`
- Telegram GTO `Продукты` blocks should include separate lines for `Трансферы` and `Страховки`, but only for standalone orders where that is the only active product in the order

---

## Telegram Delivery Notes

- Manual `/generate` replies and background report delivery first try `Markdown` in Telegram
- If Telegram rejects the message with a parse-entities error, the bot automatically retries the same text without `parse_mode`
- This fallback is intended to keep report generation working even when LLM output contains unsafe Markdown

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
