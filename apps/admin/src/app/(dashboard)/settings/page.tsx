'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';

export default function SettingsPage() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});

  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => authFetch('/api/v1/settings') });

  useEffect(() => {
    if (data?.data?.data) {
      const map: Record<string, string> = {};
      data.data.data.forEach((s: any) => { map[s.key] = s.value; });
      setValues(map);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => authPost('/api/v1/settings', values, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); toast.success('Settings saved'); },
  });

  const settings = data?.data?.data || [];

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">System Settings</h2>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
      <div className="card p-6 space-y-4">
        {settings.map((s: any) => (
          <div key={s.key}>
            <label className="label">{s.key}</label>
            {s.description && <p className="text-xs text-gray-500 mb-1">{s.description}</p>}
            <input className="input" value={values[s.key] || ''} onChange={e => setValues(p => ({ ...p, [s.key]: e.target.value }))} />
          </div>
        ))}
      </div>
    </div>
  );
}
