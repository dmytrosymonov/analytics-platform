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
  const sources = [
    { name: 'GTO Sales API', type: 'gto' as const, description: 'GTO sales, orders, payments analytics' },
    { name: 'Google Analytics 4', type: 'ga4' as const, description: 'Web traffic and user behavior analytics' },
    { name: 'Redmine', type: 'redmine' as const, description: 'Project management and issue tracking analytics' },
    { name: 'YouTrack', type: 'youtrack' as const, description: 'YouTrack issue tracker and project analytics' },
    { name: 'Fireflies.ai', type: 'fireflies' as const, description: 'Meeting transcripts, action items, and conversation analytics' },
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
      fireflies: [
        { name: 'Daily Meetings Report', description: 'Meeting activity for yesterday',       cron: '0 8 * * *',   periodType: 'daily'   },
        { name: 'Weekly Meetings Summary', description: 'Meeting analytics for the past week', cron: '0 9 * * 1', periodType: 'weekly'  },
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
      ga4: { timeout: '30', retry_count: '3', retry_backoff: '2', timezone: 'UTC' },
      redmine: { timeout: '30', retry: '3', timezone: 'UTC' },
      youtrack: { timeout: '30', retry: '3', timezone: 'UTC' },
      fireflies: { timeout: '30', timezone: 'UTC' },
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
        system: `Ты — старший аналитик туристической компании. Анализируешь данные продаж из системы GTO.
Все суммы в EUR. Выручка и прибыль считаются ТОЛЬКО по подтверждённым заказам (CNF). Отменённые (CNX) в финансах не учитываются.
Продукты: package = тур (отель + перелёт вместе), hotel = только отель, flight = только перелёт, transfer = трансфер, insurance = страховка (доп. услуга).
Статусы: CNF = подтверждён, CNX = отменён.
Прибыль = выручка − себестоимость (price_buy суммарно по всем услугам и отелям заказа).
Отвечай ТОЛЬКО валидным JSON без markdown-блоков и пояснений. Язык отчёта: РУССКИЙ.`,
        user: `Анализируй данные продаж GTO за {{report_period_start}} — {{report_period_end}}.
Источник: {{source_name}}

ДАННЫЕ (все суммы в EUR):
{{normalized_metrics_json}}

Данные содержат 4 секции:

СЕКЦИЯ 1 — section1_yesterday: заявки, созданные вчера
СЕКЦИЯ 2 — section2_last_7_days: заявки, созданные за последние 7 дней (с полем vs_prev_7_days для сравнения)
СЕКЦИЯ 3 — section3_upcoming_tours: подтверждённые туры со стартом в ближайшие 7 дней (с полем vs_prev_window)
СЕКЦИЯ 4 — section4_summer: подтверждённые туры со стартом в июне/июле/августе (по каждому месяцу отдельно)

Поля в секциях 1 и 2:
- orders: {total, confirmed, cancelled, pending, cancellation_rate_pct}
- tourists: количество туристов (только по подтверждённым)
- financials: {revenue_eur, cost_eur, profit_eur, profit_pct, avg_order_eur} — только CNF
- top_destinations: [{country, orders}] — топ-8 направлений
- product_breakdown: {package, hotel, flight, transfer, other, insurance}
- top_agents_by_orders / top_agents_by_revenue: [{name, orders, revenue_eur}]
- top_suppliers_by_orders / top_suppliers_by_revenue: [{name, orders, revenue_eur}]
- most_expensive_order: {order_id, price_eur}
- most_profitable_abs: {order_id, profit_eur}
- most_profitable_rel: {order_id, profit_pct}
- anomalies: [строки с аномалиями]
- vs_prev_7_days (только секция 2): {prev_orders_confirmed, prev_revenue_eur, prev_profit_eur, prev_tourists, orders_confirmed_delta, revenue_eur_delta, revenue_eur_delta_pct, profit_eur_delta, tourists_delta}

Поля в секции 3 (upcoming):
- confirmed_orders, tourists, revenue_eur, cost_eur, profit_eur, profit_pct
- top_destinations, product_breakdown, top_agents
- vs_prev_window: {prev_orders, prev_tourists, prev_revenue_eur, orders_delta, tourists_delta, revenue_eur_delta}

Поля в секции 4 (каждый месяц: june, july, august):
- confirmed_orders, tourists, revenue_eur, cost_eur, profit_eur, profit_pct
- top_destinations: [{country, orders}]
- product_breakdown: {package, hotel, flight, transfer, other, insurance}
- top_agents: [{name, orders, revenue_eur}]

Верни ТОЛЬКО валидный JSON строго в этой структуре:
{
  "yesterday": {
    "summary": "1-2 предложения об итогах вчера",
    "orders_total": 0, "orders_confirmed": 0, "orders_cancelled": 0, "cancellation_rate_pct": 0,
    "tourists": 0,
    "revenue_eur": 0, "cost_eur": 0, "profit_eur": 0, "profit_pct": 0, "avg_order_eur": 0,
    "top_destinations": [{"country": "", "orders": 0}],
    "product_breakdown": {"package": 0, "hotel": 0, "flight": 0, "transfer": 0, "insurance": 0},
    "top_agents": [{"name": "", "orders": 0, "revenue_eur": 0}],
    "top_suppliers_by_orders": [{"name": "", "orders": 0}],
    "top_suppliers_by_revenue": [{"name": "", "revenue_eur": 0}],
    "most_expensive_order": {"order_id": "", "price_eur": 0},
    "most_profitable_abs": {"order_id": "", "profit_eur": 0},
    "most_profitable_rel": {"order_id": "", "profit_pct": 0},
    "anomalies": []
  },
  "last_7_days": {
    "summary": "1-2 предложения о тренде за 7 дней и сравнение с предыдущей неделей",
    "orders_total": 0, "orders_confirmed": 0, "orders_cancelled": 0, "cancellation_rate_pct": 0,
    "tourists": 0,
    "revenue_eur": 0, "cost_eur": 0, "profit_eur": 0, "profit_pct": 0, "avg_order_eur": 0,
    "vs_prev_week": {
      "revenue_eur_delta": 0, "revenue_eur_delta_pct": 0,
      "profit_eur_delta": 0, "orders_confirmed_delta": 0, "tourists_delta": 0,
      "trend": "рост/снижение/без изменений"
    },
    "top_destinations": [{"country": "", "orders": 0}],
    "product_breakdown": {"package": 0, "hotel": 0, "flight": 0, "transfer": 0, "insurance": 0},
    "top_agents": [{"name": "", "orders": 0, "revenue_eur": 0}],
    "top_suppliers_by_orders": [{"name": "", "orders": 0}],
    "top_suppliers_by_revenue": [{"name": "", "revenue_eur": 0}],
    "most_expensive_order": {"order_id": "", "price_eur": 0},
    "most_profitable_abs": {"order_id": "", "profit_eur": 0},
    "most_profitable_rel": {"order_id": "", "profit_pct": 0},
    "anomalies": []
  },
  "upcoming_7_days": {
    "summary": "что предстоит в ближайшую неделю, сравнение с прошлым окном",
    "confirmed_orders": 0, "tourists": 0,
    "revenue_eur": 0, "profit_eur": 0, "profit_pct": 0,
    "vs_prev_window": {
      "orders_delta": 0, "tourists_delta": 0, "revenue_eur_delta": 0, "trend": "рост/снижение"
    },
    "top_destinations": [{"country": "", "orders": 0}],
    "product_breakdown": {"package": 0, "hotel": 0, "flight": 0, "transfer": 0}
  },
  "summer": {
    "june": {
      "orders": 0, "tourists": 0,
      "revenue_eur": 0, "profit_eur": 0, "profit_pct": 0,
      "top_destinations": [{"country": "", "orders": 0}],
      "product_breakdown": {"package": 0, "hotel": 0, "flight": 0, "transfer": 0, "insurance": 0},
      "top_agents": [{"name": "", "orders": 0}]
    },
    "july": {
      "orders": 0, "tourists": 0,
      "revenue_eur": 0, "profit_eur": 0, "profit_pct": 0,
      "top_destinations": [{"country": "", "orders": 0}],
      "product_breakdown": {"package": 0, "hotel": 0, "flight": 0, "transfer": 0, "insurance": 0},
      "top_agents": [{"name": "", "orders": 0}]
    },
    "august": {
      "orders": 0, "tourists": 0,
      "revenue_eur": 0, "profit_eur": 0, "profit_pct": 0,
      "top_destinations": [{"country": "", "orders": 0}],
      "product_breakdown": {"package": 0, "hotel": 0, "flight": 0, "transfer": 0, "insurance": 0},
      "top_agents": [{"name": "", "orders": 0}]
    },
    "summary": "1-2 предложения о летней загрузке и тенденциях"
  },
  "recommendations": ["конкретное действие 1", "конкретное действие 2", "конкретное действие 3"],
  "telegram_message": "📊 *Ежедневный отчёт GTO* | ДД.ММ.ГГГГ\\n\\n━━━━━━━━━━━━━━━\\n📅 *ВЧЕРА*\\n━━━━━━━━━━━━━━━\\nЗаявок: X (✅ X подтв | ❌ X отмен | X% отмен)\\nТуристов: X\\n💶 Выручка: X EUR | Себест: X EUR\\n💰 Прибыль: X EUR (X%)\\nСредний чек: X EUR\\n\\n🌍 Направления: Страна1(N), Страна2(N)\\n📦 Пакет:X Отель:X Перелёт:X Страх:X\\n🏆 Топ агент: Агент (X зак, X EUR)\\n🏭 Топ поставщик: Поставщик (X зак)\\n💎 Дорогой: #XXXXX — X EUR\\n💰 Прибыльный: #XXXXX — X EUR (X%)\\n⚠️ Аномалии: текст или нет\\n\\n━━━━━━━━━━━━━━━\\n📅 *7 ДНЕЙ*\\n━━━━━━━━━━━━━━━\\nЗаявок: X (✅ X подтв | ❌ X отмен)\\nТуристов: X\\n💶 Выручка: X EUR (▲/▼X% vs пред. нед.)\\n💰 Прибыль: X EUR (X%) (▲/▼X%)\\n\\n🌍 Топ: Страна1(N), Страна2(N), Страна3(N)\\n📦 Пакет:X Отель:X Перелёт:X\\n🏆 Агенты: Агент1(X), Агент2(X)\\n🏭 Поставщики: Пост1(X), Пост2(X)\\n\\n━━━━━━━━━━━━━━━\\n🔮 *БЛИЖАЙШИЕ 7 ДНЕЙ*\\n━━━━━━━━━━━━━━━\\nТуров: X | Туристов: X\\n💶 X EUR | Прибыль: X EUR (X%)\\n🌍 Страна1(N), Страна2(N)\\nvs пред. окно: ▲/▼X туров, ▲/▼X EUR\\n\\n━━━━━━━━━━━━━━━\\n☀️ *ЛЕТО YYYY*\\n━━━━━━━━━━━━━━━\\nИюнь: X зак | X тур | X EUR | X EUR пр. (X%)\\nИюль: X зак | X тур | X EUR | X EUR пр. (X%)\\nАвгуст: X зак | X тур | X EUR | X EUR пр. (X%)\\n\\n✅ *Рекомендации:*\\n• действие 1\\n• действие 2"
}`,
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
      fireflies: {
        system: `You are a business analyst specializing in meeting effectiveness and organizational communication.
Analyze the provided Fireflies.ai meeting data and generate a structured JSON report.
Focus on meeting load, key topics, action items, and team collaboration patterns.
Always respond with valid JSON only.`,
        user: `Analyze Fireflies.ai meeting data for {{report_period_start}} to {{report_period_end}}.

Source: {{source_name}}
Data:
{{normalized_metrics_json}}

Return ONLY valid JSON:
{
  "executive_summary": "2-3 sentence summary of meeting activity",
  "key_metrics": {
    "total_meetings": 0,
    "total_hours": 0,
    "avg_duration_minutes": 0,
    "total_action_items": 0
  },
  "meeting_insights": ["insight about meeting patterns", "insight about participation"],
  "top_topics": ["topic 1", "topic 2"],
  "action_items_summary": "Summary of key action items and commitments",
  "recommendations": ["rec 1", "rec 2"],
  "telegram_message": "Formatted Telegram message with markdown, max 3500 chars"
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
      // Set v1 as active only if no other version is currently active
      const currentTemplate = await prisma.promptTemplate.findUnique({ where: { id: template.id } });
      if (!currentTemplate?.activeVersionId) {
        await prisma.promptTemplate.update({
          where: { id: template.id },
          data: { activeVersionId: version.id },
        });
      }
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
    { key: 'scheduler.fireflies_cron', value: '0 8 * * *', description: 'Fireflies daily cron' },
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
