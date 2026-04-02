type IssueLike = {
  key?: string;
  summary?: string;
};

type PeopleActivityItem = {
  person?: string;
  summary?: string;
  tasks?: string[];
  actions?: string[];
};

type MainProblemItem = {
  issue?: string;
  issue_title?: string;
  title?: string;
  details?: string;
  owner_or_author?: string;
  next_step?: string;
};

function buildIssueTitleMap(normalizedData: any): Map<string, string> {
  const metrics = normalizedData?.metrics ?? normalizedData;
  const issues = Array.isArray(metrics?.issues) ? (metrics.issues as IssueLike[]) : [];
  const map = new Map<string, string>();

  for (const issue of issues) {
    const key = typeof issue?.key === 'string' ? issue.key.trim() : '';
    const summary = typeof issue?.summary === 'string' ? issue.summary.trim() : '';
    if (!key || !summary) continue;
    map.set(key, summary);
  }

  return map;
}

function extractIssueKey(text: string): string | null {
  return text.match(/\b([A-Za-z][A-Za-z0-9_]*-\d+)\b/u)?.[1] ?? null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function ensureTaskLabel(task: string, issueTitles: Map<string, string>): string {
  const normalized = normalizeWhitespace(task);
  const key = extractIssueKey(normalized);
  if (!key) return normalized;
  if (normalized.includes('—')) return normalized;
  const summary = issueTitles.get(key);
  return summary ? `${key} — ${summary}` : normalized;
}

function stripLeadingIssueKey(text: string, key: string): string {
  return normalizeWhitespace(text.replace(new RegExp(`^${key}\\s*[—-]?\\s*`, 'u'), ''));
}

function formatPeopleActivity(peopleActivity: unknown, issueTitles: Map<string, string>): string | null {
  if (!Array.isArray(peopleActivity) || peopleActivity.length === 0) return null;

  const sections = (peopleActivity as PeopleActivityItem[])
    .map((personItem) => {
      const person = normalizeWhitespace(personItem.person || '');
      if (!person) return null;

      const taskLabels = new Map<string, string>();
      for (const rawTask of personItem.tasks || []) {
        const task = ensureTaskLabel(String(rawTask), issueTitles);
        const key = extractIssueKey(task);
        if (key) taskLabels.set(key, task);
      }

      const taskDetails = new Map<string, string[]>();
      for (const rawAction of personItem.actions || []) {
        const action = normalizeWhitespace(String(rawAction));
        if (!action) continue;
        const key = extractIssueKey(action);
        if (!key) continue;
        const details = stripLeadingIssueKey(action, key);
        if (!taskDetails.has(key)) taskDetails.set(key, []);
        if (details) taskDetails.get(key)!.push(details);
      }

      const orderedKeys = Array.from(new Set([
        ...taskLabels.keys(),
        ...taskDetails.keys(),
      ]));

      const lines = orderedKeys.map((key) => {
        const taskLabel = taskLabels.get(key) || ensureTaskLabel(key, issueTitles);
        const details = taskDetails.get(key) || [];
        const detailText = details.length > 0 ? details.join('; ') : normalizeWhitespace(personItem.summary || '');
        return detailText ? `${taskLabel} — ${detailText}` : taskLabel;
      });

      if (lines.length === 0 && personItem.summary) {
        lines.push(normalizeWhitespace(personItem.summary));
      }

      if (lines.length === 0) return null;
      return `${person}:\n${lines.join('\n')}`;
    })
    .filter((value): value is string => Boolean(value));

  if (sections.length === 0) return null;
  return `Кто что сделал:\n${sections.join('\n\n')}`;
}

function formatMainProblems(mainProblems: unknown, issueTitles: Map<string, string>): string | null {
  if (!Array.isArray(mainProblems) || mainProblems.length === 0) return null;

  const lines = (mainProblems as MainProblemItem[])
    .map((problem) => {
      const key = normalizeWhitespace(problem.issue || '');
      const title = normalizeWhitespace(problem.issue_title || (key ? issueTitles.get(key) || '' : ''));
      const taskLabel = key ? (title ? `${key} — ${title}` : key) : normalizeWhitespace(problem.title || '');
      if (!taskLabel) return null;

      const details = normalizeWhitespace(problem.details || '');
      const owner = normalizeWhitespace(problem.owner_or_author || '');
      const nextStep = normalizeWhitespace(problem.next_step || '');

      const suffix = [
        details,
        owner ? `Ответственный/источник: ${owner}` : '',
        nextStep ? `Следующий шаг: ${nextStep}` : '',
      ].filter(Boolean).join('. ');

      return suffix ? `${taskLabel} — ${suffix}` : taskLabel;
    })
    .filter((value): value is string => Boolean(value));

  if (lines.length === 0) return null;
  return `Основные проблемы:\n${lines.join('\n')}`;
}

function replaceSection(message: string, heading: string, replacement: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\n)${escapedHeading}:?[\\s\\S]*?(?=\\n(?:[A-ZА-ЯЁ][^\\n]{0,80}:|Следующие шаги:|Риски:|Сигналы команды:|$))`, 'u');
  if (pattern.test(message)) {
    return message.replace(pattern, (_match, prefix: string) => `${prefix}${replacement}`);
  }
  return `${message.trim()}\n\n${replacement}`;
}

export function formatYouTrackProgressTelegramMessage(message: string, normalizedData: any, structuredOutput?: any): string {
  if (!message) return message;

  const issueTitles = buildIssueTitleMap(normalizedData);
  let formatted = message;

  formatted = formatted.replace(/\b([A-Za-z][A-Za-z0-9_]*-\d+)\b(?!\s*[—-])/g, (match, key: string) => {
    const summary = issueTitles.get(key);
    if (!summary) return match;
    return `${key} — ${summary}`;
  });

  const peopleSection = formatPeopleActivity(structuredOutput?.people_activity, issueTitles);
  if (peopleSection) {
    formatted = replaceSection(formatted, 'Кто что сделал', peopleSection);
  }

  const problemsSection = formatMainProblems(structuredOutput?.main_problems, issueTitles);
  if (problemsSection) {
    formatted = replaceSection(formatted, 'Основные проблемы', problemsSection);
  }

  return formatted;
}
