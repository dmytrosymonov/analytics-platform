type IssueLike = {
  key?: string;
  summary?: string;
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

export function enrichYouTrackProgressTelegramMessage(message: string, normalizedData: any): string {
  if (!message) return message;

  const issueTitles = buildIssueTitleMap(normalizedData);
  if (issueTitles.size === 0) return message;

  return message.replace(/\b([A-Za-z][A-Za-z0-9_]*-\d+)\b(?!\s*[—-])/g, (match, key: string) => {
    const summary = issueTitles.get(key);
    if (!summary) return match;
    return `${key} — ${summary}`;
  });
}
