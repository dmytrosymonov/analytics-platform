# Analytics Platform — Project Documentation

> **Updated:** 2026-03-25
> **Owner:** Dmytro Symonov
> **Production:** https://dsym.goodwin-soft.com/analytics-platform

---

## What This Is

An internal analytics back-office for a travel/tourism company. It collects data from multiple sources (GTO, GA4, Redmine, YouTrack, Fireflies.ai), runs AI analysis via ChatGPT, and delivers reports via Telegram.

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

**Claude docs on server:** after each deploy GitHub Actions runs `bash scripts/refresh-claude-docs.sh`, which rebuilds `/opt/analytics-platform/CLAUDE.md` from this file and appends the latest deployed commit metadata for Claude handoff.

**GitHub access (verified 2026-04-01):**
- Local `gh` auth is valid for account `dmytrosymonov`
- Repo remote uses HTTPS: `https://github.com/dmytrosymonov/analytics-platform.git`
- `git push --dry-run origin HEAD:refs/heads/codex/github-access-check` succeeds
- SSH auth to GitHub is NOT configured yet for `~/.ssh/id_ed25519` (`Permission denied (publickey)`)
- Practical release path for agents: commit locally → push via HTTPS remote → GitHub Actions deploys to server

---

## Data Sources

| Source | Type | Notes |
|--------|------|-------|
| GTO Sales API | `gto` | Orders, payments, invoices via `api.gto.ua/api/private` |
| Google Analytics 4 | `ga4` | Web traffic |
| Redmine | `redmine` | Issue tracking |
| YouTrack | `youtrack` | Issue tracking |
| Fireflies.ai | `fireflies` | Meeting transcripts |

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

## Deploy Process

```bash
# Automatic on git push to main (GitHub Actions)
# Manual:
ssh root@46.225.220.88 'bash /opt/analytics-platform/deploy.sh'
```

Deploy script does:
1. `git pull`
2. `npm install --include=dev`
3. `prisma migrate deploy` + `prisma generate` (using local node_modules/.bin/prisma)
4. `npx tsx src/db/seed.ts` (upsert — never overwrites existing data)
5. `next build`
6. PM2 restart
7. GitHub Actions then runs `cd /opt/analytics-platform && bash scripts/refresh-claude-docs.sh`

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
