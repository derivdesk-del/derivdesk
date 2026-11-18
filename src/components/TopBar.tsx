import { useState, useRef, useEffect } from 'react';
import {
  Check,
  ChevronDown,
  Cloud,
  FileText,
  LogIn,
  LogOut,
  MessageSquare,
  Play,
  RotateCcw,
  Square,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import type { DerivAuthSession, TickPoint } from '../shared/types.ts';

interface TopBarProps {
  latestTick: TickPoint | null;
  previousTick: TickPoint | null;
  activeSymbolName: string;
  balance: number | null;
  currency: string;
  isRunning: boolean;
  statusMessage: string;
  derivSession: DerivAuthSession;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  onToggleRun: () => void;
  onOpenReports: () => void;
  onResetDemoBalance: () => void;
  onOpenLogin: () => void;
  onLogout: () => void;
  onSwitchAccount: (accountId: string) => void;
}

export function TopBar({
  latestTick,
  previousTick,
  activeSymbolName,
  balance,
  currency,
  isRunning,
  statusMessage,
  derivSession,
  chatOpen = false,
  onToggleChat,
  onToggleRun,
  onOpenReports,
  onResetDemoBalance,
  onOpenLogin,
  onLogout,
  onSwitchAccount,
}: TopBarProps) {
  const { user, authBusy, signInWithGoogle, signOut } = useAuth();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [cloudMenuOpen, setCloudMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const cloudRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
      if (cloudRef.current && !cloudRef.current.contains(e.target as Node)) {
        setCloudMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const priceDirection =
    latestTick && previousTick
      ? latestTick.quote > previousTick.quote
        ? 'up'
        : latestTick.quote < previousTick.quote
          ? 'down'
          : 'flat'
      : 'flat';

  const accountLabel = derivSession.authenticated
    ? derivSession.activeAccountType === 'real'
      ? `Real · ${derivSession.activeAccountId}`
      : `Demo · ${derivSession.activeAccountId}`
    : 'Deriv Account';

  return (
    <header className="h-[52px] shrink-0 bg-white dark:bg-[#0F172A] border-b border-slate-200 dark:border-slate-800 px-4 flex items-center justify-between gap-4 select-none z-30">
      {/* Left: Brand, Reports, Live Market Price */}
      <div className="flex items-center gap-6 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-md bg-[#0E5A78] flex items-center justify-center text-white font-display font-bold text-sm tracking-tight">
            D
          </div>
          <span className="font-display font-bold text-lg tracking-tight text-[#00A8E8] whitespace-nowrap">
            DerivDesk
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenReports}
          className="flex items-center gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <FileText className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span>Reports</span>
        </button>

        <div
          className="hidden sm:flex items-baseline gap-2 shrink-0"
          title={`${activeSymbolName} Live Spot`}
        >
          <span
            className={`font-mono text-base font-bold tabular-nums transition-colors ${
              priceDirection === 'up'
                ? 'text-emerald-600 dark:text-emerald-400'
                : priceDirection === 'down'
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {latestTick ? latestTick.formattedQuote.slice(0, -1) : '—'}
            <span className="text-lg font-extrabold underline decoration-sky-500/60 underline-offset-4">
              {latestTick ? latestTick.formattedQuote.slice(-1) : ''}
            </span>
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
            {activeSymbolName}
          </span>
        </div>
      </div>

      {/* Right: AI Chat, Google Cloud Sync, Deriv Account Balance / Login, Run Button */}
      <div className="flex items-center gap-2.5 shrink-0">
        {onToggleChat && (
          <button
            type="button"
            onClick={onToggleChat}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              chatOpen
                ? 'border-[#0E5A78] bg-sky-50 dark:bg-sky-950/40 text-[#0E5A78] dark:text-[#00A8E8]'
                : 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
            <span>AI Quant Chat</span>
          </button>
        )}

        <div className="relative hidden md:block" ref={cloudRef}>
          {user ? (
            <>
              <button
                type="button"
                onClick={() => setCloudMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-teal-200 dark:border-teal-800 bg-teal-50/70 dark:bg-teal-950/30 text-teal-800 dark:text-teal-200 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Cloud className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                <span className="max-w-[110px] truncate">
                  {user.displayName || 'Cloud Sync'}
                </span>
                <ChevronDown className="w-3 h-3" />
              </button>
              {cloudMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-60 rounded-lg bg-white dark:bg-[#1E293B] border border-slate-200 dark:border-slate-700 shadow-lg p-3 z-50 space-y-2 text-xs">
                  <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {user.displayName || 'Quant Trader'}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">{user.email}</div>
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={() => {
                      void signOut();
                      setCloudMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-semibold cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sign out Google</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={authBusy}
              onClick={() => void signInWithGoogle()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Cloud className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
              <span>{authBusy ? 'Signing in...' : 'Google Sync'}</span>
            </button>
          )}
        </div>

        {derivSession.authenticated ? (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setAccountMenuOpen((o) => !o)}
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors cursor-pointer"
            >
              <div className="w-7 h-7 rounded-full bg-teal-50 dark:bg-teal-950/60 border border-teal-200 dark:border-teal-800 flex items-center justify-center text-teal-700 dark:text-teal-300">
                <Wallet className="w-3.5 h-3.5" />
              </div>
              <div className="text-left leading-tight">
                <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  <span className="max-w-[140px] truncate">{accountLabel}</span>
                  <ChevronDown className="w-3 h-3 shrink-0" />
                </div>
                <div className="font-mono text-sm font-bold text-teal-600 dark:text-teal-400 tabular-nums whitespace-nowrap">
                  {(balance ?? 0).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  {currency}
                </div>
              </div>
            </button>

            {accountMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-72 rounded-lg bg-white dark:bg-[#1E293B] border border-slate-200 dark:border-slate-700 shadow-lg p-3 z-50 space-y-2.5">
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-between">
                  <span>Connected Deriv Accounts</span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {derivSession.appId}
                  </span>
                </div>
                <div className="space-y-1 max-h-44 overflow-y-auto studio-scroll">
                  {derivSession.accounts.map((acc) => {
                    const isCurrent = acc.accountId === derivSession.activeAccountId;
                    return (
                      <button
                        key={acc.accountId}
                        type="button"
                        onClick={() => {
                          onSwitchAccount(acc.accountId);
                          setAccountMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-2 rounded text-xs cursor-pointer ${
                          isCurrent
                            ? 'bg-sky-50 dark:bg-sky-950/50 text-sky-900 dark:text-sky-100 font-semibold'
                            : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {isCurrent ? (
                            <Check className="w-3.5 h-3.5 text-[#00A8E8]" />
                          ) : (
                            <span className="w-3.5" />
                          )}
                          <span className="capitalize">{acc.accountType}</span>
                          <span className="font-mono text-[11px] text-slate-500">
                            {acc.accountId}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums">
                          {acc.balance.toFixed(2)} {acc.currency}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {derivSession.activeAccountType === 'demo' && (
                  <button
                    type="button"
                    onClick={() => {
                      onResetDemoBalance();
                      setAccountMenuOpen(false);
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset Deriv Demo Balance</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={onOpenLogin}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign in with API Token</span>
          </button>
        )}

        {derivSession.authenticated && (
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Log out</span>
          </button>
        )}

        <div className="flex items-center rounded-md overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
          <button
            type="button"
            onClick={onToggleRun}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-bold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isRunning
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-[#389E94] hover:bg-[#2F877E]'
            }`}
          >
            {isRunning ? (
              <>
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Stop</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Run</span>
              </>
            )}
          </button>

          <div className="px-3.5 py-1.5 min-w-[140px] flex flex-col justify-center">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap truncate max-w-[160px]">
              {statusMessage}
            </div>
            <div className="mt-1 h-1 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  isRunning ? 'w-full bg-teal-500' : 'w-0 bg-slate-400'
                }`}
              />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
