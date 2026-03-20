'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';

export default function UsersPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['users', statusFilter],
    queryFn: () => authFetch(`/api/v1/users${statusFilter ? `?status=${statusFilter}` : ''}`),
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authPost(`/api/v1/users/${id}/status`, { status }, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); toast.success('User status updated'); },
    onError: (e: any) => toast.error(e.response?.data?.error?.message || 'Failed to update status'),
  });

  const users = data?.data?.data || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-gray-900">Users</h2>
        <div className="flex gap-2">
          {['', 'pending', 'approved', 'blocked'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}>
              {s || 'All'}
            </button>
          ))}
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
                <tr key={user.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium">{user.firstName || user.lastName ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '—'}</td>
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
                    <div className="flex gap-1">
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
                        <button className="btn btn-sm btn-danger" onClick={() => { if (confirm('Delete this user?')) updateStatus.mutate({ id: user.id, status: 'deleted' }); }}>Delete</button>
                      )}
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { pending: 'badge-yellow', approved: 'badge-green', blocked: 'badge-red', deleted: 'badge-gray' };
  return <span className={map[status] || 'badge-gray'}>{status}</span>;
}
