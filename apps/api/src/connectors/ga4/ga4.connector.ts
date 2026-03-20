import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { logger } from '../../lib/logger';

export class GA4Connector implements SourceConnector {
  readonly sourceType = 'ga4';

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { service_account_json, ga_property_id } = credentials as any;
    if (!service_account_json || !ga_property_id) return false;
    try {
      JSON.parse(service_account_json);
      return true;
    } catch {
      return false;
    }
  }

  async fetchData(credentials: Record<string, unknown>, settings: Record<string, string>, period: { start: Date; end: Date }): Promise<ConnectorResult> {
    const { service_account_json, ga_property_id } = credentials as any;

    try {
      const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
      const serviceAccount = typeof service_account_json === 'string' ? JSON.parse(service_account_json) : service_account_json;
      const client = new BetaAnalyticsDataClient({ credentials: serviceAccount });

      const dateRange = {
        startDate: period.start.toISOString().slice(0, 10),
        endDate: period.end.toISOString().slice(0, 10),
      };

      const [summaryResponse] = await client.runReport({
        property: `properties/${ga_property_id}`,
        dateRanges: [dateRange],
        metrics: [
          { name: 'activeUsers' },
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
        ],
      });

      const row = summaryResponse.rows?.[0]?.metricValues;
      const metrics = {
        active_users: parseInt(row?.[0]?.value || '0'),
        sessions: parseInt(row?.[1]?.value || '0'),
        page_views: parseInt(row?.[2]?.value || '0'),
        bounce_rate: parseFloat(row?.[3]?.value || '0'),
        avg_session_duration: parseFloat(row?.[4]?.value || '0'),
      };

      return {
        success: true,
        data: {
          sourceId: 'ga4',
          sourceName: 'Google Analytics 4',
          fetchedAt: new Date().toISOString(),
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          timezone: settings['timezone'] || 'UTC',
          metrics,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: { code: 'GA4_FETCH_ERROR', message: err.message, retryable: false },
      };
    }
  }
}
