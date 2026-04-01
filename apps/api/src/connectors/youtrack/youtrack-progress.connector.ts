import { AxiosInstance } from 'axios';
import { ConnectorResult, SourceConnector } from '../base/connector.interface';
import { makeYouTrackClient, validateYouTrackCredentials, YouTrackCredentials } from './youtrack.shared';

type ProgressIssue = {
  id: string;
  key: string;
  summary: string;
  project: string;
  link: string;
  transitions: Array<{
    at: string;
    author: string;
    field: string;
    from: string | null;
    to: string | null;
  }>;
  comments: Array<{
    at: string;
    author: string;
    text: string;
  }>;
  flags: {
    completed: boolean;
    reopened: boolean;
    blocked: boolean;
  };
};

type ActivityItem = {
  timestamp?: number;
  author?: { login?: string; fullName?: string; name?: string };
  field?: { name?: string };
  target?: {
    id?: string;
    idReadable?: string;
    summary?: string;
    issue?: {
      id?: string;
      idReadable?: string;
      summary?: string;
      project?: { shortName?: string; name?: string };
    };
    project?: { shortName?: string; name?: string };
    text?: string | null;
  };
  added?: any[] | any;
  removed?: any[] | any;
};

export class YouTrackProgressConnector implements SourceConnector {
  readonly sourceType = 'youtrack_progress';

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    try {
      return await validateYouTrackCredentials(credentials, 10000, 'youtrack_progress');
    } catch {
      return false;
    }
  }

  async fetchData(
    credentials: Record<string, unknown>,
    settings: Record<string, string>,
    period: { start: Date; end: Date },
  ): Promise<ConnectorResult> {
    const { youtrack_base_url, youtrack_token, youtrack_project } = credentials as YouTrackCredentials;
    if (!youtrack_base_url || !youtrack_token) {
      return {
        success: false,
        error: { code: 'MISSING_CREDENTIALS', message: 'YouTrack credentials are not configured', retryable: false },
      };
    }

    const timeout = parseInt(settings['timeout'] || '30', 10) * 1000;
    const client = makeYouTrackClient(youtrack_base_url, youtrack_token, timeout, 'youtrack_progress');
    const startMs = period.start.getTime();
    const endMs = period.end.getTime();
    const issueQuery = youtrack_project ? `project: ${youtrack_project}` : undefined;

    const [fieldActivities, commentActivities] = await Promise.all([
      this.fetchActivities(client, {
        startMs,
        endMs,
        issueQuery,
        categories: ['CustomFieldCategory'],
        fields: [
          'id',
          'timestamp',
          'author(login,fullName,name)',
          'field(name)',
          'added(name,text,id,idReadable)',
          'removed(name,text,id,idReadable)',
          'target(id,idReadable,summary,project(shortName,name))',
        ].join(','),
      }),
      this.fetchActivities(client, {
        startMs,
        endMs,
        issueQuery,
        categories: ['CommentsCategory'],
        fields: [
          'id',
          'timestamp',
          'author(login,fullName,name)',
          'added(id,text,created,updated,author(login,fullName,name),issue(id,idReadable,summary,project(shortName,name)))',
          'target(id,text,issue(id,idReadable,summary,project(shortName,name)))',
        ].join(','),
      }),
    ]);

    const issues = new Map<string, ProgressIssue>();

    for (const activity of fieldActivities) {
      if ((activity.field?.name || '').toLowerCase() !== 'state') continue;

      const target = activity.target;
      const issueId = target?.id;
      const issueKey = target?.idReadable;
      if (!issueId || !issueKey) continue;

      const issue = this.getOrCreateIssue(issues, {
        issueId,
        issueKey,
        summary: target?.summary || issueKey,
        project: target?.project?.shortName || target?.project?.name || youtrack_project || 'YouTrack',
        baseUrl: youtrack_base_url,
      });

      const fromState = this.extractNamedValue(activity.removed);
      const toState = this.extractNamedValue(activity.added);
      issue.transitions.push({
        at: new Date(activity.timestamp || Date.now()).toISOString(),
        author: this.resolveAuthor(activity.author),
        field: 'State',
        from: fromState,
        to: toState,
      });

      if (toState && /done|fixed|resolved|closed|completed/i.test(toState)) issue.flags.completed = true;
      if ((fromState && /done|fixed|resolved|closed|completed/i.test(fromState)) && toState && !/done|fixed|resolved|closed|completed/i.test(toState)) {
        issue.flags.reopened = true;
      }
      if (toState && /block|blocked|waiting/i.test(toState)) issue.flags.blocked = true;
    }

    for (const activity of commentActivities) {
      const addedComments = this.asArray(activity.added);
      for (const comment of addedComments) {
        const issueRef = comment?.issue || activity.target?.issue;
        const issueId = issueRef?.id;
        const issueKey = issueRef?.idReadable;
        if (!issueId || !issueKey) continue;

        const text = this.normalizeCommentText(comment?.text || activity.target?.text);
        if (!text) continue;

        const issue = this.getOrCreateIssue(issues, {
          issueId,
          issueKey,
          summary: issueRef?.summary || issueKey,
          project: issueRef?.project?.shortName || issueRef?.project?.name || youtrack_project || 'YouTrack',
          baseUrl: youtrack_base_url,
        });

        issue.comments.push({
          at: new Date(activity.timestamp || comment?.created || Date.now()).toISOString(),
          author: this.resolveAuthor(comment?.author || activity.author),
          text,
        });

        if (/blocker|blocked|waiting|stuck|cannot|can't|dependency|depends on/i.test(text)) {
          issue.flags.blocked = true;
        }
      }
    }

    const touchedIssues = [...issues.values()]
      .filter(issue => issue.transitions.length > 0 || issue.comments.length > 0)
      .sort((a, b) => {
        const aTs = Math.max(
          ...a.transitions.map(x => new Date(x.at).getTime()),
          ...a.comments.map(x => new Date(x.at).getTime()),
          0,
        );
        const bTs = Math.max(
          ...b.transitions.map(x => new Date(x.at).getTime()),
          ...b.comments.map(x => new Date(x.at).getTime()),
          0,
        );
        return bTs - aTs;
      });
    const maxIssues = Math.max(1, parseInt(settings['max_issues'] || '60', 10));
    const issuesForPrompt = touchedIssues.slice(0, maxIssues);

    const metrics = {
      issues_touched: touchedIssues.length,
      issues_with_status_changes: touchedIssues.filter(issue => issue.transitions.length > 0).length,
      issues_with_comments: touchedIssues.filter(issue => issue.comments.length > 0).length,
      status_changes_count: touchedIssues.reduce((sum, issue) => sum + issue.transitions.length, 0),
      comments_count: touchedIssues.reduce((sum, issue) => sum + issue.comments.length, 0),
      completed_count: touchedIssues.filter(issue => issue.flags.completed).length,
      reopened_count: touchedIssues.filter(issue => issue.flags.reopened).length,
      blocked_count: touchedIssues.filter(issue => issue.flags.blocked).length,
      issues_truncated_count: Math.max(0, touchedIssues.length - issuesForPrompt.length),
      issues: issuesForPrompt,
      top_transition_authors: this.topCounts(
        touchedIssues.flatMap(issue => issue.transitions.map(transition => transition.author)),
      ),
      top_comment_authors: this.topCounts(
        touchedIssues.flatMap(issue => issue.comments.map(comment => comment.author)),
      ),
    };

    return {
      success: true,
      data: {
        sourceId: 'youtrack_progress',
        sourceName: 'YouTrack Daily Progress',
        fetchedAt: new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        timezone: settings['timezone'] || 'UTC',
        metrics,
      },
    };
  }

  private async fetchActivities(
    client: AxiosInstance,
    params: { startMs: number; endMs: number; issueQuery?: string; categories: string[]; fields: string },
  ): Promise<ActivityItem[]> {
    const all: ActivityItem[] = [];
    const top = 42;

    for (let skip = 0; skip < 5000; skip += top) {
      const resp = await client.get('/api/activities', {
        params: {
          fields: params.fields,
          categories: params.categories.join(','),
          reverse: true,
          start: String(params.startMs),
          end: String(params.endMs),
          issueQuery: params.issueQuery,
          $top: top,
          $skip: skip,
        },
      });

      const chunk = Array.isArray(resp.data) ? resp.data as ActivityItem[] : [];
      all.push(...chunk);
      if (chunk.length < top) break;
    }

    return all;
  }

  private getOrCreateIssue(
    issues: Map<string, ProgressIssue>,
    params: { issueId: string; issueKey: string; summary: string; project: string; baseUrl: string },
  ): ProgressIssue {
    const existing = issues.get(params.issueId);
    if (existing) return existing;

    const created: ProgressIssue = {
      id: params.issueId,
      key: params.issueKey,
      summary: params.summary,
      project: params.project,
      link: `${params.baseUrl.replace(/\/$/, '')}/issue/${params.issueKey}`,
      transitions: [],
      comments: [],
      flags: {
        completed: false,
        reopened: false,
        blocked: false,
      },
    };
    issues.set(params.issueId, created);
    return created;
  }

  private resolveAuthor(author?: { login?: string; fullName?: string; name?: string }): string {
    return author?.fullName || author?.name || author?.login || 'Unknown';
  }

  private asArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    return value ? [value] : [];
  }

  private extractNamedValue(value: any): string | null {
    const item = this.asArray(value)[0];
    if (!item) return null;
    return item.name || item.text || item.idReadable || item.id || null;
  }

  private normalizeCommentText(value: string | null | undefined): string | null {
    if (!value) return null;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > 400 ? `${text.slice(0, 397)}...` : text;
  }

  private topCounts(values: string[]): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const value of values.filter(Boolean)) {
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  }
}
