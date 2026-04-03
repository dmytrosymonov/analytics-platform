import { ConnectorResult, SourceConnector } from '../base/connector.interface';
import { createHttpClient } from '../../lib/http';

const RESPONDER_USERNAMES = ['i.yarovyi', 'tina'];
const PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 8;

type Period = { start: Date; end: Date };

type RedmineRef = {
  id?: number;
  name?: string;
  login?: string;
  firstname?: string;
  lastname?: string;
  mail?: string;
};

type RedmineJournal = {
  id?: number;
  user?: RedmineRef;
  created_on?: string;
  notes?: string;
  private_notes?: boolean;
  details?: Array<Record<string, unknown>>;
};

type RedmineIssue = {
  id: number;
  subject?: string;
  description?: string;
  project?: RedmineRef;
  status?: RedmineRef & { is_closed?: boolean };
  author?: RedmineRef;
  assigned_to?: RedmineRef;
  priority?: RedmineRef;
  created_on?: string;
  updated_on?: string;
  journals?: RedmineJournal[];
};

type ProjectAccumulator = {
  project_id: number | null;
  project_name: string;
  metrics: {
    created_count: number;
    answered_count: number;
    closed_count: number;
    commented_count: number;
    avg_first_response_minutes: number | null;
    response_sla_issue_count: number;
  };
  issues: NormalizedIssue[];
  created_issues: NormalizedIssue[];
  answered_issues: NormalizedIssue[];
  closed_issues: NormalizedIssue[];
  commented_issues: NormalizedIssue[];
};

type NormalizedComment = {
  author: string;
  author_display: string;
  created_at: string;
  public: true;
  summary: string;
  text_preview: string;
};

type NormalizedIssue = {
  id: number;
  subject: string;
  description_summary: string;
  status: string;
  project_id: number | null;
  project_name: string;
  author: string;
  assignee: string | null;
  priority: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  url: string;
  first_response_at: string | null;
  first_response_by: string | null;
  first_response_by_display: string | null;
  time_to_first_response_minutes: number | null;
  answered_in_period: boolean;
  closed_in_period: boolean;
  created_in_period: boolean;
  new_comments_count: number;
  new_comments: NormalizedComment[];
};

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '');
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinPeriod(date: Date | null, period: Period) {
  return !!date && date >= period.start && date < period.end;
}

function stripMarkup(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortenText(value: string | null | undefined, maxLength: number) {
  const clean = stripMarkup(value || '');
  if (!clean) return '';
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function uniqueById<T extends { id: number }>(items: T[]) {
  const map = new Map<number, T>();
  for (const item of items) map.set(item.id, item);
  return [...map.values()];
}

function buildIdentitySet(ref?: RedmineRef | null) {
  const values = [
    ref?.login,
    ref?.name,
    [ref?.firstname, ref?.lastname].filter(Boolean).join(' '),
    ref?.mail?.split('@')[0],
  ]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  return new Set(values);
}

function getPrimaryIdentity(ref?: RedmineRef | null) {
  const identities = [...buildIdentitySet(ref)];
  return identities[0] || 'unknown';
}

function getDisplayName(ref?: RedmineRef | null) {
  return String(ref?.name || [ref?.firstname, ref?.lastname].filter(Boolean).join(' ') || ref?.login || ref?.mail || 'Unknown').trim();
}

function isResponder(ref?: RedmineRef | null) {
  const identities = buildIdentitySet(ref);
  return RESPONDER_USERNAMES.some(username => identities.has(username.toLowerCase()));
}

function isPublicComment(journal?: RedmineJournal | null) {
  const notes = String(journal?.notes || '').trim();
  return !!notes && journal?.private_notes !== true;
}

function hasClosedStatusDetail(journal: RedmineJournal, closedStatusIds: Set<number>) {
  return (journal.details || []).some((detail) => {
    const key = String(detail['prop_key'] || detail['name'] || '').trim();
    if (key !== 'status_id') return false;
    const newValue = Number(detail['new_value'] || detail['newValue']);
    return Number.isFinite(newValue) && closedStatusIds.has(newValue);
  });
}

function toMinutes(from: Date, to: Date) {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    const resolved = await Promise.all(chunk.map(worker));
    results.push(...resolved);
  }
  return results;
}

export class RedmineConnector implements SourceConnector {
  readonly sourceType = 'redmine';

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { redmine_base_url, redmine_api_key } = credentials as any;
    if (!redmine_base_url || !redmine_api_key) return false;
    try {
      const client = createHttpClient(
        { baseURL: redmine_base_url, headers: { 'X-Redmine-API-Key': redmine_api_key }, timeout: 10000 },
        'redmine',
      );
      const resp = await client.get('/issues.json', { params: { limit: 1 } });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  async fetchData(credentials: Record<string, unknown>, settings: Record<string, string>, period: Period): Promise<ConnectorResult> {
    const { redmine_base_url, redmine_api_key, default_project_id } = credentials as any;
    const timeout = parseInt(settings['timeout'] || '30', 10) * 1000;
    const baseUrl = normalizeBaseUrl(String(redmine_base_url || ''));

    const client = createHttpClient(
      { baseURL: baseUrl, headers: { 'X-Redmine-API-Key': redmine_api_key }, timeout },
      'redmine',
    );

    const dateFrom = toDateOnly(period.start);
    const dateTo = toDateOnly(new Date(period.end.getTime() - 1));
    const baseParams: Record<string, string | number> = { limit: PAGE_SIZE };
    if (default_project_id) baseParams.project_id = default_project_id;

    try {
      const [createdIssues, updatedIssues, closedIssues, closedStatusIds] = await Promise.all([
        this.fetchIssuePages(client, { ...baseParams, created_on: `><${dateFrom}|${dateTo}`, status_id: '*' }),
        this.fetchIssuePages(client, { ...baseParams, updated_on: `><${dateFrom}|${dateTo}`, status_id: '*' }),
        this.fetchIssuePages(client, { ...baseParams, updated_on: `><${dateFrom}|${dateTo}`, status_id: 'closed' }),
        this.fetchClosedStatusIds(client),
      ]);

      const candidateIssues = uniqueById([...createdIssues, ...updatedIssues, ...closedIssues]);
      const detailedIssues = await mapWithConcurrency(candidateIssues, DETAIL_CONCURRENCY, async (issue) => {
        const response = await client.get(`/issues/${issue.id}.json`, { params: { include: 'journals' } });
        return response.data?.issue as RedmineIssue;
      });

      const closedIssueIds = new Set(closedIssues.map(issue => issue.id));
      const warnings: string[] = [];
      const projectMap = new Map<string, ProjectAccumulator>();
      let totalCreated = 0;
      let totalAnswered = 0;
      let totalClosed = 0;
      let totalCommented = 0;
      let totalSlaIssues = 0;
      let totalSlaMinutes = 0;

      for (const issue of detailedIssues) {
        if (!issue?.id) continue;

        try {
          const normalized = this.normalizeIssue(issue, baseUrl, period, closedStatusIds, closedIssueIds);
          if (!normalized) continue;

          const projectKey = String(normalized.project_id ?? normalized.project_name);
          const project = projectMap.get(projectKey) || {
            project_id: normalized.project_id,
            project_name: normalized.project_name,
            metrics: {
              created_count: 0,
              answered_count: 0,
              closed_count: 0,
              commented_count: 0,
              avg_first_response_minutes: null,
              response_sla_issue_count: 0,
            },
            issues: [],
            created_issues: [],
            answered_issues: [],
            closed_issues: [],
            commented_issues: [],
          };

          project.issues.push(normalized);

          if (normalized.created_in_period) {
            project.metrics.created_count += 1;
            project.created_issues.push(normalized);
            totalCreated += 1;
          }

          if (normalized.answered_in_period) {
            project.metrics.answered_count += 1;
            project.answered_issues.push(normalized);
            totalAnswered += 1;
          }

          if (normalized.closed_in_period) {
            project.metrics.closed_count += 1;
            project.closed_issues.push(normalized);
            totalClosed += 1;
          }

          if (normalized.new_comments_count > 0) {
            project.metrics.commented_count += 1;
            project.commented_issues.push(normalized);
            totalCommented += 1;
          }

          if (normalized.time_to_first_response_minutes !== null) {
            project.metrics.response_sla_issue_count += 1;
            totalSlaIssues += 1;
            totalSlaMinutes += normalized.time_to_first_response_minutes;
          }

          projectMap.set(projectKey, project);
        } catch (err: any) {
          warnings.push(`Issue #${issue.id}: ${err?.message || 'Failed to normalize issue'}`);
        }
      }

      const projects = [...projectMap.values()]
        .filter(project =>
          project.metrics.created_count > 0 ||
          project.metrics.answered_count > 0 ||
          project.metrics.closed_count > 0 ||
          project.metrics.commented_count > 0,
        )
        .map((project) => {
          const totalProjectSla = project.issues
            .filter(issue => issue.time_to_first_response_minutes !== null)
            .reduce((sum, issue) => sum + Number(issue.time_to_first_response_minutes || 0), 0);
          project.metrics.avg_first_response_minutes = project.metrics.response_sla_issue_count > 0
            ? Math.round(totalProjectSla / project.metrics.response_sla_issue_count)
            : null;

          const sortIssues = (items: NormalizedIssue[]) => items.sort((a, b) => {
            const aTime = new Date(a.updated_at || a.created_at || 0).getTime();
            const bTime = new Date(b.updated_at || b.created_at || 0).getTime();
            return bTime - aTime;
          });

          sortIssues(project.issues);
          sortIssues(project.created_issues);
          sortIssues(project.answered_issues);
          sortIssues(project.closed_issues);
          sortIssues(project.commented_issues);

          return project;
        })
        .sort((a, b) => a.project_name.localeCompare(b.project_name));

      return {
        success: true,
        data: {
          sourceId: 'redmine',
          sourceName: 'Redmine',
          fetchedAt: new Date().toISOString(),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          timezone: settings['timezone'] || 'UTC',
          rawSampleSize: detailedIssues.length,
          warnings: warnings.slice(0, 50),
          metrics: {
            responders: RESPONDER_USERNAMES,
            totals: {
              created_count: totalCreated,
              answered_count: totalAnswered,
              closed_count: totalClosed,
              commented_count: totalCommented,
              avg_first_response_minutes: totalSlaIssues > 0 ? Math.round(totalSlaMinutes / totalSlaIssues) : null,
              response_sla_issue_count: totalSlaIssues,
            },
            projects,
          },
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: {
          code: 'REDMINE_FETCH_FAILED',
          message: err?.message || 'Failed to fetch Redmine data',
          retryable: true,
        },
      };
    }
  }

  private async fetchIssuePages(client: ReturnType<typeof createHttpClient>, params: Record<string, string | number>) {
    const issues: RedmineIssue[] = [];
    let offset = 0;
    let totalCount = Number.POSITIVE_INFINITY;

    while (offset < totalCount) {
      const response = await client.get('/issues.json', { params: { ...params, offset } });
      const chunk = (response.data?.issues || []) as RedmineIssue[];
      totalCount = Number(response.data?.total_count || chunk.length || 0);
      issues.push(...chunk);
      offset += Number(params.limit || PAGE_SIZE);
      if (chunk.length === 0) break;
    }

    return issues;
  }

  private async fetchClosedStatusIds(client: ReturnType<typeof createHttpClient>): Promise<Set<number>> {
    try {
      const response = await client.get('/issue_statuses.json');
      const statuses = Array.isArray(response.data?.issue_statuses) ? response.data.issue_statuses : [];
      const closedStatuses = statuses
        .filter((status: any) => status?.is_closed === true)
        .map((status: any) => Number(status?.id))
        .filter((id: number) => Number.isFinite(id));
      return new Set(closedStatuses);
    } catch {
      return new Set<number>();
    }
  }

  private normalizeIssue(issue: RedmineIssue, baseUrl: string, period: Period, closedStatusIds: Set<number>, closedIssueIds: Set<number>): NormalizedIssue | null {
    const createdAt = parseDate(issue.created_on);
    const updatedAt = parseDate(issue.updated_on);
    const journals = Array.isArray(issue.journals) ? issue.journals : [];

    const publicComments = journals
      .filter(isPublicComment)
      .map((journal) => {
        const commentDate = parseDate(journal.created_on);
        return {
          journal,
          date: commentDate,
          author: getPrimaryIdentity(journal.user),
          authorDisplay: getDisplayName(journal.user),
          notes: String(journal.notes || '').trim(),
        };
      })
      .filter(comment => !!comment.date)
      .sort((a, b) => (a.date!.getTime() - b.date!.getTime()));

    const firstResponderComment = publicComments.find(comment =>
      isResponder(comment.journal.user) &&
      !!createdAt &&
      comment.date! >= createdAt,
    );

    const firstResponseMinutes = createdAt && firstResponderComment?.date
      ? toMinutes(createdAt, firstResponderComment.date)
      : null;

    const newComments = publicComments
      .filter(comment => isWithinPeriod(comment.date, period))
      .map((comment) => ({
        author: comment.author,
        author_display: comment.authorDisplay,
        created_at: comment.date!.toISOString(),
        public: true as const,
        summary: shortenText(comment.notes, 160),
        text_preview: shortenText(comment.notes, 300),
      }));

    const answeredInPeriod = publicComments.some(comment =>
      isResponder(comment.journal.user) &&
      isWithinPeriod(comment.date, period),
    );

    const closedJournal = journals
      .map((journal) => ({ journal, date: parseDate(journal.created_on) }))
      .find(({ journal, date }) => isWithinPeriod(date, period) && hasClosedStatusDetail(journal, closedStatusIds));

    const createdInPeriod = isWithinPeriod(createdAt, period);
    const closedInPeriod = !!closedJournal || (!closedStatusIds.size && closedIssueIds.has(issue.id));
    const touchedInPeriod = createdInPeriod || answeredInPeriod || closedInPeriod || newComments.length > 0;
    if (!touchedInPeriod) return null;

    return {
      id: issue.id,
      subject: String(issue.subject || `Issue #${issue.id}`),
      description_summary: shortenText(issue.description, 220) || '(no description)',
      status: String(issue.status?.name || 'Unknown'),
      project_id: issue.project?.id ?? null,
      project_name: String(issue.project?.name || 'Unknown project'),
      author: getDisplayName(issue.author),
      assignee: issue.assigned_to ? getDisplayName(issue.assigned_to) : null,
      priority: issue.priority ? getDisplayName(issue.priority) : null,
      created_at: createdAt?.toISOString() || null,
      updated_at: updatedAt?.toISOString() || null,
      closed_at: closedJournal?.date?.toISOString() || null,
      url: `${baseUrl}/issues/${issue.id}`,
      first_response_at: firstResponderComment?.date?.toISOString() || null,
      first_response_by: firstResponderComment ? getPrimaryIdentity(firstResponderComment.journal.user) : null,
      first_response_by_display: firstResponderComment ? getDisplayName(firstResponderComment.journal.user) : null,
      time_to_first_response_minutes: firstResponseMinutes,
      answered_in_period: answeredInPeriod,
      closed_in_period: closedInPeriod,
      created_in_period: createdInPeriod,
      new_comments_count: newComments.length,
      new_comments: newComments,
    };
  }
}
