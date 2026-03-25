'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';
import { UserPlus, ChevronDown, ChevronUp } from 'lucide-react';

export default function UsersPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['users', statusFilter],
    queryFn: () => authFetch(`/api/v1/users${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  const { data: sourcesData } = useQuery({
    queryKey: ['sources'],
    queryFn: () => authFetch('/api/v1/sources'),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authPost(`/api/v1/users/${id}/status`, { status }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast.success('User updated'); },
    onError: (e: any) => toast.error(e.response?.data?.error?.message || 'Failed'),
  });

  const users = data?.data?.data || [];
  const sources = sourcesData?.data?.data || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">Users</h2>
        <div className="flex gap-2">
          <div className="flex gap-1">
            {['', 'pending', 'approved', 'blocked'].map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}>
                {s || 'All'}
              </button>
            ))}
          </div>
          <button className="btn-primary flex items-center gap-2" onClick={() => setShowAddModal(true)}>
            <UserPlus size={15} /> Add User
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Name', 'Username', 'Telegram ID', 'Status', 'Reports', 'Joined', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500">No users found</td></tr>
              )}
              {users.map((user: any) => (
                <>
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium">
                      {user.firstName || user.lastName
                        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{user.username ? `@${user.username}` : '—'}</td>
                    <td className="px-4 py-3 text-sm font-mono text-gray-600">{user.telegramId}</td>
                    <td className="px-4 py-3"><StatusBadge status={user.status} /></td>
                    <td className="px-4 py-3">
                      <span className={user.globalReportsEnabled ? 'badge-green' : 'badge-gray'}>
                        {user.globalReportsEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">{new Date(user.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1 items-center">
                        {user.status === 'pending' && (
                          <button className="btn btn-sm btn-success" onClick={() => updateStatus.mutate({ id: user.id, status: 'approved' })}>Approve</button>
                        )}
                        {user.status === 'approved' && (
                          <button className="btn btn-sm btn-danger" onClick={() => updateStatus.mutate({ id: user.id, status: 'blocked' })}>Block</button>
                        )}
                        {user.status === 'blocked' && (
                          <button className="btn btn-sm btn-secondary" onClick={() => updateStatus.mutate({ id: user.id, status: 'approved' })}>Unblock</button>
                        )}
                        {user.status !== 'deleted' && (
                          <button className="btn btn-sm btn-danger" onClick={() => { if (confirm('Delete?')) updateStatus.mutate({ id: user.id, status: 'deleted' }); }}>Delete</button>
                        )}
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => setExpandedId(expandedId === user.id ? null : user.id)}>
                          {expandedId === user.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === user.id && (
                    <tr key={`${user.id}-expand`}>
                      <td colSpan={7} className="bg-gray-50 px-6 py-4 border-b border-gray-100">
                        <UserPreferences userId={user.id} sources={sources} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAddModal && <AddUserModal onClose={() => setShowAddModal(false)} onSuccess={() => { qc.invalidateQueries({ queryKey: ['users'] }); setShowAddModal(false); }} />}
    </div>
  );
}

function UserPreferences({ userId, sources }: { userId: string; sources: any[] }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['user-prefs', userId],
    queryFn: () => authFetch(`/api/v1/users/${userId}/preferences`),
  });

  const toggleGlobal = useMutation({
    mutationFn: (enabled: boolean) => authPost(`/api/v1/users/${userId}/reports`, { globalReportsEnabled: enabled }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast.success('Updated'); },
  });

  const toggleSource = useMutation({
    mutationFn: ({ sourceId, enabled }: { sourceId: string; enabled: boolean }) =>
      authPost(`/api/v1/users/${userId}/preferences/${sourceId}`, { reportsEnabled: enabled }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user-prefs', userId] }); toast.success('Updated'); },
  });

  const prefs = data?.data?.data || [];
  const prefMap: Record<string, boolean> = {};
  prefs.forEach((p: any) => { prefMap[p.sourceId] = p.reportsEnabled; });

  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Report Subscriptions</p>
      <div className="flex flex-wrap gap-2">
        {sources.map((source: any) => {
          const enabled = prefMap[source.id] ?? true;
          return (
            <button
              key={source.id}
              onClick={() => toggleSource.mutate({ sourceId: source.id, enabled: !enabled })}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                enabled
                  ? 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100'
                  : 'bg-gray-100 border-gray-200 text-gray-400 hover:bg-gray-200'
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-blue-500' : 'bg-gray-300'}`} />
              {source.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AddUserModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [form, setForm] = useState({ telegramId: '', firstName: '', lastName: '', username: '', status: 'approved' });

  const create = useMutation({
    mutationFn: () => authPost('/api/v1/users', form, 'POST'),
    onSuccess: () => { toast.success('User added and approved'); onSuccess(); },
    onError: (e: any) => toast.error(e?.response?.data?.error?.message || 'Failed to add user'),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Add User</h3>
        <p className="text-sm text-gray-500 mb-4">Manually add a subscriber by their Telegram ID.</p>

        <div className="space-y-3">
          <div>
            <label className="label">Telegram ID <span className="text-red-500">*</span></label>
            <p className="text-xs text-gray-400 mb-1">Ask the user to send any message to @userinfobot</p>
            <input className="input" placeholder="123456789" value={form.telegramId}
              onChange={e => setForm(p => ({ ...p, telegramId: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First Name</label>
              <input className="input" placeholder="Ivan" value={form.firstName}
                onChange={e => setForm(p => ({ ...p, firstName: e.target.value }))} />
            </div>
            <div>
              <label className="label">Last Name</label>
              <input className="input" placeholder="Petrov" value={form.lastName}
                onChange={e => setForm(p => ({ ...p, lastName: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="label">Username (without @)</label>
            <input className="input" placeholder="ivanpetrov" value={form.username}
              onChange={e => setForm(p => ({ ...p, username: e.target.value }))} />
          </div>
          <div>
            <label className="label">Initial Status</label>
            <select className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
              <option value="approved">Approved — starts receiving reports immediately</option>
              <option value="pending">Pending — needs manual approval</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button className="btn-primary flex-1" onClick={() => create.mutate()} disabled={!form.telegramId || create.isPending}>
            {create.isPending ? 'Adding...' : 'Add User'}
          </button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { pending: 'badge-yellow', approved: 'badge-green', blocked: 'badge-red', deleted: 'badge-gray' };
  return <span className={map[status] || 'badge-gray'}>{status}</span>;
}
