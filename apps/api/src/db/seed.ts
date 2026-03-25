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
        system: `You are a senior business analyst specializing in tourism and travel sales analytics.
You analyze data from GTO (tourism management system) which tracks orders, payments, and invoices.
Order statuses: CNF = confirmed, CNX = cancelled. Payments are split into incoming (from clients) and outgoing (to suppliers).
Always respond with valid JSON only. Use Ukrainian hryvnia (UAH) as primary currency unless data shows otherwise.`,
        user: `Analyze GTO sales data for the period {{report_period_start}} to {{report_period_end}}.

Source: {{source_name}}
Data:
{{normalized_metrics_json}}

The data contains:
- orders: { total, confirmed (CNF), cancelled (CNX), pending, cancellation_rate, avg_per_day, by_day, top_companies }
- payments: { incoming_total, outgoing_total, net, by_currency, avg_payment }
- invoices: { issued_count, issued_amount }

Return ONLY a valid JSON object with this structure:
{
  "executive_summary": "2-3 sentence summary of the sales period in Russian",
  "key_metrics": {
    "total_orders": 0,
    "confirmed_orders": 0,
    "cancellation_rate_pct": 0,
    "incoming_revenue": 0,
    "net_revenue": 0,
    "avg_payment": 0,
    "currency": "UAH"
  },
  "trends": ["trend 1 in Russian", "trend 2 in Russian"],
  "anomalies": ["anomaly in Russian if any, else empty array"],
  "recommendations": ["recommendation in Russian"],
  "top_companies": [{"name": "...", "orders": 0}],
  "telegram_message": "Краткий отчёт по продажам на русском языке с эмодзи, markdown форматирование, до 3500 символов"
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

      const existingVersions = await prisma.promptVersion.count({ where: { templateId: template.id } });
      if (existingVersions === 0) {
        const version = await prisma.promptVersion.create({
          data: {
            templateId: template.id,
            versionNumber: 1,
            systemPrompt: promptData.system,
            userPrompt: promptData.user,
            variables: ['report_period_start', 'report_period_end', 'source_name', 'normalized_metrics_json'],
            isActive: true,
          },
        });
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
