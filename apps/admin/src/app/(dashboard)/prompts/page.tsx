'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';
import { Copy } from 'lucide-react';

export default function PromptsPage() {
  const qc = useQueryClient();
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [newVersion, setNewVersion] = useState({ systemPrompt: '', userPrompt: '' });

  const { data } = useQuery({ queryKey: ['prompts'], queryFn: () => authFetch('/api/v1/prompts') });

  const loadVersions = async (template: any) => {
    setSelectedTemplate(template);
    setShowNewVersion(false);
    const res = await authFetch(`/api/v1/prompts/${template.id}/versions`);
    setVersions(res.data?.data || []);
  };

  const openNewVersion = () => {
    const active = versions.find(v => v.isActive);
    setNewVersion({
      systemPrompt: active?.systemPrompt || '',
      userPrompt: active?.userPrompt || '',
    });
    setShowNewVersion(true);
  };

  const createVersion = useMutation({
    mutationFn: () => authPost(`/api/v1/prompts/${selectedTemplate.id}/versions`, { systemPrompt: newVersion.systemPrompt, userPrompt: newVersion.userPrompt }, 'POST'),
    onSuccess: () => { loadVersions(selectedTemplate); toast.success('Version created and activated'); setShowNewVersion(false); },
  });

  const activateVersion = useMutation({
    mutationFn: (vid: string) => authPost(`/api/v1/prompts/${selectedTemplate.id}/versions/${vid}/activate`, {}, 'POST'),
    onSuccess: () => { loadVersions(selectedTemplate); toast.success('Version activated'); },
  });

  const templates = data?.data?.data || [];
  const activeVersion = versions.find(v => v.isActive);

  return (
    <div className="flex gap-6">
      <div className="w-64 flex-shrink-0">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Prompts</h2>
        <div className="space-y-2">
          {templates.map((t: any) => (
            <button key={t.id} onClick={() => loadVersions(t)}
              className={`w-full text-left card p-3 hover:bg-blue-50 transition-colors ${selectedTemplate?.id === t.id ? 'ring-2 ring-blue-500' : ''}`}>
              <p className="font-medium text-sm">{t.name}</p>
              <p className="text-xs text-gray-500 mt-1">{t.source?.name}</p>
            </button>
          ))}
        </div>
      </div>

      {selectedTemplate && (
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-lg">{selectedTemplate.name}</h3>
            <button className="btn-primary btn-sm" onClick={openNewVersion}>+ New Version</button>
          </div>

          {showNewVersion && (
            <div className="card p-5 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-medium">New Prompt Version</h4>
                {activeVersion && (
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <Copy size={11} /> Pre-filled from active v{activeVersion.versionNumber}
                  </span>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <label className="label">System Prompt</label>
                  <textarea
                    className="input font-mono text-xs"
                    style={{ height: '140px' }}
                    value={newVersion.systemPrompt}
                    onChange={e => setNewVersion(p => ({ ...p, systemPrompt: e.target.value }))}
                    placeholder="You are a..."
                  />
                </div>
                <div>
                  <label className="label">User Prompt</label>
                  <p className="text-xs text-gray-400 mb-1">
                    Variables: {'{{report_period_start}}'}, {'{{report_period_end}}'}, {'{{source_name}}'}, {'{{normalized_metrics_json}}'}
                  </p>
                  <textarea
                    className="input font-mono text-xs"
                    style={{ height: '280px' }}
                    value={newVersion.userPrompt}
                    onChange={e => setNewVersion(p => ({ ...p, userPrompt: e.target.value }))}
                    placeholder="Analyze data for {{report_period_start}}..."
                  />
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary btn-sm" onClick={() => createVersion.mutate()} disabled={createVersion.isPending}>
                    {createVersion.isPending ? 'Creating...' : 'Create & Activate'}
                  </button>
                  <button className="btn-secondary btn-sm" onClick={() => setShowNewVersion(false)}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {versions.map((v: any) => (
              <div key={v.id} className="card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">v{v.versionNumber}</span>
                    {v.isActive && <span className="badge-green">Active</span>}
                    <span className="text-xs text-gray-400">{new Date(v.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn-secondary btn-sm flex items-center gap-1"
                      onClick={() => { setNewVersion({ systemPrompt: v.systemPrompt, userPrompt: v.userPrompt }); setShowNewVersion(true); window.scrollTo(0, 0); }}
                    >
                      <Copy size={12} /> Edit (new version)
                    </button>
                    {!v.isActive && (
                      <button className="btn-primary btn-sm" onClick={() => activateVersion.mutate(v.id)}>Activate</button>
                    )}
                  </div>
                </div>
                <details>
                  <summary className="text-xs text-blue-600 cursor-pointer">View prompts</summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">SYSTEM</p>
                      <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-32 whitespace-pre-wrap">{v.systemPrompt}</pre>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">USER</p>
                      <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap">{v.userPrompt}</pre>
                    </div>
                  </div>
                </details>
              </div>
            ))}
            {versions.length === 0 && <p className="text-sm text-gray-500">No versions yet.</p>}
          </div>
        </div>
      )}

      {!selectedTemplate && (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          <p>Select a prompt template to manage versions</p>
        </div>
      )}
    </div>
  );
}
