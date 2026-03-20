import axios from 'axios';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000',
});

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('token') || '';
}

export async function authFetch(url: string) {
  const token = getToken();
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  return axios.get(`${baseUrl}${url}`, { headers: { Authorization: `Bearer ${token}` } });
}

export async function authPost(url: string, data: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST') {
  const token = getToken();
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  return axios({ method, url: `${baseUrl}${url}`, data, headers: { Authorization: `Bearer ${token}` } });
}
