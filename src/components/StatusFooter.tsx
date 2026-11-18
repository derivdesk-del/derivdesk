import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import type { FeedStatus } from '../shared/types.ts';

interface StatusFooterProps {
  feedStatus: FeedStatus;
  activeSymbol: string;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function StatusFooter({
  feedStatus,
  activeSymbol,
  isDark,
  onToggleTheme,
}: StatusFooterProps) {
  const [gmtString, setGmtString] = useState<string>(() => formatGmt(new Date()));

  useEffect(() => {
    const id = window.setInterval(() => {
      setGmtString(formatGmt(new Date()));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <footer className="h-[28px] shrink-0 bg-white dark:bg-[#0F172A] border-t border-slate-200 dark:border-slate-800 px-3 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400 select-none">
      <div className="flex items-center gap-2 min-w-0 truncate">
        <span className="font-mono font-medium text-slate-700 dark:text-slate-300">
          {activeSymbol}
        </span>
        <span aria-hidden="true">·</span>
        <span className="truncate">
          {feedStatus.connected
            ? feedStatus.source === 'deriv-ws'
              ? 'Deriv WebSocket Live Feed'
              : 'Live Stochastic Market Replay'
            : 'Connecting to market feed...'}
        </span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-1.5">
          <span
            aria-label={feedStatus.connected ? 'Feed connected' : 'Feed reconnecting'}
            className={`w-2 h-2 rounded-full ${
              feedStatus.connected ? 'bg-teal-500' : 'bg-amber-500'
            }`}
          />
          <span className="font-mono tabular-nums">{gmtString}</span>
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
        >
          {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        </button>
      </div>
    </footer>
  );
}

function formatGmt(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} GMT`;
}
