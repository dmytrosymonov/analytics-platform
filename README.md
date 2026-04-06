# Analytics Platform

Платформа агрегации аналитики с доставкой отчётов в Telegram. Собирает данные из нескольких источников, анализирует их через ChatGPT и рассылает отчёты подписчикам по расписанию.

**Production:** https://dsym.goodwin-soft.com/analytics-platform
**Server:** `46.225.220.88` (root)
**Repo:** https://github.com/dmytrosymonov/analytics-platform
**Claude handoff doc:** `/opt/analytics-platform/CLAUDE.md` is refreshed after each deploy from `AGENTS.md` plus current deploy metadata.
**Deploy script:** tracked in repo as [deploy.sh](/Users/dmitry.simonov/Library/CloudStorage/OneDrive-Personal/Pet projects/analytics-platform/deploy.sh) and executed on server at `/opt/analytics-platform/deploy.sh`

## GitHub Access

- Verified on 2026-04-01: GitHub CLI auth is valid for account `dmytrosymonov`
- Current remote: `https://github.com/dmytrosymonov/analytics-platform.git`
- HTTPS push works; dry-run branch push succeeds
- SSH auth to GitHub is not configured for the local `id_ed25519` key yet
- Recommended release flow for local agents: commit locally -> push to GitHub over HTTPS -> let GitHub Actions deploy to server
- On 2026-04-01 the server had dirty local files; they were preserved in stash `pre-deploy-safety-2026-04-01`
- `deploy.sh` now auto-stashes dirty server-local changes before `git pull`, which prevents generated `CLAUDE.md` or other runtime edits from blocking the next deploy

---

## Архитектура

```
analytics-platform/
├── apps/
│   ├── api/          # Fastify API, порт 4000 (PM2: analytics-api)
│   └── admin/        # Next.js Admin UI, порт 4001 (PM2: analytics-admin)
├── packages/
│   └── shared/       # Общие TypeScript типы
├── .github/
│   └── workflows/
│       └── deploy.yml  # CI/CD: push → GitHub Actions → SSH deploy
└── deploy.sh           # (на сервере) /opt/analytics-platform/deploy.sh
```

### Стек технологий

| Слой | Технология |
|------|-----------|
| API | Fastify 4 + TypeScript |
| БД | PostgreSQL + Prisma 5 |
| Очереди | BullMQ + Redis |
| LLM | OpenAI GPT-4o-mini |
| Telegram бот | Telegraf 4 |
| Admin UI | Next.js 15 + TailwindCSS |
| Монорепо | Turborepo |
| CI/CD | GitHub Actions → SSH |
| Процессы | PM2 |

---

## Поток данных

```
Cron (node-cron)
    └─→ fetchQueue (BullMQ)
            └─→ fetch.worker → Connector (GTO/GA4/Redmine/...) → ReportResult
                    └─→ analyzeQueue (BullMQ)
                            └─→ analyze.worker → OpenAI → ReportResult (с анализом)
                                    └─→ deliveryQueue (BullMQ)
                                            └─→ deliver.worker → Telegram Bot → Пользователи
```

---

## Источники данных

| Источник | Тип | Аутентификация | Эндпоинты |
|---------|-----|---------------|-----------|
| GTO Sales API | `gto` | `?apikey=` query param | `/orders_list`, `/payments_list` (in/out), `/invoices_list` (in/out) |
| GTO Comments Analysis | `gto_comments` | `?apikey=` query param | `/orders_list` + `/order_data` (детали заказа с комментариями) |
| Google Analytics 4 | `ga4` | Service Account JSON | GA4 Data API v1 |
| Redmine | `redmine` | API Key header | `/issues.json` |
| YouTrack | `youtrack` | Bearer token | `/api/issues` |
| YouTrack Daily Progress | `youtrack_progress` | Bearer token | `/api/issues` (статусы + комментарии) |

### Что собирает GTO Comments коннектор

Анализирует комментарии к заказам за **сегодня и вчера** через AI:

- **Период**: сегодня (00:00–23:59) + вчера (00:00–23:59), параллельный fetch
- **Детализация**: до 120 заказов на период, 8 параллельных запросов к `/order_data`
- **Анализируемые статусы**: CNF, CNX, ORQ, PEN (все активные заказы)
- **Статистика**: кол-во заказов и заказов с комментариями по каждому статусу
- **Фильтрация**: удаляет HTML-теги, автоматические напоминания об оплате, телефоны и короткий «шум»
- **Срочные комментарии**: выделяются отдельно (тип `urgent`), до 8 штук
- **LLM анализ**: AI выявляет повторяющиеся темы, проблемы, паттерны по статусам

### Что собирает GTO коннектор

- **Секция 1 — текущий период** (`/orders_list`): всего заказов, CNF/CNX/pending; выручка и прибыль в EUR (только CNF), средний чек, топ направления с флагами стран и % туристов
- **Секция 2 — поставщики**: топ поставщики по стоимости (`price_buy`) в EUR, очищенные имена (без тегов `[EUR]/[UAH]`)
- **Секция 3 — предстоящие туры на 7 дней** (`section3_upcoming_7days`): туры на следующие 7 дней
- **Секция 4 — предстоящие туры на 30 дней** (`section3_upcoming_30days`): отдельный fetch для туров на следующие 30 дней
- **Летние направления**: агрегация июнь+июль+август, топ направления с % туристов
- **Платежи** (`/payments_list`): входящие и исходящие; выручка по валютам, нетто, средний платёж
- **Счета** (`/invoices_list`): выставленные и исходящие суммы
- **Anomaly detection**: флаг заказов с маржой < −30%, топ-3 проблемных заказа
- **Санитарная проверка авиабилетов**: если `costConverted > sellConverted × 2` — валюта определяется из тега поставщика (`[UAH]`/`[EUR]`/`[KZT]`)

---

## Расписания и отчёты

Каждый источник имеет несколько расписаний с разным периодом:

| Источник | Расписания |
|---------|-----------|
| GTO | Ежедневный (08:00), Еженедельный (пн 09:00), Ежемесячный (1-е 09:00) |
| GTO Comments | Ежедневный |
| GA4 | Ежедневный, Еженедельный |
| Redmine | Ежедневный, Еженедельный |
| YouTrack | Ежедневный, Еженедельный |
| YouTrack Daily Progress | Ежедневный (12:15 Europe/Kyiv) |

**Периоды вычисляются автоматически:**
- `daily` → вчера 00:00 — сегодня 00:00
- `weekly` → 7 дней назад — сегодня 00:00
- `monthly` → 1-е прошлого месяца — 1-е текущего месяца

**Выходные дни:** каждое расписание может иметь `weekend_cron_expression` — отдельный cron для субботы/воскресенья (по умолчанию ежедневный отчёт GTO — 08:00 в будни, 10:00 в выходные). Настраивается в admin UI на странице источников.

---

## Пользователи и подписки

Пользователи регистрируются через Telegram бота командой `/start`. Статусы:

| Статус | Описание |
|--------|---------|
| `pending` | Ожидает одобрения в admin панели |
| `approved` | Активен, получает отчёты |
| `blocked` | Заблокирован |
| `deleted` | Удалён |

В admin панели (Users) можно:
- Одобрить/заблокировать пользователя
- Управлять доступом пользователя к источникам данных (per-source)
- Управлять доступом к конкретным ручным отчётам в Telegram
- Просматривать подписки на расписания (только чтение; удалить можно)
- Добавить вручную по Telegram ID

Подписки на расписания управляются самостоятельно пользователем через `/settings` в Telegram боте.

---

## Telegram бот — команды

Пользователи взаимодействуют с ботом через следующие команды:

| Команда | Описание |
|---------|---------|
| `/start` | Регистрация / приветствие |
| `/help` | Справка по командам |
| `/reports` | Управление подписками — inline-клавиатура для подписки/отписки от расписаний |
| `/generate` | Генерация отчёта по требованию — выбор расписания → запуск полного пайплайна (коннектор → LLM) только для запросившего |
| `/ask` | Свободный вопрос к данным — выбор источника, ввод вопроса на естественном языке → LLM отвечает по данным за 7 дней |

Бот автоматически регистрирует меню команд через `setMyCommands` при старте.

---

## Хранение данных и безопасность

### Что где хранится

| Данные | Таблица | Примечание |
|--------|---------|-----------|
| Credentials источников | `source_credentials` | Зашифровано AES-256 |
| Настройки источников | `source_settings` | key-value |
| Системные настройки | `system_settings` | OpenAI ключ, Telegram токен |
| Пользователи | `users` | telegramId как BigInt → в API отдаётся как string |
| Подписки | `user_schedule_preferences` | per-user per-schedule |
| Отчёты | `report_results` | Сырые данные + LLM анализ |
| Аудит | `audit_logs` | Все действия |

### Безопасность при деплое

Seed использует `update: {}` везде — **никакие пользовательские данные не перезаписываются** при деплое:
- API ключи и credentials → безопасны
- OpenAI ключ, Telegram токен → безопасны
- Настройки источников → безопасны
- Пользователи и подписки → не трогаются seed вообще

**Бэкап БД:** каждую ночь в 3:00 UTC → `/opt/backups/analytics/` (хранятся 14 дней)

---

## CI/CD

**Каждый `git push` в `main`:**
1. GitHub Actions запускает `deploy.yml`
2. SSH подключение к серверу
3. Запуск `/opt/analytics-platform/deploy.sh`
4. Обновление `/opt/analytics-platform/CLAUDE.md` через `bash scripts/refresh-claude-docs.sh`

**`deploy.sh` делает:**
```bash
if repo is dirty:
  git stash push -u -m "auto-pre-deploy-<UTC timestamp>"
git pull
npm install --legacy-peer-deps --include=dev
cd apps/admin && npm install --legacy-peer-deps --include=dev && cd ../..
cd apps/api && npm install --legacy-peer-deps --include=dev && cd ../..
node /opt/analytics-platform/node_modules/.bin/prisma migrate deploy
node /opt/analytics-platform/node_modules/.bin/prisma generate
npx tsx src/db/seed.ts   # безопасен, не перезаписывает данные
npm run build            # Next.js admin
pm2 delete analytics-api || true
pm2 delete analytics-admin || true
pm2 start ...
pm2 save
```

**После этого GitHub Actions выполняет:**
```bash
cd /opt/analytics-platform
bash scripts/refresh-claude-docs.sh
```

**Для ручного деплоя тоже обновляй Claude-документацию:**
```bash
ssh root@46.225.220.88 'cd /opt/analytics-platform && bash /opt/analytics-platform/scripts/refresh-claude-docs.sh'
```

**Правило для AI-агентов:** после изменений, влияющих на архитектуру, доступы, deploy или runtime workflow, сначала обновить `AGENTS.md`, затем сразу выполнить `bash scripts/refresh-claude-docs.sh`.

**GitHub Secrets:** `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`

---

## Локальная разработка

```bash
# Установка зависимостей
npm install

# Запуск API (порт 3000)
make dev-api

# Запуск Admin UI (порт 3001)
make dev-admin

# Оба сразу
make dev

# Миграции
make migrate

# Seed
make seed
```

**Переменные окружения** (скопировать из `.env.example`):

```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
ENCRYPTION_MASTER_KEY=<64 hex chars>
JWT_SECRET=<min 32 chars>
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:3001
NEXT_PUBLIC_API_URL=http://localhost:3000
```

---

## Admin UI — разделы

| Раздел | URL | Описание |
|--------|-----|---------|
| Dashboard | `/dashboard` | Метрики системы |
| Sources | `/sources` | Настройка источников, credentials, тест |
| Users | `/users` | Управление подписчиками |
| Reports | `/reports` | История отчётов, просмотр |
| Prompts | `/prompts` | Редактор LLM промптов |
| Settings | `/settings` | OpenAI ключ, Telegram, модель |
| Audit | `/audit` | Журнал действий |
| API Logs | `/connector-logs` | Логи HTTP запросов к внешним API (debug) |

**Вход:** `admin@analytics.local` / `admin123` (сменить в production через `ADMIN_PASSWORD` в `.env`)

---

## API эндпоинты

Базовый URL: `https://dsym.goodwin-soft.com/api/v1`

| Метод | Путь | Описание |
|-------|------|---------|
| POST | `/auth/login` | Вход |
| GET | `/auth/me` | Текущий пользователь |
| GET | `/sources` | Список источников |
| PATCH | `/sources/:id/credentials` | Сохранить credentials |
| POST | `/sources/:id/test` | Тест подключения |
| GET | `/users` | Список пользователей |
| PATCH | `/users/:id/status` | Изменить статус |
| GET | `/reports` | История отчётов |
| POST | `/reports/run/:scheduleId` | Запустить вручную |
| GET | `/schedules` | Все расписания |
| GET | `/settings` | Системные настройки |
| PATCH | `/settings/:key` | Обновить настройку |
| GET | `/health` | Health check |
| GET | `/connector-logs` | Логи HTTP запросов коннекторов (из Redis) |
| DELETE | `/connector-logs` | Очистить логи (flush Redis list) |

---

## База данных

**Подключение на сервере:**
```bash
source /opt/analytics-platform/.env && psql "$DATABASE_URL"
```

**Миграции:**
```bash
# На сервере вручную
cd /opt/analytics-platform/apps/api
node /opt/analytics-platform/node_modules/.bin/prisma migrate deploy
node /opt/analytics-platform/node_modules/.bin/prisma generate
```

**Важно:** На сервере установлен Prisma v7 глобально, но он несовместим с нашей схемой. Всегда использовать локальный бинарь: `node /opt/analytics-platform/node_modules/.bin/prisma`

---

## Известные особенности

- **BigInt telegramId**: хранится как `BigInt` в PostgreSQL, в API конвертируется в `string` через `serializeUser()`
- **JWT**: в development режиме срок жизни токена 8h, в production 15min
- **Prisma**: используется локальный v5.22.0, не глобальный v7 (несовместим)
- **Credentials**: зашифрованы AES-256, ключ в `ENCRYPTION_MASTER_KEY`
- **Rate limit**: 200 req/min, хранится в Redis

---

## Мониторинг на сервере

```bash
# Статус процессов
pm2 status

# Логи API
pm2 logs analytics-api --lines 50

# Логи Admin
pm2 logs analytics-admin --lines 50

# Health check
curl http://localhost:4000/health

# Список бэкапов БД
ls -la /opt/backups/analytics/
```

---

## Последнее обновление

Документация актуальна на: **6 апреля 2026**

### История изменений

| Дата | Изменение |
|------|----------|
| 03.04.2026 | Расписания: добавлено поле `weekend_cron_expression` в `ReportSchedule` — отдельный cron-выражение для выходных дней; настраивается в admin UI на странице источников |
| 03.04.2026 | Telegram: подписки на расписания перенесены в самообслуживание — пользователи управляют подписками через `/settings`, admin панель отображает их только для чтения (без редактирования) |
| 03.04.2026 | GTO Comments: исправлены ручные периоды — коннектор теперь использует фактический запрошенный период run (а не жёстко задвинутые «сегодня и вчера») |
| 03.04.2026 | Telegram: расширено управление доступом к ручным отчётам — все типы отчётов (YouTrack, Redmine, GTO Payments, GTO Summer и др.) теперь имеют отдельные переключатели per-user |
| 03.04.2026 | Admin UI + API: управление доступом к источникам per-user — доступ к ручной генерации отчётов в Telegram контролируется отдельно по каждому источнику |
| 03.04.2026 | Telegram: доступ к источникам стал приоритетным при отображении меню отчётов (per-source access флаг, а не per-schedule подписки) |
| 03.04.2026 | Admin UI: управление доступом к отчётам per-user — можно выдать/отозвать доступ к каждому источнику отдельно |
| 03.04.2026 | Redmine: аналитика первых ответов по проектам — время первого ответа, кто ответил, количество отвеченных и закрытых задач |
| 02.04.2026 | GTO: платежи сегодня и вчера (`Payments Today` / `Payments Yesterday`) — отдельные секции входящих/исходящих по форме оплаты |
| 02.04.2026 | Telegram: длинные отчёты автоматически разбиваются на части (обход ограничения Telegram на длину сообщения) |
| 02.04.2026 | YouTrack Daily Progress: блок «Кто что сделал» нормализован в per-person секции с KEY — заголовок — действие; раскрытие задач с заголовками в блоках отчёта |
| 02.04.2026 | YouTrack Daily Progress: кнопки ручных окон 24h / 48h / 72h в Telegram-меню |
| 02.04.2026 | GTO: добавлена средняя глубина продаж (`ср. глубина X дн.`) в блоки продуктов и блок старта туров |
| 02.04.2026 | GTO: добавлена разбивка по месяцам старта туров в отчётах Yesterday и Today |
| 02.04.2026 | GTO: исправлен расчёт прибыли за Today (ORQ/PEN заказы не снижают маржу) |
| 02.04.2026 | GTO: Summer section перенесена в отдельную кнопку `Summer` в Telegram-меню; в обычные отчёты не включается |
| 02.04.2026 | GTO: окна отчётов привязаны к запрошенному периоду (ручной /generate и плановые запуски используют одну бизнес-дату); date_to трактуется включительно |
| 02.04.2026 | GTO: ручные запуски через /generate сохраняются в report_runs/report_jobs/report_results |
| 02.04.2026 | GTO: состав отчёта выровнен с Excel-семантикой, уточнена пометка EUR в финансовом блоке, улучшена вёрстка Telegram-отчёта |
| 02.04.2026 | YouTrack Daily Progress: новый коннектор (`youtrack_progress`) — ежедневный дайджест прогресса на основе изменений статусов и комментариев к задачам (расписание 12:15 Europe/Kyiv) |
| 02.04.2026 | Удалён источник Fireflies из платформы |
| 02.04.2026 | GTO: исправлен расчёт себестоимости для трансферов и PEN-строк (transfer price_buy не всегда EUR; PEN-строки не должны снижать маржу до подтверждения) |
| 02.04.2026 | Telegram: автоматический fallback на plain text при ошибках parse_mode (LLM иногда генерирует небезопасный Markdown) |
| 02.04.2026 | Deploy script: валидация артефактов сборки перед перезапуском PM2, restart вместо delete+start, post-restart health check API |
| 02.04.2026 | Deploy script: auto-stash грязных изменений на сервере перед git pull, retry npm install с очисткой node_modules при broken install state |
| 02.04.2026 | GTO: anomaly detection разделён на две категории — отрицательная маржа и завышенная цена |
| 02.04.2026 | Connector logs: лимит записей на странице увеличен с 1000 до 5000 |
| 02.04.2026 | GTO: улучшена точность данных (пагинация, диагностика), исправлено определение валюты для отелей и услуг |
| 02.04.2026 | Seed: принудительная активация v1 промпта при деплое, backfill source preferences |
| 01.04.2026 | GTO Comments Analysis: новый коннектор с AI-анализом комментариев к заказам (сегодня + вчера), выявление тем по статусам CNF/CNX/ORQ/PEN, срочные комментарии, фильтрация авто-сообщений |
| 01.04.2026 | HTTP-логи: персистентное хранение на диск (14-дневная ротация через NDJSON-файлы), полный body ответа до 100 КБ, нет ограничений по размеру |
| 01.04.2026 | Логирование OpenAI: запросы и ответы к OpenAI теперь пишутся в connector logs (как отдельный источник `openai`) |
| 01.04.2026 | Исправлена команда `/generate` в Telegram боте — неверные имена переменных промпта приводили к галлюцинациям LLM |
| 01.04.2026 | GTO: топ направлений сортируется по количеству туристов, а не по количеству заказов |
| 31.03.2026 | Telegram бот: меню подписок (`/reports`), генерация отчётов по требованию (`/generate`), свободные AI-запросы к данным (`/ask`), регистрация команд через setMyCommands |
| 31.03.2026 | Admin UI: страница API Logs (`/connector-logs`) для просмотра HTTP-запросов к внешним API с фильтрами по коннектору/типу/URL, авто-обновлением и кнопкой очистки |
| 31.03.2026 | HTTP-логирование: централизованный `createHttpClient()` на основе axios interceptors во всех коннекторах (GTO, Redmine, YouTrack) и currency.service; логи хранятся в Redis (max 1000), параметры-секреты редактируются |
| 27.03.2026 | GTO: отслеживание стоимости по каждому поставщику через supplierCosts map (вместо деления итога), количество туристов в разбивке по направлениям/турпродуктам/агентам, улучшен anomaly detection (profitPct < −30%), обновлён seed-шаблон промпта |
| 27.03.2026 | GTO: sanity check авиабилетов (определение валюты из тега поставщика), anomaly detection заказов с маржой < −30%, отображение одной даты периода |
| 27.03.2026 | GTO: исправлен расчёт текущей даты (всегда `new Date()`), пагинация при загрузке данных, стоимость поставщиков по `price_buy`, эмодзи-флаги стран |
| 27.03.2026 | GTO: новый формат отчёта — секция предстоящих туров на 30 дней, летние направления июнь–август с % туристов, очистка имён поставщиков |
| 27.03.2026 | Исправлен расчёт стоимости GTO: определение валюты через теги поставщика |
| 26.03.2026 | GTO коннектор: 4-секционный ежедневный отчёт с детальной аналитикой и сравнительными данными |
| 26.03.2026 | GTO коннектор: выручка и прибыль фильтруются только по подтверждённым (CNF) заказам |
| 26.03.2026 | Исправлен расчёт выручки и стоимости в GTO (корректный маппинг данных из API) |
| 26.03.2026 | Исправлено отрицательное значение прибыли (неверные метки валюты в ответе GTO API) |
| 26.03.2026 | Исправлен выбор активной версии промпта (используется activeVersionId из шаблона) |
| 25.03.2026 | Конвертация валют через GTO v3 API, кэш в Redis (24ч) |
| 25.03.2026 | Исправлен GTO коннектор (auth, endpoints, analytics) |
| 25.03.2026 | CI/CD через GitHub Actions |
| 25.03.2026 | Telegram бот + управление пользователями |
| 25.03.2026 | Базовая платформа, 3 источника (GTO, GA4, Redmine) |
