import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Cloud,
  Loader2,
  Plus,
  Send,
  Sparkles,
  User as UserIcon,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { parseJsonResponse } from '../lib/derivClient.ts';
import {
  appendChatMessage,
  subscribeChatMessages,
  subscribeChatSessions,
  upsertChatSession,
} from '../lib/firebase.ts';
import type {
  ChatRolePreset,
  CloudChatSession,
  GeminiChatMessage,
} from '../shared/types.ts';

interface GeminiChatDrawerProps {
  open: boolean;
  activeSymbol: string;
  onClose: () => void;
}

const ROLE_PRESETS: {
  id: ChatRolePreset;
  label: string;
  modelLabel: string;
  modelId: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  desc: string;
}[] = [
  {
    id: 'architect',
    label: 'Strategy Architect',
    modelLabel: '4 Hydrogen · XHIGH',
    modelId: 'gemini-4-hydrogen',
    desc: 'Deep reasoning bot logic & EV engineering',
  },
  {
    id: 'dtrader',
    label: 'DTrader Tactician',
    modelLabel: '4 Hydrogen · HIGH',
    modelId: 'gemini-4-hydrogen',
    desc: '7-gate Markov & zero-loss sniper entries',
  },
  {
    id: 'scanner',
    label: '1,000t Analyst',
    modelLabel: '4 Hydrogen · MED',
    modelId: 'gemini-4-hydrogen',
    desc: 'Live 1,000-tick regime & Dual-Z breakdown',
  },
  {
    id: 'fast',
    label: 'Fast Triage',
    modelLabel: '3.1 Flash-Lite',
    modelId: 'gemini-3.1-flash-lite',
    desc: 'Sub-second check & concise quick answers',
  },
];

const QUICK_PROMPTS = [
  'Analyze the live 1,000-tick regime & coldest Markov digit right now.',
  'How do all 7 Master DTrader gates filter losing setups?',
  'Design a 2-step capped Digit Differ strategy for Volatility 25.',
];

export function GeminiChatDrawer({ open, activeSymbol, onClose }: GeminiChatDrawerProps) {
  const { user, signInWithGoogle, authBusy } = useAuth();
  const [rolePreset, setRolePreset] = useState<ChatRolePreset>('architect');
  const [includeTelemetry, setIncludeTelemetry] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cloudSessions, setCloudSessions] = useState<CloudChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>(() => `chat_${Date.now()}`);
  const [localMessages, setLocalMessages] = useState<GeminiChatMessage[]>([]);
  const [cloudMessages, setCloudMessages] = useState<GeminiChatMessage[]>([]);

  const endRef = useRef<HTMLDivElement>(null);

  // Subscribe to Cloud chat sessions when authenticated with Google
  useEffect(() => {
    if (!user) {
      setCloudSessions([]);
      return;
    }
    const unsub = subscribeChatSessions(user.uid, (sessions) => {
      setCloudSessions(sessions);
    });
    return () => unsub();
  }, [user]);

  // Subscribe to Cloud messages for activeChatId when authenticated
  useEffect(() => {
    if (!user || !activeChatId) {
      setCloudMessages([]);
      return;
    }
    const unsub = subscribeChatMessages(user.uid, activeChatId, (msgs) => {
      setCloudMessages(msgs);
    });
    return () => unsub();
  }, [activeChatId, user]);

  const messages = user && cloudMessages.length > 0 ? cloudMessages : localMessages;

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, open]);

  if (!open) return null;

  const activePresetMeta =
    ROLE_PRESETS.find((r) => r.id === rolePreset) ?? ROLE_PRESETS[0];

  const handleNewThread = () => {
    const nextId = `chat_${Date.now()}`;
    setActiveChatId(nextId);
    setLocalMessages([]);
    setCloudMessages([]);
    setError(null);
  };

  const handleSend = async (customText?: string) => {
    const trimmed = (customText ?? input).trim();
    if (!trimmed || sending) return;

    setInput('');
    setError(null);
    setSending(true);

    const userMsg: GeminiChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: trimmed,
      modelUsed: activePresetMeta.modelId,
      createdAt: Date.now(),
    };
    const nextLocal = [...messages, userMsg];
    setLocalMessages(nextLocal);

    try {
      if (user) {
        await upsertChatSession(user.uid, {
          chatId: activeChatId,
          title: trimmed.slice(0, 60),
          rolePreset,
          model: activePresetMeta.modelId,
          activeSymbol,
        });
        await appendChatMessage(user.uid, activeChatId, {
          role: 'user',
          content: trimmed,
          modelUsed: activePresetMeta.modelId,
        });
      }

      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          symbol: activeSymbol,
          rolePreset,
          includeLiveTelemetry: includeTelemetry,
          history: nextLocal.slice(-14).map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await parseJsonResponse<{
        reply?: string;
        modelUsed?: string;
        error?: string;
      }>(res, 'Chat request failed');
      if (!res.ok) {
        throw new Error(data.error || 'Chat request failed');
      }

      const replyText = data.reply || 'No response returned.';
      const modelUsed = data.modelUsed || activePresetMeta.modelId;

      if (user) {
        await appendChatMessage(user.uid, activeChatId, {
          role: 'assistant',
          content: replyText,
          modelUsed,
        });
      } else {
        setLocalMessages((prev) => [
          ...prev,
          {
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: replyText,
            modelUsed,
            createdAt: Date.now(),
          },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach AI Quant Chat.');
    } finally {
      setSending(false);
    }
  };

  return (
    <aside
      aria-label="Gemini Quant Chat Assistant"
      className="fixed top-[52px] right-0 bottom-7 w-full max-w-[430px] z-40 bg-white dark:bg-[#0F172A] border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 bg-slate-50/70 dark:bg-slate-900/60">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-md bg-[#0E5A78] text-white flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100 truncate">
              AI Quant Architect Chat
            </h2>
            <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
              {activePresetMeta.modelLabel} · {activeSymbol}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleNewThread}
            title="New conversation"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3 h-3" />
            <span>New</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI Chat"
            className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Role Preset Selector + Cloud Thread Bar */}
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 space-y-2 bg-white dark:bg-[#0F172A]">
        <div className="grid grid-cols-2 gap-1.5">
          {ROLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => setRolePreset(preset.id)}
              className={`text-left px-2.5 py-1.5 rounded border text-[11px] cursor-pointer transition-colors ${
                rolePreset === preset.id
                  ? 'border-[#0E5A78] bg-sky-50/70 dark:bg-sky-950/30 text-slate-900 dark:text-slate-100 font-semibold'
                  : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              <div className="truncate">{preset.label}</div>
              <div className="text-[10px] font-mono text-slate-400 truncate">
                {preset.modelLabel}
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px]">
          <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-600 dark:text-slate-300 font-medium">
            <input
              type="checkbox"
              checked={includeTelemetry}
              onChange={(e) => setIncludeTelemetry(e.target.checked)}
              className="rounded border-slate-400 text-[#0E5A78]"
            />
            <span>Inject live 1,000t {activeSymbol} data</span>
          </label>

          {user ? (
            <div className="flex items-center gap-1 text-teal-600 dark:text-teal-400 font-semibold">
              <Cloud className="w-3.5 h-3.5" />
              <span>Cloud Sync</span>
            </div>
          ) : (
            <button
              type="button"
              disabled={authBusy}
              onClick={() => void signInWithGoogle()}
              className="text-[#0E5A78] dark:text-[#00A8E8] font-semibold hover:underline cursor-pointer"
            >
              Sign in Google to Sync
            </button>
          )}
        </div>

        {user && cloudSessions.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto studio-scroll pt-0.5">
            {cloudSessions.slice(0, 6).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setActiveChatId(s.id);
                  setRolePreset(s.rolePreset);
                }}
                className={`px-2 py-0.5 rounded text-[10px] border max-w-[135px] truncate cursor-pointer shrink-0 ${
                  s.id === activeChatId
                    ? 'border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-800 dark:text-teal-200 font-semibold'
                    : 'border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {s.title}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable Message Thread */}
      <div className="flex-1 min-h-0 overflow-y-auto studio-scroll p-4 space-y-3 bg-slate-50/50 dark:bg-[#090D16]/60">
        {messages.length === 0 ? (
          <div className="space-y-3 pt-4">
            <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-2">
              <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                Ready · {activePresetMeta.label}
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                {activePresetMeta.desc}. Ask about 1,000-tick Markov probabilities, 7-gate DTrader entries, or Bot Builder risk optimization.
              </p>
            </div>
            <div className="space-y-1.5">
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void handleSend(q)}
                  className="w-full text-left px-3 py-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A] hover:border-[#0E5A78] text-xs text-slate-700 dark:text-slate-300 cursor-pointer transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-[#0E5A78] text-white flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-3.5 h-3.5" />
                </div>
              )}
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                  msg.role === 'user'
                    ? 'bg-[#0E5A78] text-white'
                    : 'bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                }`}
              >
                {msg.content}
                {msg.role === 'assistant' && (
                  <div className="mt-1.5 pt-1 border-t border-slate-100 dark:border-slate-800 text-[10px] font-mono text-slate-400">
                    {msg.modelUsed}
                  </div>
                )}
              </div>
              {msg.role === 'user' && (
                <div className="w-6 h-6 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 flex items-center justify-center shrink-0 mt-0.5">
                  <UserIcon className="w-3.5 h-3.5" />
                </div>
              )}
            </div>
          ))
        )}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0E5A78]" />
            <span>Evaluating 1,000-tick quant response...</span>
          </div>
        )}

        {error && (
          <div className="rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 p-2.5 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Pinned Bottom Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
        className="p-3 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A] flex items-end gap-2"
      >
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={`Ask ${activePresetMeta.label} about ${activeSymbol}...`}
          className="flex-1 resize-none rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-[#0E5A78]"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="px-3.5 py-2.5 rounded-md bg-[#0E5A78] hover:bg-[#0B4861] disabled:opacity-50 text-white text-xs font-bold cursor-pointer shrink-0 inline-flex items-center gap-1"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </aside>
  );
}
