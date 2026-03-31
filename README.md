# Analytics Platform

Платформа агрегации аналитики с доставкой отчётов в Telegram. Собирает данные из нескольких источников, анализирует их через ChatGPT и рассылает отчёты подписчикам по расписанию.

**Production:** https://dsym.goodwin-soft.com/analytics-platform
**Server:** `46.225.220.88` (root)
**Repo:** https://github.com/dmytrosymonov/analytics-platform

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
| Google Analytics 4 | `ga4` | Service Account JSON | GA4 Data API v1 |
| Redmine | `redmine` | API Key header | `/issues.json` |
| YouTrack | `youtrack` | Bearer token | `/api/issues` |
| Fireflies.ai | `fireflies` | API Key header | GraphQL API |

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
| GA4 | Ежедневный, Еженедельный |
| Redmine | Ежедневный, Еженедельный |
| YouTrack | Ежедневный, Еженедельный |
| Fireflies | Ежедневный, Еженедельный |

**Периоды вычисляются автоматически:**
- `daily` → вчера 00:00 — сегодня 00:00
- `weekly` → 7 дней назад — сегодня 00:00
- `monthly` → 1-е прошлого месяца — 1-е текущего месяца

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
- Настроить какие расписания получает каждый пользователь
- Добавить вручную по Telegram ID

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

**`deploy.sh` делает:**
```bash
git pull
npm install --legacy-peer-deps --include=dev
node /opt/analytics-platform/node_modules/.bin/prisma migrate deploy
node /opt/analytics-platform/node_modules/.bin/prisma generate
npx tsx src/db/seed.ts   # безопасен, не перезаписывает данные
npm run build            # Next.js admin
pm2 restart all
```

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

Документация актуальна на: **31 марта 2026**

### История изменений

| Дата | Изменение |
|------|----------|
| 31.03.2026 | Telegram бот: меню подписок (`/reports`), генерация отчётов по требованию (`/generate`), свободные AI-запросы к данным (`/ask`), регистрация команд через setMyCommands |
| 31.03.2026 | Admin UI: страница API Logs (`/connector-logs`) для просмотра HTTP-запросов к внешним API с фильтрами по коннектору/типу/URL, авто-обновлением и кнопкой очистки |
| 31.03.2026 | HTTP-логирование: централизованный `createHttpClient()` на основе axios interceptors во всех коннекторах (GTO, Redmine, YouTrack, Fireflies) и currency.service; логи хранятся в Redis (max 1000), параметры-секреты редактируются |
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
| 25.03.2026 | Добавлен Fireflies.ai коннектор |
| 25.03.2026 | Конвертация валют через GTO v3 API, кэш в Redis (24ч) |
| 25.03.2026 | Исправлен GTO коннектор (auth, endpoints, analytics) |
| 25.03.2026 | CI/CD через GitHub Actions |
| 25.03.2026 | Telegram бот + управление пользователями |
| 25.03.2026 | Базовая платформа, 3 источника (GTO, GA4, Redmine) |
