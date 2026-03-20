export interface NormalizedSourceData {
  sourceId: string;
  sourceName: string;
  fetchedAt: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  metrics: Record<string, unknown>;
  rawSampleSize?: number;
  warnings?: string[];
}

export interface ConnectorResult {
  success: boolean;
  data?: NormalizedSourceData;
  error?: { code: string; message: string; retryable: boolean };
}

export interface SourceConnector {
  readonly sourceType: string;
  validateCredentials(credentials: Record<string, unknown>): Promise<boolean>;
  fetchData(
    credentials: Record<string, unknown>,
    settings: Record<string, string>,
    period: { start: Date; end: Date }
  ): Promise<ConnectorResult>;
}
