import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../lib/password';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Admin user
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await hashPassword(adminPassword);
  const admin = await prisma.adminUser.upsert({
    where: { email: 'admin@analytics.local' },
    create: { email: 'admin@analytics.local', passwordHash: hash, name: 'System Admin', role: 'superadmin' },
    update: {},
  });
  console.log('Admin user:', admin.email);

  // Data sources
  // Note: 'gto_comments' is added by migration; cast to any so local tsc doesn't complain before prisma generate.
  const sources: Array<{ name: string; type: any; description: string }> = [
    { name: 'GTO Sales API',          type: 'gto',          description: 'GTO sales, orders, payments analytics' },
    { name: 'GTO Comments Analysis',  type: 'gto_comments', description: 'AI analysis of order comments: main topics, complaints, cancellation reasons' },
    { name: 'Google Analytics 4',     type: 'ga4',          description: 'Web traffic and user behavior analytics' },
    { name: 'Redmine',                type: 'redmine',       description: 'Project management and issue tracking analytics' },
    { name: 'YouTrack',               type: 'youtrack',      description: 'YouTrack issue tracker and project analytics' },
    { name: 'YouTrack Daily Progress',type: 'youtrack_progress', description: 'Daily progress digest based on status changes and issue comments' },
  ];

  for (const src of sources) {
    const source = await prisma.dataSource.upsert({
      where: { type: src.type },
      create: src,
      update: { name: src.name, description: src.description },
    });

    // Default schedules
    const defaultSchedules: Record<string, { name: string; description: string; cron: string; periodType: 'daily' | 'weekly' | 'monthly' }[]> = {
      gto:      [
        { name: 'Daily Sales Report',   description: 'Sales metrics for yesterday',        cron: '0 8 * * *',   periodType: 'daily'   },
        { name: 'Weekly Sales Summary', description: 'Aggregated sales for the past week',  cron: '0 9 * * 1',   periodType: 'weekly'  },
        { name: 'Monthly Sales Report', description: 'Full month sales analysis',            cron: '0 9 1 * *',   periodType: 'monthly' },
      ],
      gto_comments: [
        { name: 'Daily Comments Report',   description: 'AI analysis of order comments for today and yesterday', cron: '0 9 * * *', periodType: 'daily'   },
        { name: 'Weekly Comments Report',  description: 'AI analysis of order comments for the past 7 days',    cron: '0 9 * * 1', periodType: 'weekly'  },
        { name: 'Monthly Comments Report', description: 'AI analysis of order comments for the past 30 days',   cron: '0 9 1 * *', periodType: 'monthly' },
      ],
      ga4:      [
        { name: 'Daily Traffic Report',  description: 'Web traffic metrics for yesterday',  cron: '0 8 * * *',   periodType: 'daily'   },
        { name: 'Weekly Traffic Summary',description: 'Aggregated traffic for the past week',cron: '0 9 * * 1',  periodType: 'weekly'  },
      ],
      redmine:  [
        { name: 'Daily Issues Report',   description: 'Issue activity for yesterday',        cron: '0 8 * * *',   periodType: 'daily'   },
        { name: 'Weekly Issues Summary', description: 'Aggregated issues for the past week', cron: '0 9 * * 1',   periodType: 'weekly'  },
      ],
      youtrack: [
        { name: 'Daily Issues Report',   description: 'Issue activity for yesterday',        cron: '0 8 * * *',   periodType: 'daily'   },
        { name: 'Weekly Sprint Summary', description: 'Sprint progress for the past week',   cron: '0 9 * * 1',   periodType: 'weekly'  },
      ],
      youtrack_progress: [
        { name: 'Daily Progress Report', description: 'Yesterday progress after the daily standup', cron: '15 12 * * *', periodType: 'daily' },
      ],
    };

    for (const sch of defaultSchedules[src.type] || []) {
      const existing = await prisma.reportSchedule.findFirst({
        where: { sourceId: source.id, name: sch.name },
      });
      if (!existing) {
        await prisma.reportSchedule.create({
          data: { sourceId: source.id, name: sch.name, description: sch.description, cronExpression: sch.cron, periodType: sch.periodType, isEnabled: false },
        });
      }
    }

    // Default settings
    const defaultSettings: Record<string, Record<string, string>> = {
      gto: { request_timeout_seconds: '30', retry_count: '3', retry_backoff_seconds: '2', max_parallel_requests: '5', timezone: 'Europe/Kiev' },
      gto_comments: { request_timeout_seconds: '30', retry_count: '3', retry_backoff_seconds: '2', timezone: 'Europe/Kiev' },
      ga4: { timeout: '30', retry_count: '3', retry_backoff: '2', timezone: 'UTC' },
      redmine: { timeout: '30', retry: '3', timezone: 'UTC' },
      youtrack: { timeout: '30', retry: '3', timezone: 'UTC' },
      youtrack_progress: { timeout: '30', retry: '3', timezone: 'Europe/Kyiv', max_issues: '60' },
    };

    for (const [key, value] of Object.entries(defaultSettings[src.type] || {})) {
      await prisma.sourceSetting.upsert({
        where: { sourceId_key: { sourceId: source.id, key } },
        create: { sourceId: source.id, key, value },
        update: {},
      });
    }

    // Default prompt templates
    const prompts: Record<string, { system: string; user: string }> = {
      gto: {
        system: `Ты — аналитик туристической компании. Формируешь ежедневный отчёт по продажам из системы GTO.
Все суммы в EUR. Выручка (GMV) и прибыль считаются ТОЛЬКО по подтверждённым заказам (CNF).
Прибыль = выручка − себестоимость.

АБСОЛЮТНЫЕ ПРАВИЛА ТОЧНОСТИ (нарушение недопустимо):
  — Все числа (заявки, туристы, суммы EUR) — ПЕРЕПИСЫВАЙ ДОСЛОВНО из JSON. Никогда не пересчитывай, не угадывай, не округляй самостоятельно до сдачи.
  — Если в JSON orders.confirmed = 47, в отчёте ровно 47. Если revenue_eur = 18450.75, в отчёте 18 451.
  — НЕ суммируй и НЕ вычисляй числа из промежуточных данных — бери финальные поля.
  — Перед выводом КАЖДОГО числа мысленно сверь его с исходным JSON.

ПРАВИЛА ФОРМАТИРОВАНИЯ ЧИСЕЛ:
  — Суммы EUR: округляй до целого, разделитель тысяч — ПРОБЕЛ: 40 773, не 40773 и не 40,773.
  — Штуки (заявки, туристы): без дробей, без разделителя если < 10 000.
  — Проценты: без дробей (13%, не 13.2%).
Отвечай ТОЛЬКО валидным JSON без markdown-блоков. Язык: РУССКИЙ.`,

        user: `Данные продаж GTO. Период отчёта: {{report_period_start}} — {{report_period_end}}.

ДАННЫЕ (все суммы в EUR):
{{normalized_metrics_json}}

СЕКЦИИ:
• section1_yesterday — заявки, созданные вчера
• section2_last_7_days — заявки за последние 7 дней
• section3_upcoming_7days — подтверждённые туры со стартом в ближайшие 7 дней
• section3_upcoming_30days — подтверждённые туры со стартом в ближайшие 30 дней
• section4_summer — подтверждённые туры июнь/июль/август (+ top_destinations_combined по всему лету)

Поля секций 1 и 2:
  orders: {total, confirmed, cancelled, pending}
  financials: {revenue_eur, profit_eur, profit_pct, avg_order_eur}
  top_destinations: [{country, flag, orders, tourists, pct}] — pct = % туристов; flag = emoji
  product_breakdown: {package: {orders, tourists}, hotel: {orders, tourists}, flight: {orders, tourists}, transfer: ..., insurance: ...}
  top_agents_by_orders: [{name, orders, tourists, revenue_eur}]
  top_suppliers_by_orders: [{name, orders, cost_eur}] — cost_eur = фактическая себестоимость услуг поставщика
  most_expensive_order: {order_id, price_eur}
  anomalies: [] — заказы с аномальной маржой или ценой

Поля секций 3 (7d и 30d):
  confirmed_orders, tourists, revenue_eur, profit_eur, profit_pct
  top_destinations: [{country, flag, tourists, pct}]

Поля секции 4 (june/july/august):
  confirmed_orders, tourists, revenue_eur, profit_eur, profit_pct
  top_destinations_combined (только в корне section4): [{country, flag, tourists, pct}]

Верни ТОЛЬКО валидный JSON:
{
  "telegram_message": "<сообщение строго по шаблону ниже>"
}

ШАБЛОН telegram_message (заполни реальными данными, соблюдай форматирование чисел):

📊 Ежедн. отчёт по продажам GTO
Период: ДД/ММ/ГГГГ

📦  Заявок: X (✅X подтв, ❌X отмен, ⚠️X pending)
Туристов: X

💶 Выручка: X EUR
Прибыль: X EUR (X%)
💼 Средний чек: X EUR

🌍 Направления: 🇪🇸Испания X зак / X тур, 🇪🇬Египет X зак / X тур, 🇬🇷Греция X зак / X тур
📦 Продукты: 🏨Пакет X зак / X тур, 🏩Отель X зак / X тур, ✈️Перелёт X зак / X тур

👥 Топ агент: Имя Агента — X зак, X тур

💎 Самый дорогой заказ: #XXXXX — X EUR

Самые популярные поставщики (себестоимость):
Поставщик1 - X заказов, X EUR
Поставщик2 - X заказов, X EUR
Поставщик3 - X заказов, X EUR

🔴 Отрицательная маржа (X заказов):
#XXXXX — GMV X EUR, себест. X EUR, маржа -X%
#XXXXX — GMV X EUR, себест. X EUR, маржа -X%
⚠️ Прочие аномалии:
#XXXXX: X EUR (в Nx выше среднего)


📊 За последние 7 дней (ДД/ММ/ГГГГ-ДД/ММ/ГГГГ)

📦  Заявок: X (✅X подтв, ❌X отмен, ⚠️X pending)
Туристов: X

💶 Выручка: X EUR
Прибыль: X EUR (X%)
💼 Средний чек: X EUR

🌍 Направления: 🇪🇸Испания X зак / X тур, 🇹🇷Турция X зак / X тур, 🇪🇬Египет X зак / X тур
📦 Продукты: 🏨Пакет X зак / X тур, 🏩Отель X зак / X тур, ✈️Перелёт X зак / X тур

👥 Топ агент: Имя Агента — X зак, X тур

💎 Самый дорогой заказ: #XXXXX — X EUR

Самые популярные поставщики (себестоимость):
Поставщик1 - X заказов, X EUR
Поставщик2 - X заказов, X EUR
Поставщик3 - X заказов, X EUR

🔴 Отрицательная маржа (X заказов):
#XXXXX — GMV X EUR, себест. X EUR, маржа -X%
#XXXXX — GMV X EUR, себест. X EUR, маржа -X%
⚠️ Прочие аномалии:
#XXXXX: X EUR (в Nx выше среднего)


🔮 Старт Ближ. 7 дней: X заказов, X туристов, GMV: X EUR, Gross profit: X EUR (X%)
Самые популярные направления:
🇪🇬Египет - X туристов (X%)
🇪🇸Испания - X туристов (X%)
🇮🇹Италия - X туристов (X%)

Старт ближ. 30 дней: X заказов, X туристов, GMV: X EUR, Gross profit: X EUR (X%)
🇪🇬Египет - X туристов (X%)
🇪🇸Испания - X туристов (X%)
🇮🇹Италия - X туристов (X%)


☀️ Лето:
Июнь: X зак / X туристов / GMV: X EUR / Gross profit: X EUR (X%)
Июль: X зак / X туристов / GMV: X EUR / Gross profit: X EUR (X%)
Август: X зак / X туристов / GMV: X EUR / Gross profit: X EUR (X%)

Самые популярные направления:
🇪🇸Испания - X туристов (X%)
🇬🇷Греция - X туристов (X%)
🇹🇷Турция - X туристов (X%)

ИСТОЧНИК ДАННЫХ:
- section1_yesterday: period.from = дата вчерашнего дня (только 1 день). Используй orders.total, orders.confirmed, orders.cancelled, orders.pending — ДОСЛОВНО.
- section2_last_7_days: аналогично, за 7 дней.
- section3_upcoming_7days / section3_upcoming_30days: confirmed_orders, tourists, revenue_eur, profit_eur, profit_pct.
- section4_summer: june/july/august с confirmed_orders, tourists; top_destinations_combined — суммарно по всему лету.

ПРАВИЛА ПОДСТАНОВКИ (выполнять строго):
- Заявки вчера: section1_yesterday.orders.confirmed / .cancelled / .pending / .total
- Туристы вчера: section1_yesterday.tourists
- Выручка вчера: section1_yesterday.financials.revenue_eur (округлить до целого EUR)
- Прибыль вчера: section1_yesterday.financials.profit_eur (округлить) и .profit_pct
- Средний чек: section1_yesterday.financials.avg_order_eur
- Направления: section1_yesterday.top_destinations[0..2] → country + flag + orders + tourists
- Продукты: section1_yesterday.product_breakdown (package, hotel, flight)
- Топ агент: section1_yesterday.top_agents_by_orders[0]
- Самый дорогой: section1_yesterday.most_expensive_order → order_id и price_eur
- Топ поставщики: section1_yesterday.top_suppliers_by_orders[0..2]
- Аномалии (отрицательная маржа): section1_yesterday.negative_margin_orders (все записи) + .negative_margin_count
- Прочие аномалии: section1_yesterday.anomalies (все записи)
- Аналогично для section2 (7 дней) — ТОЛЬКО из этой секции, ничего не пересчитывай.

ФОРМАТИРОВАНИЕ:
- Дату: ДД/ММ/ГГГГ из поля period.from.
- EUR суммы: Math.round(value), разделитель тысяч ПРОБЕЛ.
- Штуки: целые числа, без разделителя если < 10000.
- Направления "🌍": топ-3, формат "🏳Страна X зак / X тур" (orders и tourists).
- Продукты 📦: emoji 🏨 Пакет, 🏩 Отель, ✈️ Перелёт; показывай orders и tourists.
- Направления в "🔮" и "☀️": каждое на новой строке, с % туристов и emoji флага.
- profit_pct отрицательный — выводить как есть (-15%).
- АНОМАЛИИ — выводить ПОСЛЕ блока поставщиков в каждом дневном разделе:
  • Если negative_margin_count > 0: блок "🔴 Отрицательная маржа (N заказов):" — каждый заказ на отдельной строке:
    "#XXXXXX — GMV X EUR, себест. X EUR, маржа X%"
    Выводить ВСЕ заказы из negative_margin_orders (не обрезать), отсортированы от худшей маржи к лучшей.
  • Если в anomalies есть записи: блок "⚠️ Прочие аномалии:" — каждая запись на отдельной строке.
  • Если negative_margin_count = 0 И anomalies пуст — блоки аномалий не выводить.
- data_coverage: если detail_coverage_pct < 100, добавь в конец отчёта строку "⚠️ Неполные данные: {note}".`,
      },
      gto_comments: {
        system: `Ты — аналитик туристической компании. Твоя задача — анализировать комментарии менеджеров и агентов к заявкам в системе GTO по всем статусам (подтверждённые, отменённые, на согласовании, в ожидании) и выявлять основные темы и проблемы.

Комментарии написаны на украинском и русском языке. Анализируй и резюмируй на РУССКОМ языке.

ПРАВИЛА:
- Игнорируй автоматически сгенерированные сообщения об оплате ("Повна оплата... має бути здійснена...").
- Сосредоточься на содержательных комментариях: запросы, проблемы, жалобы, причины отмен, этапы согласования.
- Группируй похожие комментарии в темы по статусам.
- Для urgent-комментариев уделяй особое внимание.
- Отвечай ТОЛЬКО валидным JSON без markdown-блоков.`,

        user: `Данные комментариев к заявкам GTO по всем статусам. Период: {{report_period_start}} — {{report_period_end}}.

ДАННЫЕ:
{{normalized_metrics_json}}

Структура данных (2 периода — today, yesterday):
Каждый период содержит:
- stats: {cnf_orders, cnf_with_comments, cnx_orders, cnx_with_comments, orq_orders, orq_with_comments, pen_orders, pen_with_comments}
- cnf_comments: тексты комментариев к подтверждённым (CNF) заявкам
- cnx_comments: тексты комментариев к отменённым (CNX) заявкам
- orq_comments: тексты комментариев к запросам/предложениям (ORQ)
- pen_comments: тексты комментариев к заявкам в ожидании (PEN)
- urgent_comments: [{orderId, status, text}] срочные

СТАТУСЫ:
- CNF: Confirmed (подтверждённые)
- CNX: Cancelled (отменённые)
- ORQ: On Request/Quote (на согласовании)
- PEN: Pending (в ожидании)

Проанализируй комментарии и верни ТОЛЬКО валидный JSON:
{
  "telegram_message": "<сообщение строго по шаблону ниже>"
}

ШАБЛОН telegram_message:

💬 Анализ комментариев к заявкам GTO

📅 Сегодня (ДД/ММ/ГГГГ)
✅ Подтверждённые CNF (X заявок):
• Тема 1: описание (X)
• Тема 2: описание (X)
[или "(нет данных)"]

❌ Отменённые CNX (X заявок):
• Причина 1: описание (X)
• Причина 2: описание (X)
[или "(нет данных)"]

📋 На согласовании ORQ (X заявок):
• Стадия/проблема 1: описание (X)
[или "(нет данных)"]

⏳ В ожидании PEN (X заявок):
• Проблема 1: описание (X)
[или "(нет данных)"]

────────────────────────────

📅 Вчера (ДД/ММ/ГГГГ)
✅ Подтверждённые CNF (X заявок):
• Тема 1: описание (X)
• Тема 2: описание (X)
[или "(нет данных)"]

❌ Отменённые CNX (X заявок):
• Причина 1: описание (X)
• Причина 2: описание (X)
[или "(нет данных)"]

📋 На согласовании ORQ (X заявок):
• Стадия/проблема 1: описание (X)
[или "(нет данных)"]

⏳ В ожидании PEN (X заявок):
• Проблема 1: описание (X)
[или "(нет данных)"]

⚠️ Срочные (urgent) комментарии:
• #XXXXX [статус]: краткий текст
• #XXXXX [статус]: краткий текст

ВАЖНО:
- Если для статуса нет данных → напиши "(нет данных)"
- Темы CNF: запросы документов, условия, платежи, даты, переоформления
- Причины CNX: передумал, цена, нет мест, переадресован, техпроблемы, форс-мажор
- ORQ/PEN: этапы согласования, задержки, блокирующие проблемы
- Срочные — до 5 штук из обоих периодов
- Даты форматируй как ДД/ММ/ГГГГ`,
      },

      ga4: {
        system: `You are a digital marketing analyst specializing in web analytics.
Analyze the provided Google Analytics data and generate a structured JSON report.
Always respond with valid JSON only.`,
        user: `Analyze Google Analytics 4 data for {{report_period_start}} to {{report_period_end}}.

Source: {{source_name}}
Metrics:
{{normalized_metrics_json}}

Return ONLY valid JSON:
{
  "executive_summary": "2-3 sentence summary",
  "key_metrics": {
    "total_users": 0,
    "total_sessions": 0,
    "top_channel": "string",
    "bounce_rate": 0
  },
  "traffic_insights": ["insight 1"],
  "recommendations": ["rec 1"],
  "telegram_message": "Formatted Telegram message with markdown"
}`,
      },
      redmine: {
        system: `You are a project management analyst specializing in issue tracking and team productivity.
Analyze the provided Redmine data and generate a structured JSON report.
Always respond with valid JSON only.`,
        user: `Analyze Redmine project data for {{report_period_start}} to {{report_period_end}}.

Source: {{source_name}}
Data:
{{normalized_metrics_json}}

Return ONLY valid JSON:
{
  "executive_summary": "2-3 sentence summary",
  "key_metrics": {
    "issues_created": 0,
    "issues_closed": 0,
    "closure_rate": 0,
    "overdue_count": 0
  },
  "team_insights": ["insight 1"],
  "bottlenecks": ["bottleneck 1"],
  "recommendations": ["rec 1"],
  "telegram_message": "Formatted Telegram message with markdown"
}`,
      },
      youtrack: {
        system: `You are a project management analyst specializing in agile development and issue tracking.
Analyze the provided YouTrack data and generate a structured JSON report.
Focus on team velocity, bottlenecks, priority distribution, and workload balance.
Always respond with valid JSON only.`,
        user: `Analyze YouTrack issue tracker data for {{report_period_start}} to {{report_period_end}}.

Source: {{source_name}}
Data:
{{normalized_metrics_json}}

Return ONLY valid JSON:
{
  "executive_summary": "2-3 sentence summary of team performance",
  "key_metrics": {
    "issues_created": 0,
    "issues_resolved": 0,
    "issues_unresolved": 0,
    "resolution_rate": 0,
    "avg_resolution_hours": 0
  },
  "team_insights": ["insight about workload distribution", "insight about velocity"],
  "bottlenecks": ["bottleneck 1"],
  "priority_analysis": "Analysis of priority distribution and critical issues",
  "recommendations": ["rec 1", "rec 2"],
  "telegram_message": "Formatted Telegram message with markdown, max 3500 chars"
}`,
      },
      youtrack_progress: {
        system: `Ты — delivery/project analyst. На основе детерминированно собранных событий YouTrack формируешь ежедневный отчёт о прогрессе команды за вчера.
Используй ТОЛЬКО факты из JSON. Не придумывай события, статусы, комментарии или имена задач.
Сосредоточься на завершениях, движении задач, блокерах, деталях по участникам и важных сигналах из комментариев.
Отвечай ТОЛЬКО валидным JSON. Язык: РУССКИЙ.`,
        user: `Проанализируй прогресс команды в YouTrack за период {{report_period_start}} — {{report_period_end}}.

Источник: {{source_name}}
Нормализованные данные:
{{normalized_metrics_json}}

Правила:
- completed_yesterday: только задачи, где есть явный переход в финальный статус.
- progressed_yesterday: задачи, где были переходы статусов без завершения.
- blocked_or_stalled: задачи с признаками блокировки из статуса или комментариев.
- notable_comments: краткие, но важные комментарии без длинных цитат.
- people_activity: покажи по людям, кто что сделал за день. Для каждого человека перечисли 1-3 самых важных действия.
- main_problems: это должен быть список конкретных проблем с деталями: по какой задаче, что именно сломано/зависло, кто упоминал проблему, что сейчас мешает.
- Не дублируй одну и ту же задачу в нескольких списках без необходимости.
- telegram_message должен быть детальным, но компактным и пригодным для отправки в Telegram. Главное: кто что сделал, что реально сдвинулось, и в чём суть основных проблем.
- Если переход статуса не выглядит как завершение, НЕ записывай его в completed_yesterday.
- Если в комментарии есть намёк на проблему бекенда, зависимость, ожидание, ручную проверку, обучение клиента или необходимость встречи, это кандидат в main_problems или team_signals.

Верни ТОЛЬКО валидный JSON:
{
  "executive_summary": "2-3 предложения о прогрессе команды за вчера",
  "key_metrics": {
    "issues_touched": 0,
    "status_changes_count": 0,
    "comments_count": 0,
    "completed_count": 0,
    "reopened_count": 0,
    "blocked_count": 0
  },
  "completed_yesterday": ["KEY-1 — что завершили"],
  "progressed_yesterday": ["KEY-2 — какое движение произошло"],
  "blocked_or_stalled": ["KEY-3 — что мешает"],
  "notable_comments": ["KEY-4 — краткий смысл комментария"],
  "people_activity": [
    {
      "person": "Имя",
      "summary": "Коротко что делал человек за день",
      "actions": ["KEY-1 — действие", "KEY-2 — комментарий/апдейт"]
    }
  ],
  "main_problems": [
    {
      "issue": "KEY-1",
      "title": "Короткое название проблемы",
      "details": "Что именно не так",
      "owner_or_author": "Кто подсветил или на чьей стороне проблема",
      "next_step": "Что логично сделать дальше"
    }
  ],
  "team_signals": ["сигнал 1", "сигнал 2"],
  "recommendations": ["рекомендация 1", "рекомендация 2"],
  "telegram_message": "Markdown-отчёт для Telegram, максимум 3500 символов, обязательно со структурой: 1) краткий итог, 2) кто что сделал, 3) что сдвинулось по задачам, 4) основные проблемы с деталями, 5) следующие шаги"
}`,
      },
    };

    const promptData = prompts[src.type];
    if (promptData) {
      const template = await prisma.promptTemplate.upsert({
        where: { sourceId: source.id },
        create: { sourceId: source.id, name: `${src.name} Analysis Prompt`, description: `Default analysis prompt for ${src.name}` },
        update: {},
      });

      // Upsert seed version (v1) — always keep it up to date with latest defaults.
      // Users can create their own versions (v2, v3...) via admin panel without losing changes,
      // because the admin panel creates new versions rather than modifying v1.
      const version = await prisma.promptVersion.upsert({
        where: { templateId_versionNumber: { templateId: template.id, versionNumber: 1 } },
        create: {
          templateId: template.id,
          versionNumber: 1,
          systemPrompt: promptData.system,
          userPrompt: promptData.user,
          variables: ['report_period_start', 'report_period_end', 'source_name', 'normalized_metrics_json'],
          isActive: true,
        },
        update: {
          systemPrompt: promptData.system,
          userPrompt: promptData.user,
        },
      });
      // Always keep active version pointing to v1 (seed version).
      // Seed prompt is the canonical source of truth — deploy updates always take effect.
      // Custom versions created in admin panel remain available but v1 is always active.
      await prisma.promptTemplate.update({
        where: { id: template.id },
        data: { activeVersionId: version.id },
      });
    }
  }

  const [users, allSources] = await Promise.all([
    prisma.user.findMany({ select: { id: true } }),
    prisma.dataSource.findMany({ select: { id: true } }),
  ]);

  for (const user of users) {
    for (const source of allSources) {
      await prisma.userReportPreference.upsert({
        where: { userId_sourceId: { userId: user.id, sourceId: source.id } },
        create: { userId: user.id, sourceId: source.id, reportsEnabled: true },
        update: {},
      });
    }
  }

  // System settings
  const settings = [
    { key: 'llm.api_key', value: '', description: 'OpenAI API Key (from platform.openai.com)' },
    { key: 'llm.default_model', value: 'gpt-4o-mini', description: 'Default ChatGPT model' },
    { key: 'llm.fallback_model', value: 'gpt-4o-mini', description: 'Fallback model if primary fails' },
    { key: 'llm.max_tokens', value: '4096', description: 'Max tokens per LLM completion' },
    { key: 'llm.temperature', value: '0.3', description: 'LLM temperature' },
    { key: 'llm.max_cost_per_run_usd', value: '5.00', description: 'Cost cap per report run' },
    { key: 'scheduler.gto_cron', value: '0 8 * * *', description: 'GTO daily cron' },
    { key: 'scheduler.ga4_cron', value: '0 8 * * *', description: 'GA4 daily cron' },
    { key: 'scheduler.redmine_cron', value: '0 8 * * *', description: 'Redmine daily cron' },
    { key: 'scheduler.youtrack_cron', value: '0 8 * * *', description: 'YouTrack daily cron' },
    { key: 'telegram.bot_token', value: '', description: 'Telegram Bot Token from @BotFather' },
    { key: 'telegram.admin_chat_id', value: '', description: 'Telegram Chat ID for admin notifications' },
    { key: 'gto.v3_base_url', value: 'https://api.gto.ua/api/v3', description: 'GTO v3 API base URL for currency rates and static data' },
    { key: 'currency.base', value: 'EUR', description: 'Base currency for all analytics (all amounts converted to this currency)' },
  ];

  for (const s of settings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      create: s,
      update: {},
    });
  }

  console.log('Seed complete!');
  console.log(`Admin login: admin@analytics.local / ${adminPassword}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
