'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';
import { CheckCircle, XCircle, AlertCircle, Settings2 } from 'lucide-react';

export default function SourcesPage() {
  const qc = useQueryClient();
  const [editingCreds, setEditingCreds] = useState<string | null>(null);
  const [credInputs, setCredInputs] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sources'],
    queryFn: () => authFetch('/api/v1/sources'),
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      authPost(`/api/v1/sources/${id}`, { isEnabled }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); toast.success('Source updated'); },
  });

  const saveCreds = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authPost(`/api/v1/sources/${id}/credentials`, credInputs, 'PUT'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); toast.success('Credentials saved'); setEditingCreds(null); setCredInputs({}); },
    onError: (e: any) => toast.error('Failed to save credentials'),
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

  const sources = data?.data?.data || [];

  const credentialFields: Record<string, { key: string; label: string; type?: string }[]> = {
    gto: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'base_url', label: 'Base URL' },
      { key: 'timezone', label: 'Timezone (e.g. UTC)' },
    ],
    ga4: [
      { key: 'ga_property_id', label: 'GA4 Property ID (numeric)' },
      { key: 'service_account_json', label: 'Service Account JSON', type: 'textarea' },
    ],
    redmine: [
      { key: 'redmine_base_url', label: 'Redmine Base URL' },
      { key: 'redmine_api_key', label: 'API Key', type: 'password' },
      { key: 'default_project_id', label: 'Default Project ID (optional)' },
    ],
  };

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-6">Data Sources</h2>
      <div className="space-y-4">
        {isLoading && <div className="card p-8 text-center text-gray-500">Loading...</div>}
        {sources.map((source: any) => (
          <div key={source.id} className="card p-5">
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
                <button
                  className={`btn btn-sm ${source.isEnabled ? 'btn-danger' : 'btn-success'}`}
                  onClick={() => toggleEnabled.mutate({ id: source.id, isEnabled: !source.isEnabled })}>
                  {source.isEnabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn btn-sm btn-secondary" onClick={() => testConnection(source.id)} disabled={testingId === source.id}>
                  {testingId === source.id ? 'Testing...' : 'Test'}
                </button>
                <button className="btn btn-sm btn-primary" onClick={() => { setEditingCreds(source.id); setCredInputs({}); }}>
                  Credentials
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
        ))}
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
