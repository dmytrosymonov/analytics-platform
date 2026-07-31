'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';
import { RefreshCw, ShieldCheck } from 'lucide-react';

type ScopeOverride = {
  id: string;
  agentId: string | null;
  normalizedAgentName: string | null;
  isCommercial: boolean;
  reason: string;
  isActive: boolean;
  createdBy: string | null;
  updatedAt: string;
};

export default function AgentSegmentsPage() {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [reason, setReason] = useState('');
  const [isCommercial, setIsCommercial] = useState(false);

  const scope = useQuery({
    queryKey: ['gto-agent-segment-scope'],
    queryFn: () => authFetch('/api/v1/looker/gto-agent-segments/scope-overrides'),
  });
  const status = useQuery({
    queryKey: ['gto-agent-segment-status'],
    queryFn: () => authFetch('/api/v1/looker/gto-agent-segments/status'),
  });
  const refresh = useMutation({
    mutationFn: () => authPost('/api/v1/looker/gto-agent-segments/refresh', { snapshotDate: undefined, dryRun: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gto-agent-segment-status'] });
      toast.success('Snapshot refresh completed');
    },
    onError: (error: any) => toast.error(error?.response?.data?.error?.message || 'Snapshot refresh failed'),
  });
  const create = useMutation({
    mutationFn: () => authPost('/api/v1/looker/gto-agent-segments/scope-overrides', {
      agentId: agentId || undefined,
      agentName: agentName || undefined,
      isCommercial,
      reason,
    }),
    onSuccess: () => {
      setAgentId(''); setAgentName(''); setReason(''); setIsCommercial(false);
      queryClient.invalidateQueries({ queryKey: ['gto-agent-segment-scope'] });
      toast.success('Scope rule added');
    },
    onError: (error: any) => toast.error(error?.response?.data?.error?.message || 'Could not add scope rule'),
  });
  const toggle = useMutation({
    mutationFn: (row: ScopeOverride) => authPost(`/api/v1/looker/gto-agent-segments/scope-overrides/${row.id}`, { isActive: !row.isActive }, 'PATCH'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['gto-agent-segment-scope'] }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  const overrides: ScopeOverride[] = scope.data?.data?.data || [];
  const currentSnapshot = status.data?.data?.data?.currentSnapshotDate || 'Not built yet';

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">GTO.UA Agent Segments</h2>
          <p className="mt-1 text-sm text-gray-500">Commercial scope rules and the current server-side snapshot.</p>
        </div>
        <button className="btn-primary flex items-center gap-2" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          <RefreshCw size={15} className={refresh.isPending ? 'animate-spin' : ''} />
          {refresh.isPending ? 'Refreshing...' : 'Refresh completed day'}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card p-4"><p className="text-xs text-gray-500">Latest snapshot</p><p className="mt-1 font-semibold text-gray-900">{currentSnapshot}</p></div>
        <div className="card p-4"><p className="text-xs text-gray-500">Refresh state</p><p className="mt-1 font-semibold text-gray-900">{status.data?.data?.data?.inFlight ? 'Running' : 'Idle'}</p></div>
        <div className="card p-4"><p className="text-xs text-gray-500">Scope rules</p><p className="mt-1 font-semibold text-gray-900">{overrides.filter((row) => row.isActive).length} active</p></div>
      </div>

      <form className="card p-5" onSubmit={onSubmit}>
        <div className="mb-4 flex items-center gap-2"><ShieldCheck size={18} className="text-blue-600" /><h3 className="font-semibold text-gray-900">Commercial scope rule</h3></div>
        <div className="grid gap-3 md:grid-cols-2">
          <input className="input" placeholder="Agent ID (preferred)" value={agentId} onChange={(event) => setAgentId(event.target.value)} />
          <input className="input" placeholder="Agent name (fallback)" value={agentName} onChange={(event) => setAgentName(event.target.value)} />
          <input className="input md:col-span-2" required placeholder="Reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={isCommercial} onChange={(event) => setIsCommercial(event.target.checked)} /> Include as commercial agent</label>
          <button className="btn-primary" disabled={create.isPending || (!agentId && !agentName)}>{create.isPending ? 'Saving...' : 'Add rule'}</button>
        </div>
      </form>

      <div className="card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-4 py-3">Agent</th><th className="px-4 py-3">Scope</th><th className="px-4 py-3">Reason</th><th className="px-4 py-3">Status</th><th className="px-4 py-3" /></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {overrides.map((row) => <tr key={row.id}>
              <td className="px-4 py-3 text-gray-800">{row.agentId || row.normalizedAgentName}</td>
              <td className="px-4 py-3"><span className={row.isCommercial ? 'text-green-700' : 'text-red-700'}>{row.isCommercial ? 'Include' : 'Exclude'}</span></td>
              <td className="px-4 py-3 text-gray-600">{row.reason}</td>
              <td className="px-4 py-3 text-gray-600">{row.isActive ? 'Active' : 'Inactive'}</td>
              <td className="px-4 py-3 text-right"><button className="text-blue-600 hover:text-blue-800" onClick={() => toggle.mutate(row)} type="button">{row.isActive ? 'Disable' : 'Enable'}</button></td>
            </tr>)}
            {!overrides.length && <tr><td className="px-4 py-8 text-center text-gray-500" colSpan={5}>No scope rules configured.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
