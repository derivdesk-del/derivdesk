import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  CircleDot,
  Cpu,
  Layers,
  LogIn,
  Radar,
  Search,
} from 'lucide-react';
import { isWasmQuantActive } from '../../lib/wasmQuant.ts';
import {
  DERIV_MARKETS,
  type BotStats,
  type MainTabId,
  type MarketGroup,
  type MarketSymbol,
  type TickPoint,
  type TradeTransaction,
} from '../../shared/types.ts';

interface DashboardViewProps {
  balance: number | null;
  currency?: string;
  authenticated?: boolean;
  stats: BotStats;
  activeSymbol: string;
  markets?: MarketSymbol[];
  latestTick: TickPoint | null;
  transactions: TradeTransaction[];
  onSelectMarket: (symbol: string) => void;
  onNavigateTab: (tab: MainTabId) => void;
  onOpenLogin?: () => void;
}

const GROUP_FILTERS: ('All' | MarketGroup)[] = [
  'All',
  'Derived',
  'Forex',
  'Commodities',
  'Stock Indices',
  'Cryptocurrencies',
];

const AUTOMATION_ENGINES: {
  tab: MainTabId;
  name: string;
  gate: string;
  icon: 'bot' | 'circles' | 'radar' | 'layers' | 'sparkles' | 'scale' | 'trend';
}[] = [
  { tab: 'bot-builder', name: 'Bot Builder & 9-Lang Compiler', gate: 'Dual-Z / Custom Quant Gate', icon: 'bot' },
  { tab: 'dtrader-circles', name: 'DTrader Perfect Auto-Sniper', gate: '5-Gate Digit Filter + Auto-Hop', icon: 'circles' },
  { tab: 'analysis-tool', name: 'Quant Edge Auto-Pilot', gate: 'Multi-Market EV% & Conf Scanner', icon: 'radar' },
  { tab: 'bulk-trader', name: 'All-Market Bulk Auto-Loop', gate: 'Synchronized High-Prob Batching', icon: 'layers' },
  { tab: 'ai-analysis', name: 'Gemini AI Auto-Trading Engine', gate: 'Regime Pre-Filter + ThinkingLevel.HIGH', icon: 'sparkles' },
  { tab: 'hedging-beast', name: 'Hedging Beast Auto-Matrix', gate: 'Empirical Overlap EV >= Threshold', icon: 'scale' },
  { tab: 'trading-view', name: 'Chart Auto-Trend Sniper', gate: 'EMA + RSI + WASM Slope Confluence', icon: 'trend' },
];

export function DashboardView({
  balance,
  currency = 'USD',
  authenticated = false,
  stats,
  activeSymbol,
  markets = DERIV_MARKETS,
  latestTick,
  transactions,
  onSelectMarket,
  onNavigateTab,
  onOpenLogin,
}: DashboardViewProps) {
  const [groupFilter, setGroupFilter] = useState<'All' | MarketGroup>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const wasmReady = useMemo(() => isWasmQuantActive(), []);

  const filteredMarkets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return markets.filter((m) => {
      if (groupFilter !== 'All' && m.marketGroup !== groupFilter) return false;
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.symbol.toLowerCase().includes(q) ||
        m.subGroup.toLowerCase().includes(q)
      );
    });
  }, [groupFilter, markets, searchQuery]);

  const winRate =
    stats.contractsWon + stats.contractsLost > 0
      ? ((stats.contractsWon / (stats.contractsWon + stats.contractsLost)) * 100).toFixed(1)
      : '0.0';

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display font-bold text-2xl text-slate-900 dark:text-slate-100">
              Trading Studio Overview
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Live market feed across {markets.length} Deriv instruments, automated scanning across all studio modules, and WebAssembly numeric telemetry.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!authenticated && onOpenLogin && (
              <button
                type="button"
                onClick={onOpenLogin}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
              >
                <LogIn className="w-4 h-4" />
                <span>Sign in with API Token</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigateTab('bot-builder')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
            >
              <Bot className="w-4 h-4" />
              <span>Open Bot Builder</span>
            </button>
          </div>
        </div>

        {/* 4-column KPI strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Deriv Account Balance
            </div>
            {authenticated && balance !== null ? (
              <div className="mt-1 font-mono text-xl font-bold text-teal-600 dark:text-teal-400 tabular-nums">
                {balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                {currency}
              </div>
            ) : (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                  Not signed in
                </span>
                {onOpenLogin && (
                  <button
                    type="button"
                    onClick={onOpenLogin}
                    className="text-xs font-semibold text-[#0E5A78] dark:text-[#00A8E8] hover:underline cursor-pointer whitespace-nowrap"
                  >
                    Sign in
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Session Profit / Loss
            </div>
            <div
              className={`mt-1 font-mono text-xl font-bold tabular-nums ${
                stats.totalProfitLoss >= 0
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
            >
              {stats.totalProfitLoss >= 0 ? '+' : '-'}
              {Math.abs(stats.totalProfitLoss).toFixed(2)} {currency}
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Win Rate ({stats.contractsWon}W / {stats.contractsLost}L)
            </div>
            <div className="mt-1 font-mono text-xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {winRate}%
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Active Market ({activeSymbol})
            </div>
            <div className="mt-1 font-mono text-xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {latestTick ? latestTick.formattedQuote : '—'}
            </div>
          </div>
        </div>

        {/* Site-Wide Automated Scanners & Polyglot Runtime Strip */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
              <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                Automated Execution Engines &amp; Perfect-Condition Scanners
              </h2>
            </div>
            <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              Compute Runtime: {wasmReady ? 'WebAssembly f64 Kernel' : 'JS Double Fallback'} · Polyglot Compiler: TS · Python · Rust · C++20 · Go · Pine · MQL5 · SQL · XML
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {AUTOMATION_ENGINES.map((eng) => (
              <button
                key={eng.tab}
                type="button"
                onClick={() => onNavigateTab(eng.tab)}
                className="text-left rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 hover:border-[#00A8E8] px-3 py-2.5 transition-colors cursor-pointer group"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {eng.name}
                  </span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-[#00A8E8] shrink-0" />
                </div>
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  {eng.gate}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Quick Tool Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button
            type="button"
            onClick={() => onNavigateTab('analysis-tool')}
            className="text-left rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 hover:border-[#00A8E8] transition-colors cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <CircleDot className="w-5 h-5 text-[#00A8E8]" />
              <ArrowUpRight className="w-4 h-4 text-slate-400 group-hover:text-[#00A8E8]" />
            </div>
            <div className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
              Quantitative Edge Scanner
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Backtest EMA(9/21), RSI(14), EV%, and digit skew across all live Deriv markets with 1-click bot deployment.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onNavigateTab('bulk-trader')}
            className="text-left rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 hover:border-[#00A8E8] transition-colors cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <Layers className="w-5 h-5 text-teal-600 dark:text-teal-400" />
              <ArrowUpRight className="w-4 h-4 text-slate-400 group-hover:text-[#00A8E8]" />
            </div>
            <div className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
              Bulk Trader
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Fire synchronized multi-contract batches across Digits, Forex Rise/Fall, Indices, or Crypto Multipliers.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onNavigateTab('dtrader-circles')}
            className="text-left rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 hover:border-[#00A8E8] transition-colors cursor-pointer group"
          >
            <div className="flex items-center justify-between mb-2">
              <Radar className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <ArrowUpRight className="w-4 h-4 text-slate-400 group-hover:text-[#00A8E8]" />
            </div>
            <div className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
              DTrader Perfect Auto-Sniper
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              5-gate Dual-Z &amp; anti-cluster digit sniper with automatic best-market hopping and capped recovery.
            </p>
          </button>
        </div>

        {/* All Deriv Markets Switcher + Recent Trades */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Global Deriv Markets ({filteredMarkets.length})
                </span>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search symbol..."
                    className="w-36 pl-7 pr-2 py-1 text-[11px] rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {GROUP_FILTERS.map((grp) => (
                  <button
                    key={grp}
                    type="button"
                    onClick={() => setGroupFilter(grp)}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                      groupFilter === grp
                        ? 'bg-[#0E5A78] text-white'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {grp}
                  </button>
                ))}
              </div>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto studio-scroll">
              {filteredMarkets.map((m) => (
                <button
                  key={m.symbol}
                  type="button"
                  onClick={() => onSelectMarket(m.symbol)}
                  className={`w-full px-4 py-2.5 flex items-center justify-between text-xs hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer ${
                    activeSymbol === m.symbol
                      ? 'bg-sky-50/70 dark:bg-sky-950/30 font-semibold'
                      : ''
                  }`}
                >
                  <div className="text-left">
                    <div className="text-slate-900 dark:text-slate-100">
                      {m.name}
                      {m.exchangeOpen === false && (
                        <span className="ml-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                          [Closed]
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {m.symbol} · {m.marketGroup} · {m.subGroup}
                    </div>
                  </div>
                  <span className="font-mono text-xs text-[#00A8E8]">
                    {activeSymbol === m.symbol ? 'Active' : 'Select'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-display font-bold text-sm text-slate-900 dark:text-slate-100">
              Recent Executions
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto studio-scroll">
              {transactions.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  No trades executed yet. Start your bot or place a contract in Bulk Trader or Trading View.
                </div>
              ) : (
                transactions.slice(0, 12).map((tx) => (
                  <div
                    key={tx.id}
                    className="px-4 py-2.5 flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {tx.contractType} · {tx.symbol}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                        {tx.entrySpot} → {tx.exitSpot}
                      </div>
                    </div>
                    <div
                      className={`font-mono font-bold tabular-nums ${
                        tx.status === 'won'
                          ? 'text-teal-600 dark:text-teal-400'
                          : tx.status === 'lost'
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-amber-600'
                      }`}
                    >
                      {tx.status === 'open'
                        ? 'OPEN'
                        : `${tx.profit >= 0 ? '+' : ''}${tx.profit.toFixed(2)} ${currency}`}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
