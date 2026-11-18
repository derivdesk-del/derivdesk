import { useMemo, useState } from 'react';
import { Download, KeyRound, ShieldCheck } from 'lucide-react';
import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  BotStats,
  JournalEntry,
  PreTradeSignalVerdict,
  RightTabId,
  TickPoint,
  TradeTransaction,
} from '../../shared/types.ts';

interface RightTelemetryPanelProps {
  activeTab: RightTabId;
  onSelectTab: (tab: RightTabId) => void;
  stats: BotStats;
  transactions: TradeTransaction[];
  journal: JournalEntry[];
  isRunning: boolean;
  latestTick: TickPoint | null;
  latestVerdict?: PreTradeSignalVerdict | null;
  authenticated?: boolean;
  currency?: string;
  lastError?: string | null;
  onOpenLogin?: () => void;
  onSellContract?: (contractId: string) => void;
  onReset: () => void;
}

export function RightTelemetryPanel({
  activeTab,
  onSelectTab,
  stats,
  transactions,
  journal,
  isRunning,
  latestTick,
  latestVerdict = null,
  authenticated = false,
  currency = 'USD',
  lastError = null,
  onOpenLogin,
  onSellContract,
  onReset,
}: RightTelemetryPanelProps) {
  const [journalFilter, setJournalFilter] = useState<'all' | 'success' | 'warning'>('all');
  const [showStatsInfo, setShowStatsInfo] = useState(false);

  const equityData = useMemo(() => {
    const settled = [...transactions].reverse().filter((t) => t.status !== 'open');
    let cumulative = 0;
    return settled.map((t, idx) => {
      cumulative = Number((cumulative + t.profit).toFixed(2));
      return {
        run: idx + 1,
        pnl: cumulative,
        tradePnl: t.profit,
      };
    });
  }, [transactions]);

  const filteredJournal = useMemo(() => {
    if (journalFilter === 'all') return journal;
    if (journalFilter === 'success') return journal.filter((j) => j.level === 'success');
    return journal.filter((j) => j.level === 'warning' || j.level === 'error');
  }, [journal, journalFilter]);

  const exportCsv = () => {
    const headers = ['RefID', 'Time', 'Symbol', 'Contract', 'Entry', 'Exit', 'Stake', 'Payout', 'Profit', 'Status'];
    const rows = transactions.map((t) => [
      t.refId,
      new Date(t.timestamp).toISOString(),
      t.symbol,
      t.contractType,
      t.entrySpot,
      t.exitSpot,
      t.stake.toFixed(2),
      t.payout.toFixed(2),
      t.profit.toFixed(2),
      t.status,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `derivdesk-transactions-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <aside className="w-[360px] shrink-0 bg-white dark:bg-[#0F172A] border-l border-slate-200 dark:border-slate-800 flex flex-col min-h-0 select-none">
      {/* Top 3-tab strip */}
      <div className="grid grid-cols-3 border-b border-slate-200 dark:border-slate-800">
        {(
          [
            { id: 'summary', label: 'Summary' },
            { id: 'transactions', label: 'Transactions' },
            { id: 'journal', label: 'Journal' },
          ] as { id: RightTabId; label: string }[]
        ).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              className={`py-3 text-xs font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'border-[#00A8E8] text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {tab.label}
              {tab.id === 'transactions' && transactions.length > 0 && (
                <span className="ml-1 font-mono text-[10px] text-slate-400">
                  ({transactions.length})
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* SUMMARY TAB */}
      {activeTab === 'summary' && (
        <div className="flex-1 min-h-0 flex flex-col p-3.5 gap-3">
          {lastError && (
            <div className="rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300 leading-snug">
              {lastError}
            </div>
          )}

          {/* Live Pre-Trade Quantitative Gate Telemetry */}
          {latestVerdict && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-900/70 p-2.5 text-[11px] space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100">
                  <ShieldCheck
                    className={`w-3.5 h-3.5 ${
                      latestVerdict.approved
                        ? 'text-teal-600 dark:text-teal-400'
                        : 'text-amber-500'
                    }`}
                  />
                  <span>Pre-Trade Analysis Gate</span>
                </div>
                <span
                  className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                    latestVerdict.approved
                      ? 'bg-teal-100 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300'
                      : 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                  }`}
                >
                  {latestVerdict.cooldownRemaining > 0
                    ? `COOLDOWN ${latestVerdict.cooldownRemaining}t`
                    : latestVerdict.approved
                      ? 'EDGE READY'
                      : 'SCANNING'}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono text-[10px] text-slate-600 dark:text-slate-300 tabular-nums">
                <span>
                  Target:{' '}
                  <strong className="text-slate-900 dark:text-white">
                    {latestVerdict.recommendedContract}
                    {latestVerdict.recommendedContract.startsWith('DIGIT')
                      ? ` (${latestVerdict.recommendedBarrier})`
                      : ''}
                  </strong>
                </span>
                <span>
                  Conf <strong>{latestVerdict.confidence}%</strong> · EV{' '}
                  <strong
                    className={
                      latestVerdict.expectedValuePct >= 0
                        ? 'text-teal-600 dark:text-teal-400'
                        : 'text-rose-500'
                    }
                  >
                    {latestVerdict.expectedValuePct >= 0 ? '+' : ''}
                    {latestVerdict.expectedValuePct}%
                  </strong>
                </span>
              </div>
              {latestVerdict.bestZScore !== undefined && (
                <div className="flex items-center justify-between font-mono text-[10px] text-slate-600 dark:text-slate-300 tabular-nums pt-0.5 border-t border-slate-200/70 dark:border-slate-800">
                  <span>
                    Dual-Z:{' '}
                    <strong className="text-slate-900 dark:text-white">
                      {latestVerdict.bestZScore.toFixed(2)}
                    </strong>
                    {' · '}Hits <strong>{latestVerdict.recentDigitHits ?? 0}</strong>
                  </span>
                  <span>
                    {latestVerdict.lockedLosingDigit !== null &&
                    latestVerdict.lockedLosingDigit !== undefined ? (
                      <strong className="text-amber-600 dark:text-amber-400">
                        LOCKED D{latestVerdict.lockedLosingDigit}
                      </strong>
                    ) : (
                      <>
                        Gap{' '}
                        <strong>
                          {latestVerdict.ticksSinceLastTrade ?? 0}/
                          {latestVerdict.activeGapTicks ?? 10}t
                        </strong>
                      </>
                    )}
                  </span>
                </div>
              )}
              {latestVerdict.reasons[0] && (
                <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                  {latestVerdict.reasons[0]}
                </div>
              )}
            </div>
          )}

          {/* Performance / Equity stage */}
          <div className="flex-1 min-h-[200px] rounded-md bg-slate-100/80 dark:bg-slate-900/70 border border-slate-200/80 dark:border-slate-800 flex flex-col p-3 overflow-hidden">
            {equityData.length === 0 && !isRunning ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300 leading-relaxed">
                  {authenticated ? (
                    <>
                      When you&apos;re ready to trade, hit{' '}
                      <strong className="font-bold text-slate-900 dark:text-white">Run</strong>.
                      You&apos;ll be able to track your bot&apos;s performance here.
                    </>
                  ) : (
                    <>
                      Sign in with your Deriv API token to connect your Deriv account and hit{' '}
                      <strong className="font-bold text-slate-900 dark:text-white">Run</strong> to trade.
                    </>
                  )}
                </p>
                {!authenticated && onOpenLogin && (
                  <button
                    type="button"
                    onClick={onOpenLogin}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Sign in with API Token</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    Session Equity Curve
                  </span>
                  {latestTick && (
                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      Spot {latestTick.formattedQuote} · Digit {latestTick.lastDigit}
                    </span>
                  )}
                </div>

                <div className="flex-1 min-h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={equityData.length > 0 ? equityData : [{ run: 0, pnl: 0, tradePnl: 0 }]}>
                      <XAxis dataKey="run" hide />
                      <YAxis domain={['auto', 'auto']} width={38} tick={{ fontSize: 10 }} />
                      <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                      <Tooltip
                        formatter={(val) => [`$${Number(val).toFixed(2)}`, 'Cumulative P/L']}
                        labelFormatter={(l) => `Run #${l}`}
                        contentStyle={{ fontSize: '11px', borderRadius: '6px' }}
                      />
                      <Area
                        type="monotone"
                        dataKey="pnl"
                        stroke={stats.totalProfitLoss >= 0 ? '#0d9488' : '#e11d48'}
                        fill={stats.totalProfitLoss >= 0 ? '#14b8a6' : '#f43f5e'}
                        fillOpacity={0.18}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>

          {/* Info helper link */}
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => setShowStatsInfo((s) => !s)}
              className="text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 underline cursor-pointer"
            >
              What&apos;s this?
            </button>
          </div>

          {showStatsInfo && (
            <div className="text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded p-2.5">
              Live session metrics aggregate every settled contract executed by your active strategy or manual tickets.
            </div>
          )}

          {/* 3x2 KPI Summary Grid */}
          <div className="grid grid-cols-3 gap-y-4 gap-x-2 pt-2 border-t border-slate-200 dark:border-slate-800 text-center">
            <div>
              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                Total stake
              </div>
              <div className="mt-0.5 font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                {stats.totalStake.toFixed(2)} {currency}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                Total payout
              </div>
              <div className="mt-0.5 font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                {stats.totalPayout.toFixed(2)} {currency}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                No. of runs
              </div>
              <div className="mt-0.5 font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                {stats.runs}
              </div>
            </div>

            <div>
              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                Contracts lost
              </div>
              <div className="mt-0.5 font-mono text-xs font-medium text-rose-600 dark:text-rose-400 tabular-nums">
                {stats.contractsLost}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                Contracts won
              </div>
              <div className="mt-0.5 font-mono text-xs font-medium text-teal-600 dark:text-teal-400 tabular-nums">
                {stats.contractsWon}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                Total profit/loss
              </div>
              <div
                className={`mt-0.5 font-mono text-xs font-bold tabular-nums ${
                  stats.totalProfitLoss > 0
                    ? 'text-teal-600 dark:text-teal-400'
                    : stats.totalProfitLoss < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                {stats.totalProfitLoss >= 0 ? '' : '-'}
                {Math.abs(stats.totalProfitLoss).toFixed(2)} {currency}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onReset}
            className="w-full py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-bold text-slate-800 dark:text-slate-100 transition-colors cursor-pointer"
          >
            Reset
          </button>
        </div>
      )}

      {/* TRANSACTIONS TAB */}
      {activeTab === 'transactions' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3.5 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Executed Contracts
            </span>
            <button
              type="button"
              disabled={transactions.length === 0}
              onClick={exportCsv}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-3 h-3" />
              <span>Export CSV</span>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto studio-scroll divide-y divide-slate-100 dark:divide-slate-800">
            {transactions.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                No contracts executed yet. Click Run or place a trade from Bulk Trader / Circles.
              </div>
            ) : (
              transactions.map((tx) => (
                <div
                  key={tx.id}
                  className="px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 dark:text-slate-100 truncate">
                      {tx.contractType} · {tx.symbol}
                    </div>
                    <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                      {tx.entrySpot} → {tx.exitSpot}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={`font-mono font-bold tabular-nums ${
                        tx.status === 'won'
                          ? 'text-teal-600 dark:text-teal-400'
                          : tx.status === 'lost'
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {tx.status === 'open'
                        ? 'OPEN'
                        : `${tx.profit >= 0 ? '+' : ''}${tx.profit.toFixed(2)} ${currency}`}
                    </div>
                    <div className="flex items-center justify-end gap-2 mt-0.5">
                      <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                        Stake ${tx.stake.toFixed(2)}
                      </span>
                      {tx.status === 'open' && onSellContract && (
                        <button
                          type="button"
                          onClick={() => onSellContract(tx.refId)}
                          className="px-1.5 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-semibold cursor-pointer"
                        >
                          Sell
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* JOURNAL TAB */}
      {activeTab === 'journal' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3.5 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-1.5">
            {(['all', 'success', 'warning'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setJournalFilter(f)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium capitalize cursor-pointer ${
                  journalFilter === f
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {f === 'all' ? 'All' : f === 'success' ? 'Wins' : 'Losses & Alerts'}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto studio-scroll divide-y divide-slate-100 dark:divide-slate-800 p-2 space-y-1">
            {filteredJournal.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                No journal entries yet.
              </div>
            ) : (
              filteredJournal.map((entry) => (
                <div key={entry.id} className="py-2 px-2 text-xs">
                  <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 tabular-nums mb-0.5">
                    <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span>·</span>
                    <span
                      className={`font-semibold uppercase ${
                        entry.level === 'success'
                          ? 'text-teal-600 dark:text-teal-400'
                          : entry.level === 'error'
                            ? 'text-rose-600 dark:text-rose-400'
                            : entry.level === 'warning'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-sky-600 dark:text-sky-400'
                      }`}
                    >
                      {entry.level}
                    </span>
                  </div>
                  <div className="text-slate-700 dark:text-slate-200 leading-snug">
                    {entry.message}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
