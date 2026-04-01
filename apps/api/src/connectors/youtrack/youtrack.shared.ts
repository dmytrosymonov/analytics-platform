import { AxiosInstance } from 'axios';
import { createHttpClient } from '../../lib/http';

export interface YouTrackCredentials {
  youtrack_base_url?: string;
  youtrack_token?: string;
  youtrack_project?: string;
}

const VALIDATION_ENDPOINTS = [
  '/api/users/me?fields=id,login,fullName',
  '/api/admin/users/me?fields=id,login,fullName',
];

export function makeYouTrackClient(baseUrl: string, token: string, timeout: number, connectorName = 'youtrack'): AxiosInstance {
  return createHttpClient({
    baseURL: baseUrl.replace(/\/$/, ''),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout,
  }, connectorName);
}

export async function validateYouTrackCredentials(credentials: Record<string, unknown>, timeout = 10000, connectorName = 'youtrack'): Promise<boolean> {
  const { youtrack_base_url, youtrack_token } = credentials as YouTrackCredentials;
  if (!youtrack_base_url || !youtrack_token) return false;

  const client = makeYouTrackClient(youtrack_base_url, youtrack_token, timeout, connectorName);
  for (const endpoint of VALIDATION_ENDPOINTS) {
    try {
      const resp = await client.get(endpoint);
      if (resp.status === 200 && !!resp.data?.id) return true;
    } catch (err: any) {
      if (err?.response?.status !== 404) throw err;
    }
  }

  return false;
}
