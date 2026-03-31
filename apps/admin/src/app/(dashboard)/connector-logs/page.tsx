'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import { RefreshCw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';

interface LogEntry {
  id: string;
  sessionId: string;
  ts: string;
  connector: string;
  type: 'res' | 'err';
  method?: string;
  url?: string;
  params?: Record<string, any>;
  status?: number;
  ms?: number;
  items?: number;
  responseSample?: unknown;
  error?: string;
  errorBody?: string;
}

interface Session {
  sessionId: string;
  connector: string;
  startTs: string;
  entries: LogEntry[];
  errCount: number;
  totalMs: number;
}

const CONNECTORS = ['gto', 'gto-currency', 'redmine', 'youtrack', 'fireflies'];

function groupBySessions(entries: LogEntry[]): Session[] {
  const map = new Map<string, Session>();
  for (const e of entries) {
    if (!map.has(e.sessionId)) {
      map.set(e.sessionId, {
        sessionId: e.sessionId,
        connector: e.connector,
        startTs: e.ts,
        entries: [],
        errCount: 0,
        totalMs: 0,
      });
    }
    const s = map.get(e.sessionId)!;
    s.entries.push(e);
    if (e.type === 'err') s.errCount++;
    s.totalMs += e.ms ?? 0;
    // earliest ts = session start
    if (e.ts < s.startTs) s.startTs = e.ts;
  }
  // sort sessions newest first
  return [...map.values()].sort((a, b) => b.startTs.localeCompare(a.startTs));
}

function StatusBadge({ status }: { status?: number }) {
  if (!status) return <span className="text-gray-400">—</span>;
  const color = status < 300 ? 'text-green-600' : status < 400 ? 'text-yellow-600' : 'text-red-600';
  return <span className={`font-mono font-semibold ${color}`}>{status}</span>;
}

function ResponseSample({ data }: { data: unknown }) {
  if (data === undefined || data === null) return null;
  let str: string;
  try { str = JSON.stringify(data, null, 2); } catch { str = String(data); }
  return (
    <pre className="text-xs bg-white border border-gray-200 rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap break-words">
      {str}
    </pre>
  );
}

function EntryRow({ e }: { e: LogEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetails = e.params || e.responseSample !== undefined || e.error || e.errorBody;

  return (
    <>
      <tr
        className={`text-sm ${e.type === 'err' ? 'bg-red-50' : 'hover:bg-gray-50'} cursor-pointer`}
        onClick={() => hasDetails && setOpen(v => !v)}
      >
        <td className="pl-8 pr-2 py-1.5 text-gray-400 font-mono text-xs w-6">
          {hasDetails ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
        </td>
        <td className="px-3 py-1.5 font-mono text-xs text-gray-500 whitespace-nowrap">
          {new Date(e.ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </td>
        <td className="px-3 py-1.5 font-mono text-xs font-bold text-gray-700 w-14">{e.method || '—'}</td>
        <td className="px-3 py-1.5 font-mono text-xs text-gray-600 max-w-sm truncate" title={e.url}>{e.url || '—'}</td>
        <td className="px-3 py-1.5"><StatusBadge status={e.status} /></td>
        <td className="px-3 py-1.5 text-xs text-gray-500">{e.ms != null ? `${e.ms}ms` : '—'}</td>
        <td className="px-3 py-1.5 text-xs text-gray-500">
          {e.items != null
            ? <span className="badge badge-gray">{e.items} items</span>
            : e.type === 'err'
              ? <span className="text-red-600 text-xs truncate max-w-xs block" title={e.error}>{e.error}</span>
              : '—'}
        </td>
      </tr>
      {open && (
        <tr className={e.type === 'err' ? 'bg-red-50' : 'bg-gray-50'}>
          <td colSpan={7} className="px-8 pb-3 pt-1">
            <div className="space-y-2">
              {e.params && Object.keys(e.params).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Params</p>
                  <ResponseSample data={e.params} />
                </div>
              )}
              {e.responseSample !== undefined && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-1">
                    Response{e.items != null ? ` (${e.items} items)` : ''}
                  </p>
                  <ResponseSample data={e.responseSample} />
                </div>
              )}
              {e.error && (
                <div>
                  <p className="text-xs font-semibold text-red-500 uppercase mb-1">Error</p>
                  <pre className="text-xs bg-white border border-red-200 rounded p-2 text-red-700 overflow-auto max-h-32">
                    {e.error}
                  </pre>
                </div>
              )}
              {e.errorBody && (
                <div>
                  <p className="text-xs font-semibold text-red-400 uppercase mb-1">Error body</p>
                  <pre className="text-xs bg-white border border-red-100 rounded p-2 text-red-600 overflow-auto max-h-32">
                    {e.errorBody}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SessionGroup({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);

  const CONNECTOR_COLOR: Record<string, string> = {
    gto: 'badge-blue', 'gto-currency': 'badge-gray',
    redmine: 'badge-red', youtrack: 'badge-yellow', fireflies: 'badge-green',
  };

  const time = new Date(session.startTs).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden mb-2">
      {/* Session header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-gray-50 hover:bg-gray-100 text-left transition-colors"
      >
        {open ? <ChevronDown size={16} className="text-gray-500 shrink-0" /> : <ChevronRight size={16} className="text-gray-500 shrink-0" />}

        <span className={`badge ${CONNECTOR_COLOR[session.connector] || 'badge-gray'}`}>
          {session.connector}
        </span>

        <span className="text-sm font-medium text-gray-700">{time}</span>

        <span className="text-xs text-gray-500">
          {session.entries.length} запросов · {Math.round(session.totalMs / 1000)}s
        </span>

        {session.errCount > 0 && (
          <span className="badge badge-red">{session.errCount} ошибок</span>
        )}
      </button>

      {/* Session entries */}
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-white border-b border-gray-100">
              <tr>
                <th className="w-8" />
                {['Время', 'Метод', 'URL', 'Статус', 'ms', 'Ответ'].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-xs font-semibold text-gray-400 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {session.entries.map(e => <EntryRow key={e.id} e={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ConnectorLogsPage() {
  const qc = useQueryClient();
  const [connector, setConnector] = useState('');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['connector-logs', connector],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '1000' });
      if (connector) params.set('connector', connector);
      return authFetch(`/api/v1/connector-logs?${params}`);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const clearMutation = useMutation({
    mutationFn: () => authPost('/api/v1/connector-logs', undefined, 'DELETE'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['connector-logs'] }); toast.success('Логи очищены'); },
  });

  const allEntries: LogEntry[] = data?.data?.data || [];
  const filtered = onlyErrors ? allEntries.filter(e => e.type === 'err') : allEntries;
  const sessions = groupBySessions(filtered);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">API Logs</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Запросы ко всем провайдерам · сгруппированы по сессиям
            {dataUpdatedAt > 0 && (
              <span className="ml-2 text-gray-400">· {new Date(dataUpdatedAt).toLocaleTimeString()}</span>
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
          <button onClick={() => qc.invalidateQueries({ queryKey: ['connector-logs'] })} className="btn btn-sm btn-secondary">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => clearMutation.mutate()} disabled={clearMutation.isPending} className="btn btn-sm btn-danger">
            <Trash2 size={14} /> Clear
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4 items-center">
        <select className="input w-44" value={connector} onChange={e => setConnector(e.target.value)}>
          <option value="">Все коннекторы</option>
          {CONNECTORS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyErrors}
            onChange={e => setOnlyErrors(e.target.checked)}
            className="rounded"
          />
          Только ошибки
        </label>

        <span className="text-sm text-gray-400 ml-auto">
          {sessions.length} сессий · {filtered.length} запросов
        </span>
      </div>

      {/* Sessions */}
      {isLoading ? (
        <div className="card p-8 text-center text-gray-500">Загрузка...</div>
      ) : sessions.length === 0 ? (
        <div className="card p-8 text-center text-gray-500">
          Нет логов — запустите отчёт и обновите страницу
        </div>
      ) : (
        <div>
          {sessions.map(s => <SessionGroup key={s.sessionId} session={s} />)}
        </div>
      )}
    </div>
  );
}
