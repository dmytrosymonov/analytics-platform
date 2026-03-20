'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/api';

export default function AuditPage() {
  const [action, setAction] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', action],
    queryFn: () => authFetch(`/api/v1/audit/logs${action ? `?action=${action}` : ''}`),
  });

  const logs = data?.data?.data || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">Audit Log</h2>
        <input className="input w-64" placeholder="Filter by action..." value={action} onChange={e => setAction(e.target.value)} />
      </div>
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Timestamp', 'Actor', 'Action', 'Entity', 'IP'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No logs found</td></tr>}
              {logs.map((log: any) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3"><span className={`badge ${log.actorType === 'admin' ? 'badge-blue' : 'badge-gray'}`}>{log.actorType}</span></td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{log.action}</td>
                  <td className="px-4 py-3 text-gray-600">{log.entityType ? `${log.entityType}` : '—'}</td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{log.ipAddress || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
