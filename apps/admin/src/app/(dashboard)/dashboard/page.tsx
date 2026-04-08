'use client';
import { useQuery } from '@tanstack/react-query';
import { authFetch } from '@/lib/api';
import { Users, Database, FileText, Activity } from 'lucide-react';

export default function DashboardPage() {
  const { data: users } = useQuery({ queryKey: ['users-count'], queryFn: () => authFetch('/api/v1/users?limit=1') });
  const { data: runs } = useQuery({ queryKey: ['runs-recent'], queryFn: () => authFetch('/api/v1/reports/runs?limit=5') });
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: () => authFetch('/api/v1/sources') });

  const stats = [
    { label: 'Total Users', value: users?.data?.meta?.total ?? '—', icon: Users, color: 'bg-blue-500' },
    { label: 'Active Sources', value: sources?.data?.data?.filter((s: any) => s.isEnabled).length ?? '—', icon: Database, color: 'bg-green-500' },
    { label: 'Report Runs', value: runs?.data?.meta?.total ?? '—', icon: FileText, color: 'bg-purple-500' },
    { label: 'System Status', value: 'Healthy', icon: Activity, color: 'bg-emerald-500' },
  ];

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900 mb-6">Dashboard</h2>
      <div className="grid grid-cols-4 gap-4 mb-8">
        {stats.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-5">
            <div className="flex items-center gap-4">
              <div className={`${color} p-3 rounded-lg`}>
                <Icon size={20} className="text-white" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{label}</p>
                <p className="text-2xl font-bold text-gray-900">{String(value)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="card p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Recent Report Runs</h3>
          {runs?.data?.data?.length === 0 && <p className="text-sm text-gray-500">No runs yet.</p>}
          <div className="space-y-3">
            {runs?.data?.data?.map((run: any) => (
              <div key={run.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium">{new Date(run.periodStart).toLocaleDateString()}</p>
                  <p className="text-xs text-gray-500">
                    {run.triggerType}
                    {run.initiator?.label ? ` · ${run.initiator.label}` : ''}
                  </p>
                </div>
                <StatusBadge status={run.status} />
              </div>
            ))}
          </div>
        </div>

        <div className="card p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Source Health</h3>
          <div className="space-y-3">
            {sources?.data?.data?.map((source: any) => (
              <div key={source.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium">{source.name}</p>
                  <p className="text-xs text-gray-500">{source.type.toUpperCase()}</p>
                </div>
                <div className="flex items-center gap-2">
                  {source.credentials?.isValid === true && <span className="badge-green">✓ Valid</span>}
                  {source.credentials?.isValid === false && <span className="badge-red">✗ Invalid</span>}
                  {source.credentials?.isValid === null && <span className="badge-gray">Not tested</span>}
                  {!source.credentials && <span className="badge-yellow">No creds</span>}
                  {source.isEnabled ? <span className="badge-green">Enabled</span> : <span className="badge-gray">Disabled</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    full_success: 'badge-green',
    partial_success: 'badge-yellow',
    full_failure: 'badge-red',
    running: 'badge-blue',
    pending: 'badge-gray',
  };
  return <span className={map[status] || 'badge-gray'}>{status.replace(/_/g, ' ')}</span>;
}
