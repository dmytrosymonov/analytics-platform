import { AxiosInstance } from 'axios';
import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { createHttpClient } from '../../lib/http';

export class YouTrackConnector implements SourceConnector {
  readonly sourceType = 'youtrack';

  private makeClient(baseUrl: string, token: string, timeout: number): AxiosInstance {
    return createHttpClient({
      baseURL: baseUrl.replace(/\/$/, ''),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout,
    }, 'youtrack');
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { youtrack_base_url, youtrack_token } = credentials as any;
    if (!youtrack_base_url || !youtrack_token) return false;
    try {
      const client = this.makeClient(youtrack_base_url, youtrack_token, 10000);
      const resp = await client.get('/api/admin/users/me?fields=id,login,fullName');
      return resp.status === 200 && !!resp.data?.id;
    } catch {
      return false;
    }
  }

  async fetchData(
    credentials: Record<string, unknown>,
    settings: Record<string, string>,
    period: { start: Date; end: Date },
  ): Promise<ConnectorResult> {
    const { youtrack_base_url, youtrack_token, youtrack_project } = credentials as any;
    const timeout = parseInt(settings['timeout'] || '30') * 1000;
    const client = this.makeClient(youtrack_base_url, youtrack_token, timeout);

    const startMs = period.start.getTime();
    const endMs = period.end.getTime();

    // YouTrack uses Unix timestamps in milliseconds in queries
    const projectFilter = youtrack_project ? ` project: ${youtrack_project}` : '';
    const issueFields = 'id,summary,created,resolved,updated,priority(name),assignee(login,fullName),state(name,isResolved),type(name)';

    const [createdRes, resolvedRes, unresolvedRes] = await Promise.allSettled([
      client.get('/api/issues', {
        params: {
          fields: issueFields,
          query: `created: ${period.start.toISOString().slice(0, 10)} .. ${period.end.toISOString().slice(0, 10)}${projectFilter}`,
          $top: 200,
        },
      }),
      client.get('/api/issues', {
        params: {
          fields: issueFields,
          query: `resolved: ${period.start.toISOString().slice(0, 10)} .. ${period.end.toISOString().slice(0, 10)}${projectFilter}`,
          $top: 200,
        },
      }),
      client.get('/api/issues', {
        params: {
          fields: issueFields,
          query: `State: Unresolved${projectFilter}`,
          $top: 200,
        },
      }),
    ]);

    const getIssues = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? (r.value.data || []) : [];

    const createdIssues: any[] = getIssues(createdRes);
    const resolvedIssues: any[] = getIssues(resolvedRes);
    const unresolvedIssues: any[] = getIssues(unresolvedRes);

    // Avg resolution time for resolved issues created in this period
    const resolutionTimes = resolvedIssues
      .filter((i: any) => i.created && i.resolved)
      .map((i: any) => (i.resolved - i.created) / 3600000); // hours
    const avgResolutionHours = resolutionTimes.length
      ? resolutionTimes.reduce((a: number, b: number) => a + b, 0) / resolutionTimes.length
      : null;

    // By priority
    const byPriority: Record<string, number> = {};
    [...createdIssues, ...unresolvedIssues].forEach((i: any) => {
      const p = i.priority?.name || 'No Priority';
      byPriority[p] = (byPriority[p] || 0) + 1;
    });

    // By assignee (unresolved)
    const byAssignee: Record<string, number> = {};
    unresolvedIssues.forEach((i: any) => {
      const name = i.assignee?.fullName || i.assignee?.login || 'Unassigned';
      byAssignee[name] = (byAssignee[name] || 0) + 1;
    });

    // By state (unresolved)
    const byState: Record<string, number> = {};
    unresolvedIssues.forEach((i: any) => {
      const s = i.state?.name || 'Unknown';
      byState[s] = (byState[s] || 0) + 1;
    });

    // By type (created)
    const byType: Record<string, number> = {};
    createdIssues.forEach((i: any) => {
      const t = i.type?.name || 'No Type';
      byType[t] = (byType[t] || 0) + 1;
    });

    return {
      success: true,
      data: {
        sourceId: 'youtrack',
        sourceName: 'YouTrack',
        fetchedAt: new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        timezone: settings['timezone'] || 'UTC',
        metrics: {
          issues_created: createdIssues.length,
          issues_resolved: resolvedIssues.length,
          issues_unresolved: unresolvedIssues.length,
          resolution_rate: createdIssues.length > 0
            ? +(resolvedIssues.length / createdIssues.length).toFixed(2)
            : 0,
          avg_resolution_hours: avgResolutionHours !== null ? +avgResolutionHours.toFixed(1) : null,
          by_priority: byPriority,
          by_assignee: byAssignee,
          by_state: byState,
          by_type: byType,
        },
      },
    };
  }
}
