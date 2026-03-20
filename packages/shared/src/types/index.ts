export type UserStatus = 'pending' | 'approved' | 'blocked' | 'deleted';
export type SourceType = 'gto' | 'ga4' | 'redmine';
export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';
export type RunStatus = 'pending' | 'running' | 'full_success' | 'partial_success' | 'full_failure';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: { page: number; limit: number; total: number; totalPages: number };
}
