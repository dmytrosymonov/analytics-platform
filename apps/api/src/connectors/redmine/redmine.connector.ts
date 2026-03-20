import axios from 'axios';
import { SourceConnector, ConnectorResult } from '../base/connector.interface';

export class RedmineConnector implements SourceConnector {
  readonly sourceType = 'redmine';

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { redmine_base_url, redmine_api_key } = credentials as any;
    if (!redmine_base_url || !redmine_api_key) return false;
    try {
      const resp = await axios.get(`${redmine_base_url}/issues.json?limit=1`, {
        headers: { 'X-Redmine-API-Key': redmine_api_key },
        timeout: 10000,
      });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  async fetchData(credentials: Record<string, unknown>, settings: Record<string, string>, period: { start: Date; end: Date }): Promise<ConnectorResult> {
    const { redmine_base_url, redmine_api_key, default_project_id } = credentials as any;
    const timeout = parseInt(settings['timeout'] || '30') * 1000;

    const client = axios.create({
      baseURL: redmine_base_url,
      headers: { 'X-Redmine-API-Key': redmine_api_key },
      timeout,
    });

    const dateFrom = period.start.toISOString().slice(0, 10);
    const dateTo = period.end.toISOString().slice(0, 10);

    const params: any = { limit: 100 };
    if (default_project_id) params.project_id = default_project_id;

    const [created, closed, overdue] = await Promise.allSettled([
      client.get('/issues.json', { params: { ...params, created_on: `><${dateFrom}|${dateTo}` } }),
      client.get('/issues.json', { params: { ...params, status_id: 'closed', updated_on: `><${dateFrom}|${dateTo}` } }),
      client.get('/issues.json', { params: { ...params, status_id: 'open', due_date: `<=${dateTo}` } }),
    ]);

    const getIssues = (r: PromiseSettledResult<any>) =>
      r.status === 'fulfilled' ? (r.value.data.issues || []) : [];

    const createdIssues = getIssues(created);
    const closedIssues = getIssues(closed);
    const overdueIssues = getIssues(overdue);

    const assigneeLoad: Record<string, number> = {};
    [...createdIssues, ...overdueIssues].forEach((issue: any) => {
      const name = issue.assigned_to?.name || 'Unassigned';
      assigneeLoad[name] = (assigneeLoad[name] || 0) + 1;
    });

    return {
      success: true,
      data: {
        sourceId: 'redmine',
        sourceName: 'Redmine',
        fetchedAt: new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        timezone: settings['timezone'] || 'UTC',
        metrics: {
          issues_created: createdIssues.length,
          issues_closed: closedIssues.length,
          issues_overdue: overdueIssues.length,
          closure_rate: createdIssues.length > 0 ? closedIssues.length / createdIssues.length : 0,
          assignee_load: assigneeLoad,
          high_priority_overdue: overdueIssues.filter((i: any) => (i.priority?.id || 0) >= 4).length,
        },
      },
    };
  }
}
