'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';
import { CheckCircle, XCircle, AlertCircle, Settings2, ChevronDown, ChevronUp, Plus, Play, Trash2, Clock } from 'lucide-react';

const PERIOD_LABELS: Record<string, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const PERIOD_COLORS: Record<string, string> = {
  daily:   'bg-blue-50 text-blue-700 border-blue-200',
  weekly:  'bg-purple-50 text-purple-700 border-purple-200',
  monthly: 'bg-orange-50 text-orange-700 border-orange-200',
};

export default function SourcesPage() {
  const qc = useQueryClient();
  const [editingCreds, setEditingCreds] = useState<string | null>(null);
  const [credInputs, setCredInputs] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addingSchedule, setAddingSchedule] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['sources'], queryFn: () => authFetch('/api/v1/sources') });
  const { data: schedulesData } = useQuery({ queryKey: ['schedules'], queryFn: () => authFetch('/api/v1/schedules') });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      authPost(`/api/v1/sources/${id}`, { isEnabled }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); toast.success('Source updated'); },
  });

  const saveCreds = useMutation({
    mutationFn: ({ id }: { id: string }) => authPost(`/api/v1/sources/${id}/credentials`, credInputs, 'PUT'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); toast.success('Credentials saved'); setEditingCreds(null); setCredInputs({}); },
    onError: () => toast.error('Failed to save credentials'),
  });

  const testConnection = async (id: string) => {
    setTestingId(id);
    try {
      const res = await authPost(`/api/v1/sources/${id}/test`, {}, 'POST');
      const result = res.data.data;
      if (result.success) toast.success(`Connection OK (${result.latencyMs}ms)`);
      else toast.error(`Connection failed: ${result.error}`);
      qc.invalidateQueries({ queryKey: ['sources'] });
    } catch { toast.error('Test failed'); }
    finally { setTestingId(null); }
  };

  const toggleSchedule = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      authPost(`/api/v1/schedules/${id}`, { isEnabled }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); toast.success('Schedule updated'); },
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => authPost(`/api/v1/schedules/${id}`, {}, 'DELETE'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); toast.success('Schedule deleted'); },
  });

  const triggerSchedule = useMutation({
    mutationFn: (id: string) => authPost(`/api/v1/schedules/${id}/trigger`, {}, 'POST'),
    onSuccess: (res: any) => { toast.success(`Run started: ${res.data.data.runId.slice(0, 8)}...`); },
    onError: () => toast.error('Failed to trigger run'),
  });

  const sources = data?.data?.data || [];
  const allSchedules: any[] = schedulesData?.data?.data || [];

  const credentialFields: Record<string, { key: string; label: string; type?: string }[]> = {
    gto:      [{ key: 'api_key', label: 'API Key', type: 'password' }, { key: 'base_url', label: 'Base URL' }, { key: 'timezone', label: 'Timezone' }],
    ga4:      [{ key: 'ga_property_id', label: 'GA4 Property ID' }, { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea' }],
    redmine:  [{ key: 'redmine_base_url', label: 'Redmine Base URL' }, { key: 'redmine_api_key', label: 'API Key', type: 'password' }, { key: 'default_project_id', label: 'Project ID (optional)' }],
    youtrack: [{ key: 'youtrack_base_url', label: 'YouTrack Base URL' }, { key: 'youtrack_token', label: 'Permanent Token', type: 'password' }, { key: 'youtrack_project', label: 'Project Short Name (optional)' }],
    fireflies: [{ key: 'fireflies_api_key', label: 'API Key', type: 'password' }],
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-6">Data Sources</h2>
      <div className="space-y-4">
        {isLoading && <div className="card p-8 text-center text-gray-500">Loading...</div>}
        {sources.map((source: any) => {
          const sourceSchedules = allSchedules.filter((s: any) => s.sourceId === source.id);
          const isExpanded = expandedId === source.id;
          return (
            <div key={source.id} className="card">
              {/* Source header */}
              <div className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                      <Settings2 size={18} className="text-blue-600" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{source.name}</h3>
                      <p className="text-sm text-gray-500">{source.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <CredStatusIcon cred={source.credentials} />
                    <button className={`btn btn-sm ${source.isEnabled ? 'btn-danger' : 'btn-success'}`}
                      onClick={() => toggleEnabled.mutate({ id: source.id, isEnabled: !source.isEnabled })}>
                      {source.isEnabled ? 'Disable' : 'Enable'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => testConnection(source.id)} disabled={testingId === source.id}>
                      {testingId === source.id ? 'Testing...' : 'Test'}
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={() => { setEditingCreds(source.id); setCredInputs({}); }}>
                      Credentials
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => setExpandedId(isExpanded ? null : source.id)}>
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      <span className="ml-1 text-xs">{sourceSchedules.length} schedules</span>
                    </button>
                  </div>
                </div>

                {source.credentials && (
                  <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
                    Last validated: {source.credentials.lastValidatedAt ? new Date(source.credentials.lastValidatedAt).toLocaleString() : 'Never'}
                    {source.credentials.validationError && <span className="ml-2 text-red-600"> — {source.credentials.validationError}</span>}
                  </div>
                )}

                {editingCreds === source.id && (
                  <div className="mt-4 pt-4 border-t border-gray-100">
                    <h4 className="font-medium text-sm text-gray-700 mb-3">Edit Credentials</h4>
                    <div className="space-y-3">
                      {(credentialFields[source.type] || []).map(field => (
                        <div key={field.key}>
                          <label className="label">{field.label}</label>
                          {field.type === 'textarea' ? (
                            <textarea className="input h-32 font-mono text-xs" placeholder={`Enter ${field.label}`}
                              value={credInputs[field.key] || ''} onChange={e => setCredInputs(p => ({ ...p, [field.key]: e.target.value }))} />
                          ) : (
                            <input type={field.type || 'text'} className="input" placeholder={`Enter ${field.label}`}
                              value={credInputs[field.key] || ''} onChange={e => setCredInputs(p => ({ ...p, [field.key]: e.target.value }))} />
                          )}
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <button className="btn-primary" onClick={() => saveCreds.mutate({ id: source.id })}>Save</button>
                        <button className="btn-secondary" onClick={() => setEditingCreds(null)}>Cancel</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Schedules panel */}
              {isExpanded && (
                <div className="border-t border-gray-100 bg-gray-50 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
                      <Clock size={12} /> Report Schedules
                    </p>
                    <button className="btn btn-sm btn-primary flex items-center gap-1" onClick={() => setAddingSchedule(source.id)}>
                      <Plus size={13} /> Add Schedule
                    </button>
                  </div>

                  {sourceSchedules.length === 0 && (
                    <p className="text-sm text-gray-400 py-2">No schedules yet. Add one to start delivering reports.</p>
                  )}

                  <div className="space-y-2">
                    {sourceSchedules.map((sch: any) => (
                      <div key={sch.id} className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${PERIOD_COLORS[sch.periodType]}`}>
                          {PERIOD_LABELS[sch.periodType]}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900">{sch.name}</p>
                          <p className="text-xs text-gray-400 font-mono">{sch.cronExpression} {sch.description && `· ${sch.description}`}</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={`text-xs font-medium ${sch.isEnabled ? 'text-green-600' : 'text-gray-400'}`}>
                            {sch.isEnabled ? '● Active' : '○ Inactive'}
                          </span>
                          <button className={`btn btn-sm ${sch.isEnabled ? 'btn-danger' : 'btn-success'}`}
                            onClick={() => toggleSchedule.mutate({ id: sch.id, isEnabled: !sch.isEnabled })}>
                            {sch.isEnabled ? 'Disable' : 'Enable'}
                          </button>
                          <button className="btn btn-sm btn-secondary flex items-center gap-1" title="Run now"
                            onClick={() => triggerSchedule.mutate(sch.id)}>
                            <Play size={12} /> Run now
                          </button>
                          <button className="btn btn-sm btn-danger" title="Delete"
                            onClick={() => { if (confirm(`Delete "${sch.name}"?`)) deleteSchedule.mutate(sch.id); }}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {addingSchedule === source.id && (
                    <AddScheduleForm sourceId={source.id} onClose={() => setAddingSchedule(null)}
                      onSuccess={() => { qc.invalidateQueries({ queryKey: ['schedules'] }); setAddingSchedule(null); }} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddScheduleForm({ sourceId, onClose, onSuccess }: { sourceId: string; onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({ name: '', description: '', cronExpression: '0 8 * * *', periodType: 'daily', isEnabled: false });

  const create = useMutation({
    mutationFn: () => authPost('/api/v1/schedules', { ...form, sourceId, isEnabled: form.isEnabled }, 'POST'),
    onSuccess: () => { toast.success('Schedule created'); onSuccess(); },
    onError: () => toast.error('Failed to create schedule'),
  });

  const presets = [
    { label: 'Every day 08:00', cron: '0 8 * * *', period: 'daily' },
    { label: 'Every Monday 09:00', cron: '0 9 * * 1', period: 'weekly' },
    { label: '1st of month 09:00', cron: '0 9 1 * *', period: 'monthly' },
  ];

  return (
    <div className="mt-4 bg-white rounded-lg border border-blue-200 p-4">
      <h4 className="font-medium text-sm text-gray-800 mb-3">New Schedule</h4>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">Name</label>
          <input className="input" placeholder="Daily Sales Report" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
        </div>
        <div>
          <label className="label">Period Type</label>
          <select className="input" value={form.periodType} onChange={e => setForm(p => ({ ...p, periodType: e.target.value }))}>
            <option value="daily">Daily — yesterday's data</option>
            <option value="weekly">Weekly — last 7 days</option>
            <option value="monthly">Monthly — last calendar month</option>
          </select>
        </div>
        <div>
          <label className="label">Cron Expression (UTC)</label>
          <input className="input font-mono" placeholder="0 8 * * *" value={form.cronExpression} onChange={e => setForm(p => ({ ...p, cronExpression: e.target.value }))} />
        </div>
        <div className="col-span-2 flex gap-2">
          {presets.map(p => (
            <button key={p.cron} type="button" className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
              onClick={() => setForm(prev => ({ ...prev, cronExpression: p.cron, periodType: p.period }))}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="col-span-2">
          <label className="label">Description (optional)</label>
          <input className="input" placeholder="Sales metrics for yesterday" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button className="btn-primary" onClick={() => create.mutate()} disabled={!form.name || create.isPending}>
          {create.isPending ? 'Creating...' : 'Create Schedule'}
        </button>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function CredStatusIcon({ cred }: { cred: any }) {
  if (!cred) return <span className="badge-yellow text-xs">No credentials</span>;
  if (cred.isValid === true) return <span className="badge-green flex items-center gap-1"><CheckCircle size={12} />Valid</span>;
  if (cred.isValid === false) return <span className="badge-red flex items-center gap-1"><XCircle size={12} />Invalid</span>;
  return <span className="badge-gray flex items-center gap-1"><AlertCircle size={12} />Untested</span>;
}
