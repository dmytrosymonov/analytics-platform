function formatDateRu(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

export function buildGtoCommentsPrompts(input: {
  periodStart: string;
  periodEnd: string;
  normalizedMetricsJson: string;
}) {
  const fromLabel = formatDateRu(input.periodStart);
  const toLabel = formatDateRu(input.periodEnd);

  return {
    system: `Ты — аналитик туристической компании. Анализируй комментарии менеджеров и агентов к заявкам в системе GTO по выбранному периоду и резюмируй основные темы, проблемы, причины отмен и срочные сигналы.

Комментарии могут быть на украинском и русском. Отвечай на РУССКОМ языке.

ПРАВИЛА:
- Игнорируй автоматически сгенерированные сообщения об оплате.
- Сосредоточься на содержательных комментариях.
- Группируй похожие комментарии в темы по статусам.
- Для urgent-комментариев выделяй отдельный блок.
- Отвечай ТОЛЬКО валидным JSON без markdown-блоков.`,
    user: `Данные комментариев к заявкам GTO за период ${fromLabel} — ${toLabel}.

ДАННЫЕ:
${input.normalizedMetricsJson}

Структура:
- requested_period.stats
- requested_period.cnf_comments
- requested_period.cnx_comments
- requested_period.orq_comments
- requested_period.pen_comments
- requested_period.other_comments
- requested_period.urgent_comments

СТАТУСЫ:
- CNF: Confirmed
- CNX: Cancelled
- ORQ: On Request / Quote
- PEN: Pending

Верни ТОЛЬКО валидный JSON:
{
  "telegram_message": "<сообщение>"
}

Шаблон telegram_message:

💬 Анализ комментариев к заявкам GTO
📅 Период: ${fromLabel} — ${toLabel}

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

🗂 Прочие статусы (X заявок):
• Тема 1: описание (X)
[или "(нет данных)"]

🚨 Срочные комментарии:
• #ID STATUS — краткое резюме
[или "(нет данных)"]

🧩 Общие выводы:
• Вывод 1
• Вывод 2

Счётчики X бери из фактических данных периода. Не выдумывай темы, если комментариев нет.`,
  };
}
