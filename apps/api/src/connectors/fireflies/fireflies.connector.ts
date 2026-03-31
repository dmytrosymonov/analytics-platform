import { SourceConnector, ConnectorResult } from '../base/connector.interface';
import { createHttpClient } from '../../lib/http';

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // unix ms
  duration: number; // seconds
  participants: string[];
  summary?: {
    action_items?: string[];
    keywords?: string[];
    overview?: string;
  };
  organizer_email?: string;
  host_name?: string;
}

export class FirefliesConnector implements SourceConnector {
  readonly sourceType = 'fireflies';

  private async gql(apiKey: string, query: string, variables?: Record<string, unknown>) {
    const client = createHttpClient({
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }, 'fireflies');
    const resp = await client.post(FIREFLIES_API, { query, variables });
    if (resp.data.errors) {
      throw new Error(resp.data.errors[0]?.message || 'GraphQL error');
    }
    return resp.data.data;
  }

  async validateCredentials(credentials: Record<string, unknown>): Promise<boolean> {
    const { fireflies_api_key } = credentials as any;
    if (!fireflies_api_key) return false;
    try {
      const data = await this.gql(
        fireflies_api_key,
        `query { user { user_id name email } }`,
      );
      return !!data?.user?.user_id;
    } catch {
      return false;
    }
  }

  async fetchData(
    credentials: Record<string, unknown>,
    settings: Record<string, string>,
    period: { start: Date; end: Date },
  ): Promise<ConnectorResult> {
    const { fireflies_api_key } = credentials as any;

    const fromDate = period.start.toISOString().slice(0, 10);
    const toDate = period.end.toISOString().slice(0, 10);

    // Fireflies GraphQL: fetch transcripts in the date range
    const query = `
      query GetTranscripts($fromDate: String, $toDate: String) {
        transcripts(fromDate: $fromDate, toDate: $toDate) {
          id
          title
          date
          duration
          participants
          organizer_email
          host_name
          summary {
            action_items
            keywords
            overview
          }
        }
      }
    `;

    let transcripts: FirefliesTranscript[] = [];
    try {
      const data = await this.gql(fireflies_api_key, query, { fromDate, toDate });
      transcripts = data?.transcripts || [];
    } catch (err: any) {
      return {
        success: false,
        error: {
          code: 'FETCH_FAILED',
          message: err.message || 'Failed to fetch Fireflies data',
          retryable: true,
        },
      };
    }

    // Aggregate metrics
    const totalMeetings = transcripts.length;
    const totalDurationSec = transcripts.reduce((sum, t) => sum + (t.duration || 0), 0);
    const avgDurationMin = totalMeetings > 0 ? Math.round(totalDurationSec / totalMeetings / 60) : 0;

    const allActionItems: string[] = [];
    const allKeywords: string[] = [];
    const participantCounts: Record<string, number> = {};
    const meetingsByDay: Record<string, number> = {};

    for (const t of transcripts) {
      if (t.summary?.action_items) allActionItems.push(...t.summary.action_items);
      if (t.summary?.keywords) allKeywords.push(...t.summary.keywords);

      for (const p of t.participants || []) {
        participantCounts[p] = (participantCounts[p] || 0) + 1;
      }

      const day = t.date ? new Date(t.date).toISOString().slice(0, 10) : 'unknown';
      meetingsByDay[day] = (meetingsByDay[day] || 0) + 1;
    }

    // Top participants by meeting count
    const topParticipants = Object.entries(participantCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce<Record<string, number>>((acc, [k, v]) => { acc[k] = v; return acc; }, {});

    // Keyword frequency
    const keywordFreq: Record<string, number> = {};
    for (const kw of allKeywords) {
      keywordFreq[kw] = (keywordFreq[kw] || 0) + 1;
    }
    const topKeywords = Object.entries(keywordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([kw]) => kw);

    // Meeting titles sample (last 10)
    const recentMeetings = transcripts
      .sort((a, b) => (b.date || 0) - (a.date || 0))
      .slice(0, 10)
      .map(t => ({
        title: t.title,
        date: t.date ? new Date(t.date).toISOString().slice(0, 10) : null,
        duration_min: Math.round((t.duration || 0) / 60),
        participants_count: (t.participants || []).length,
        action_items_count: (t.summary?.action_items || []).length,
      }));

    return {
      success: true,
      data: {
        sourceId: 'fireflies',
        sourceName: 'Fireflies.ai',
        fetchedAt: new Date().toISOString(),
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        timezone: settings['timezone'] || 'UTC',
        rawSampleSize: totalMeetings,
        metrics: {
          total_meetings: totalMeetings,
          total_duration_minutes: Math.round(totalDurationSec / 60),
          avg_duration_minutes: avgDurationMin,
          total_action_items: allActionItems.length,
          meetings_by_day: meetingsByDay,
          top_participants: topParticipants,
          top_keywords: topKeywords,
          recent_meetings: recentMeetings,
          action_items_sample: allActionItems.slice(0, 20),
        },
      },
    };
  }
}
