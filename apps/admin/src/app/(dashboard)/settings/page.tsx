'use client';
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { authFetch, authPost } from '@/lib/api';
import toast from 'react-hot-toast';
import { Bot, Cpu, Clock, CheckCircle, XCircle, RefreshCw, Globe } from 'lucide-react';

type SettingsField = { key: string; label: string; placeholder?: string; type?: string; hint?: string };
type SettingsSection = { key: string; label: string; icon: any; color: string; bg: string; description: string; fields: SettingsField[] };

const SECTIONS: SettingsSection[] = [
  {
    key: 'telegram',
    label: 'Telegram Bot',
    icon: Bot,
    color: 'text-blue-600',
    bg: 'bg-blue-50',
    description: 'Configure the Telegram bot that delivers reports to subscribers.',
    fields: [
      {
        key: 'telegram.bot_token',
        label: 'Bot Token',
        type: 'password',
        placeholder: '1234567890:ABCDefGhIJKlmNoPQRsTUVwxyZ',
        hint: 'Get from @BotFather → /newbot or /mybots',
      },
      {
        key: 'telegram.admin_chat_id',
        label: 'Admin Chat ID',
        placeholder: '123456789',
        hint: 'Your personal Telegram ID for admin notifications. Get from @userinfobot',
      },
    ],
  },
  {
    key: 'llm',
    label: 'AI / LLM',
    icon: Cpu,
    color: 'text-purple-600',
    bg: 'bg-purple-50',
    description: 'ChatGPT API settings for automatic report analysis.',
    fields: [
      { key: 'llm.api_key', label: 'OpenAI API Key', type: 'password', placeholder: 'sk-...', hint: 'Get from platform.openai.com → API keys' },
      { key: 'llm.default_model', label: 'Model', placeholder: 'gpt-4o-mini', hint: 'Recommended: gpt-4o-mini (cheap) or gpt-4o (best quality)' },
      { key: 'llm.max_tokens', label: 'Max Tokens', placeholder: '4096' },
      { key: 'llm.temperature', label: 'Temperature (0–1)', placeholder: '0.3' },
      { key: 'llm.max_cost_per_run_usd', label: 'Max Cost per Run (USD)', placeholder: '5.00' },
    ],
  },
  {
    key: 'gto',
    label: 'GTO API',
    icon: Globe,
    color: 'text-orange-600',
    bg: 'bg-orange-50',
    description: 'GTO v3 API for currency rates and static reference data (regions, hotels, destinations).',
    fields: [
      {
        key: 'gto.v3_base_url',
        label: 'GTO v3 Base URL',
        placeholder: 'https://api.gto.ua/api/v3',
        hint: 'Used for daily currency rates. API key is taken from the GTO data source credentials.',
      },
      {
        key: 'currency.base',
        label: 'Base Currency',
        placeholder: 'EUR',
        hint: 'All monetary values are converted to this currency before AI analysis.',
      },
    ],
  },
  {
    key: 'scheduler',
    label: 'Report Schedule',
    icon: Clock,
    color: 'text-green-600',
    bg: 'bg-green-50',
    description: 'Cron expressions for automatic report delivery (UTC). Default: 0 8 * * * = every day at 08:00.',
    fields: [
      { key: 'scheduler.gto_cron', label: 'GTO Sales API', placeholder: '0 8 * * *' },
      { key: 'scheduler.ga4_cron', label: 'Google Analytics 4', placeholder: '0 8 * * *' },
      { key: 'scheduler.redmine_cron', label: 'Redmine', placeholder: '0 8 * * *' },
      { key: 'scheduler.youtrack_cron', label: 'YouTrack', placeholder: '0 8 * * *' },
    ],
  },
];

export default function SettingsPage() {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [botStatus, setBotStatus] = useState<{ running: boolean } | null>(null);
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});

  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => authFetch('/api/v1/settings') });

  useEffect(() => {
    if (data?.data?.data) {
      const map: Record<string, string> = {};
      data.data.data.forEach((s: any) => { map[s.key] = s.value; });
      setValues(map);
    }
    if (data?.data?.meta?.botStatus) setBotStatus(data.data.meta.botStatus);
  }, [data]);

  const save = useMutation({
    mutationFn: () => authPost('/api/v1/settings', values, 'PATCH'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); toast.success('Settings saved'); },
  });

  const reloadBot = useMutation({
    mutationFn: () => authPost('/api/v1/settings/reload-bot', {}, 'POST'),
    onSuccess: (res: any) => {
      setBotStatus({ running: true });
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Bot started successfully!');
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error?.message || 'Failed to start bot. Check the token.');
    },
  });

  const handleSaveAndStart = async () => {
    await save.mutateAsync();
    await reloadBot.mutateAsync();
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">System Settings</h2>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {SECTIONS.map(section => {
        const Icon = section.icon;
        const isTelegram = section.key === 'telegram';
        return (
          <div key={section.key} className="card p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-9 h-9 rounded-lg ${section.bg} flex items-center justify-center`}>
                <Icon size={18} className={section.color} />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">{section.label}</h3>
                <p className="text-xs text-gray-500">{section.description}</p>
              </div>
              {isTelegram && (
                <div className="ml-auto flex items-center gap-2">
                  {botStatus?.running ? (
                    <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                      <CheckCircle size={13} /> Running
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-gray-400 font-medium">
                      <XCircle size={13} /> Not running
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-4">
              {section.fields.map(field => (
                <div key={field.key}>
                  <label className="label">{field.label}</label>
                  {field.hint && <p className="text-xs text-gray-400 mb-1">{field.hint}</p>}
                  <div className="relative">
                    <input
                      type={field.type === 'password' && !showTokens[field.key] ? 'password' : 'text'}
                      className="input pr-16"
                      placeholder={field.placeholder}
                      value={values[field.key] || ''}
                      onChange={e => setValues(p => ({ ...p, [field.key]: e.target.value }))}
                    />
                    {field.type === 'password' && (
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
                        onClick={() => setShowTokens(p => ({ ...p, [field.key]: !p[field.key] }))}>
                        {showTokens[field.key] ? 'Hide' : 'Show'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {isTelegram && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="flex gap-2 items-center">
                  <button
                    className="btn-primary flex items-center gap-2"
                    onClick={handleSaveAndStart}
                    disabled={save.isPending || reloadBot.isPending}>
                    <RefreshCw size={14} className={reloadBot.isPending ? 'animate-spin' : ''} />
                    {reloadBot.isPending ? 'Starting...' : 'Save & Start Bot'}
                  </button>
                  <p className="text-xs text-gray-500">
                    Saves token and starts the bot immediately without server restart.
                  </p>
                </div>
                <div className="mt-3 p-3 bg-blue-50 rounded-lg text-xs text-blue-700 space-y-1">
                  <p className="font-medium">How to get a bot token:</p>
                  <p>1. Open Telegram → search <strong>@BotFather</strong></p>
                  <p>2. Send <code>/newbot</code> → follow instructions</p>
                  <p>3. Copy the token and paste it above</p>
                  <p className="font-medium mt-2">How to find your Telegram ID:</p>
                  <p>Open Telegram → search <strong>@userinfobot</strong> → send any message</p>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
