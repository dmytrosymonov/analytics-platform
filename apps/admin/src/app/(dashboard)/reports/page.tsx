'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';

export default function ReportsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['report-runs'],
    queryFn: () => authFetch('/api/v1/reports/runs?limit=20'),
    refetchInterval: 10000,
  });

  const triggerRun = useMutation({
    mutationFn: (payload: any) => authPost('/api/v1/reports/runs', payload, 'POST'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['report-runs'] }); toast.success('Report run triggered'); },
    onError: (e: any) => toast.error('Failed to trigger run'),
  });

  const runs = data?.data?.data || [];

  const handleTrigger = () => {
    const now = new Date();
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end.getTime() - 86400000);
    triggerRun.mutate({ periodStart: start.toISOString(), periodEnd: end.toISOString() });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">Report Runs</h2>
        <button className="btn-primary" onClick={handleTrigger} disabled={triggerRun.isPending}>
          {triggerRun.isPending ? 'Triggering...' : '▶ Trigger Run Now'}
        </button>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Period', 'Status', 'Trigger', 'Started', 'Completed', 'Jobs'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {runs.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No runs yet. Click "Trigger Run Now" to start.</td></tr>}
              {runs.map((run: any) => (
                <tr key={run.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm">
                    <span className="font-medium">{new Date(run.periodStart).toLocaleDateString()}</span>
                    <span className="text-gray-400 mx-1">→</span>
                    <span>{new Date(run.periodEnd).toLocaleDateString()}</span>
                  </td>
                  <td className="px-4 py-3"><RunStatusBadge status={run.status} /></td>
                  <td className="px-4 py-3 text-sm text-gray-600">{run.triggerType}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '—'}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{run.completedAt ? new Date(run.completedAt).toLocaleTimeString() : '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {run.jobs?.map((job: any) => (
                        <span key={job.id} title={`${job.source?.name} - ${job.jobType}`}
                          className={`badge badge-sm text-xs ${jobStatusClass(job.status)}`}>
                          {job.jobType[0].toUpperCase()}:{jobStatusIcon(job.status)}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { full_success: 'badge-green', partial_success: 'badge-yellow', full_failure: 'badge-red', running: 'badge-blue', pending: 'badge-gray' };
  return <span className={map[status] || 'badge-gray'}>{status.replace(/_/g, ' ')}</span>;
}

function jobStatusClass(status: string) {
  return { success: 'bg-green-100 text-green-700', failed: 'bg-red-100 text-red-700', skipped: 'bg-gray-100 text-gray-500', running: 'bg-blue-100 text-blue-700', pending: 'bg-gray-100 text-gray-400' }[status] || 'bg-gray-100';
}

function jobStatusIcon(status: string) {
  return { success: '✓', failed: '✗', skipped: '−', running: '…', pending: '·' }[status] || '?';
}
