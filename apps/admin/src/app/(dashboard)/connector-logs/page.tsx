'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import { RefreshCw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';

interface LogEntry {
  id: string;
  ts: string;
  connector: string;
  type: 'req' | 'res' | 'err';
  method?: string;
  url?: string;
  params?: Record<string, any>;
  status?: number;
  ms?: number;
  items?: number;
  error?: string;
  responseData?: string;
}

const TYPE_LABELS: Record<string, string> = { req: 'REQUEST', res: 'RESPONSE', err: 'ERROR' };
const TYPE_COLORS: Record<string, string> = {
  req: 'badge-gray',
  res: 'badge-green',
  err: 'badge-red',
};
const STATUS_COLOR = (s?: number) => {
  if (!s) return 'text-gray-400';
  if (s < 300) return 'text-green-600';
  if (s < 400) return 'text-yellow-600';
  return 'text-red-600';
};

const CONNECTORS = ['gto', 'gto-currency', 'redmine', 'youtrack', 'fireflies'];

export default function ConnectorLogsPage() {
  const qc = useQueryClient();
  const [connector, setConnector] = useState('');
  const [type, setType]           = useState('');
  const [urlFilter, setUrlFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['connector-logs', connector, type],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '500' });
      if (connector) params.set('connector', connector);
      if (type)      params.set('type', type);
      return authFetch(`/api/v1/connector-logs?${params}`);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const clearMutation = useMutation({
    mutationFn: () => authPost('/api/v1/connector-logs', undefined, 'DELETE'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connector-logs'] });
      toast.success('Logs cleared');
    },
  });

  const allEntries: LogEntry[] = data?.data?.data || [];
  const entries = urlFilter
    ? allEntries.filter(e => e.url?.toLowerCase().includes(urlFilter.toLowerCase()))
    : allEntries;

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const hasDetails = (e: LogEntry) => e.params || e.error || e.responseData;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">API Logs</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            HTTP-запросы ко всем провайдерам · последние 1000 записей
            {dataUpdatedAt > 0 && (
              <span className="ml-2 text-gray-400">
                обновлено {new Date(dataUpdatedAt).toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`btn btn-sm ${autoRefresh ? 'btn-primary' : 'btn-secondary'}`}
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            {autoRefresh ? 'Auto 5s' : 'Auto OFF'}
          </button>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['connector-logs'] })}
            className="btn-secondary btn btn-sm"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button
            onClick={() => clearMutation.mutate()}
            disabled={clearMutation.isPending}
            className="btn btn-sm btn-danger"
          >
            <Trash2 size={14} />
            Clear
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <select
          className="input w-40"
          value={connector}
          onChange={e => setConnector(e.target.value)}
        >
          <option value="">All connectors</option>
          {CONNECTORS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          className="input w-36"
          value={type}
          onChange={e => setType(e.target.value)}
        >
          <option value="">All types</option>
          <option value="req">REQUEST</option>
          <option value="res">RESPONSE</option>
          <option value="err">ERROR</option>
        </select>
        <input
          className="input flex-1"
          placeholder="Filter by URL..."
          value={urlFilter}
          onChange={e => setUrlFilter(e.target.value)}
        />
        <span className="flex items-center text-sm text-gray-500 whitespace-nowrap">
          {entries.length} записей
        </span>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="w-6 px-2 py-3" />
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Time</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Connector</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Type</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Method</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">URL</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">ms</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Items</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                    No logs yet — trigger a report run to see API requests here
                  </td>
                </tr>
              )}
              {entries.map(e => {
                const isExp = expanded.has(e.id);
                const canExp = hasDetails(e);
                return [
                  <tr
                    key={e.id}
                    className={`hover:bg-gray-50 ${e.type === 'err' ? 'bg-red-50 hover:bg-red-100' : ''}`}
                  >
                    <td className="px-2 py-2 text-center">
                      {canExp && (
                        <button onClick={() => toggleExpand(e.id)} className="text-gray-400 hover:text-gray-700">
                          {isExp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-500 whitespace-nowrap font-mono text-xs">
                      {new Date(e.ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}
                    </td>
                    <td className="px-4 py-2">
                      <span className="badge badge-blue">{e.connector}</span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`badge ${TYPE_COLORS[e.type]}`}>{TYPE_LABELS[e.type]}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs font-semibold text-gray-700">{e.method || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 max-w-xs truncate" title={e.url}>
                      {e.url || '—'}
                    </td>
                    <td className={`px-4 py-2 font-mono text-xs font-semibold ${STATUS_COLOR(e.status)}`}>
                      {e.status ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-600 text-xs">
                      {e.ms != null ? `${e.ms}ms` : '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-600 text-xs">
                      {e.items != null ? e.items : e.error ? <span className="text-red-600 truncate max-w-48 block" title={e.error}>{e.error}</span> : '—'}
                    </td>
                  </tr>,
                  isExp && (
                    <tr key={`${e.id}-detail`} className={e.type === 'err' ? 'bg-red-50' : 'bg-gray-50'}>
                      <td />
                      <td colSpan={8} className="px-4 py-3">
                        {e.params && Object.keys(e.params).length > 0 && (
                          <div className="mb-2">
                            <span className="text-xs font-semibold text-gray-500 uppercase">Params</span>
                            <pre className="mt-1 text-xs bg-white border border-gray-200 rounded p-2 overflow-x-auto">
                              {JSON.stringify(e.params, null, 2)}
                            </pre>
                          </div>
                        )}
                        {e.error && (
                          <div className="mb-2">
                            <span className="text-xs font-semibold text-red-500 uppercase">Error</span>
                            <pre className="mt-1 text-xs bg-white border border-red-200 rounded p-2 text-red-700 overflow-x-auto">
                              {e.error}
                            </pre>
                          </div>
                        )}
                        {e.responseData && (
                          <div>
                            <span className="text-xs font-semibold text-gray-500 uppercase">Response body (truncated)</span>
                            <pre className="mt-1 text-xs bg-white border border-gray-200 rounded p-2 overflow-x-auto max-h-40">
                              {e.responseData}
                            </pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ].filter(Boolean);
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
