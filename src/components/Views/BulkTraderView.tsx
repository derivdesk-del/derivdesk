import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Layers,
  Play,
  Radar,
  ShieldAlert,
  Square,
  Zap,
} from 'lucide-react';
import { getPayoutMultiplier } from '../../hooks/useBotEngine.ts';
import { derivFetch, parseJsonResponse } from '../../lib/derivClient.ts';
import {
  DERIV_MARKETS,
  type AppToastInput,
  type ContractTypeOption,
  type DurationUnit,
  type MarketGroup,
  type MarketScanOpportunity,
  type MarketScanResponse,
  type MarketSymbol,
  type TickPoint,
  type TradeTransaction,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface BulkTraderViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  currency?: string;
  authenticated?: boolean;
  latestTick: TickPoint | null;
  transactions: TradeTransaction[];
  onRequireLogin?: () => void;
  onSelectMarket: (symbol: string) => void;
  onNotify?: (toast: AppToastInput) => void;
  onPlaceTrade: (params: {
    symbol: string;
    contractType: ContractTypeOption;
    barrier: number;
    stake: number;
    durationTicks: number;
    durationUnit?: DurationUnit;
    multiplier?: number;
    source: 'bulk';
  }) => boolean;
}

const CONTRACT_CHOICES: {
  value: ContractTypeOption;
  label: string;
  needsBarrier: boolean;
  category: 'digits' | 'risefall' | 'multipliers';
}[] = [
  { value: 'DIGITDIFF', label: 'Digit Differ', needsBarrier: true, category: 'digits' },
  { value: 'DIGITMATCH', label: 'Digit Match', needsBarrier: true, category: 'digits' },
  { value: 'DIGITEVEN', label: 'Digit Even', needsBarrier: false, category: 'digits' },
  { value: 'DIGITODD', label: 'Digit Odd', needsBarrier: false, category: 'digits' },
  { value: 'DIGITOVER', label: 'Digit Over', needsBarrier: true, category: 'digits' },
  { value: 'DIGITUNDER', label: 'Digit Under', needsBarrier: true, category: 'digits' },
  { value: 'CALL', label: 'Rise (Call)', needsBarrier: false, category: 'risefall' },
  { value: 'PUT', label: 'Fall (Put)', needsBarrier: false, category: 'risefall' },
  { value: 'MULTUP', label: 'Multiplier Up', needsBarrier: false, category: 'multipliers' },
  { value: 'MULTDOWN', label: 'Multiplier Down', needsBarrier: false, category: 'multipliers' },
];

const SCAN_GROUPS: ('All' | MarketGroup)[] = [
  'All',
  'Derived',
  'Forex',
  'Commodities',
  'Stock Indices',
  'Cryptocurrencies',
];

export function BulkTraderView({
  activeSymbol,
  markets = DERIV_MARKETS,
  currency = 'USD',
  authenticated = false,
  latestTick,
  transactions,
  onRequireLogin,
  onSelectMarket,
  onNotify,
  onPlaceTrade,
}: BulkTraderViewProps) {
  const [modeTab, setModeTab] = useState<'smart-bulk' | 'manual-batch'>('smart-bulk');

  // Smart Multi-Market Analyzer & High-Probability Bulk Executor state
  const [scanGroup, setScanGroup] = useState<'All' | MarketGroup>('All');
  const [stakePerTrade, setStakePerTrade] = useState<number>(5);
  const [minWinProb, setMinWinProb] = useState<number>(65);
  const [minConfidence, setMinConfidence] = useState<number>(62);
  const [minEvPct, setMinEvPct] = useState<number>(0.5);
  const [maxBatchMarkets, setMaxBatchMarkets] = useState<number>(5);
  const [autoLoopActive, setAutoLoopActive] = useState<boolean>(false);
  const [autoIntervalSec, setAutoIntervalSec] = useState<number>(20);
  const [takeProfitUsd, setTakeProfitUsd] = useState<number>(50);
  const [stopLossUsd, setStopLossUsd] = useState<number>(100);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<MarketScanResponse | null>(null);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [activityLog, setActivityLog] = useState<
    { id: string; time: string; level: 'info' | 'ok' | 'warn'; text: string }[]
  >([]);

  const autoSessionStartRef = useRef<number>(0);
  const scanInFlightRef = useRef<boolean>(false);

  // Manual Single-Market Batch Ticket state
  const activeMarketMeta = useMemo(
    () =>
      markets.find((m) => m.symbol === activeSymbol) ??
      DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
      markets[0] ??
      DERIV_MARKETS[1],
    [activeSymbol, markets],
  );

  const availableChoices = useMemo(
    () =>
      CONTRACT_CHOICES.filter((c) => {
        if (c.category === 'digits') return activeMarketMeta.supportsDigits !== false;
        if (c.category === 'risefall') return activeMarketMeta.supportsRiseFall !== false;
        return Boolean(activeMarketMeta.supportsMultipliers);
      }),
    [activeMarketMeta],
  );

  const [contractType, setContractType] = useState<ContractTypeOption>('DIGITDIFF');
  const [barrier, setBarrier] = useState(4);
  const [durationTicks, setDurationTicks] = useState(1);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('t');
  const [multFactor, setMultFactor] = useState(100);
  const [batchCount, setBatchCount] = useState(3);
  const lastResetSymbolRef = useRef<string>(activeMarketMeta.symbol);

  useEffect(() => {
    const valid = availableChoices.some((c) => c.value === contractType);
    if (!valid && availableChoices.length > 0) {
      setContractType(availableChoices[0].value);
    }
  }, [availableChoices, contractType]);

  useEffect(() => {
    if (lastResetSymbolRef.current !== activeMarketMeta.symbol) {
      lastResetSymbolRef.current = activeMarketMeta.symbol;
      setDurationTicks(activeMarketMeta.defaultDuration ?? 1);
      setDurationUnit(activeMarketMeta.defaultDurationUnit ?? 't');
    }
  }, [activeMarketMeta]);

  const appendLog = useCallback((level: 'info' | 'ok' | 'warn', text: string) => {
    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    setActivityLog((prev) => [
      { id: `bl-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, time, level, text },
      ...prev.slice(0, 39),
    ]);
  }, []);

  const isQualifiedOpportunity = useCallback(
    (opp: MarketScanOpportunity) =>
      opp.winRatePct >= minWinProb &&
      opp.winRatePct > opp.breakEvenPct &&
      opp.expectedValuePct >= minEvPct &&
      opp.confidence >= minConfidence,
    [minConfidence, minEvPct, minWinProb],
  );

  const qualifiedResults = useMemo(
    () => (scanResult?.results ?? []).filter(isQualifiedOpportunity),
    [isQualifiedOpportunity, scanResult],
  );

  const bulkTxs = useMemo(
    () => transactions.filter((t) => t.source === 'bulk').slice(0, 30),
    [transactions],
  );

  const bulkSessionStats = useMemo(() => {
    const startTs = autoSessionStartRef.current;
    const sessionTxs =
      startTs > 0
        ? transactions.filter((t) => t.source === 'bulk' && t.timestamp >= startTs)
        : [];
    const hasOpen = transactions.some((t) => t.source === 'bulk' && t.status === 'open');
    const settled = sessionTxs.filter((t) => t.status !== 'open');
    const netPnl = Number(settled.reduce((acc, t) => acc + t.profit, 0).toFixed(2));
    return {
      count: sessionTxs.length,
      settledCount: settled.length,
      wins: settled.filter((t) => t.status === 'won').length,
      hasOpen,
      netPnl,
    };
  }, [transactions]);

  // Safety stop for auto-loop on Take Profit or Stop Loss
  useEffect(() => {
    if (!autoLoopActive || bulkSessionStats.settledCount === 0) return;
    if (bulkSessionStats.netPnl >= takeProfitUsd) {
      setAutoLoopActive(false);
      appendLog(
        'ok',
        `Take Profit reached (+${bulkSessionStats.netPnl.toFixed(2)} ${currency}). Auto Bulk stopped.`,
      );
      onNotify?.({
        variant: 'success',
        title: 'Bulk Take Profit Reached',
        message: 'Auto High-Probability Bulk stopped after hitting profit target.',
        meta: `Net P/L +${bulkSessionStats.netPnl.toFixed(2)} ${currency} >= +${takeProfitUsd.toFixed(2)}`,
        durationMs: 7500,
      });
    } else if (bulkSessionStats.netPnl <= -Math.abs(stopLossUsd)) {
      setAutoLoopActive(false);
      appendLog(
        'warn',
        `Stop Loss triggered (${bulkSessionStats.netPnl.toFixed(2)} ${currency}). Auto Bulk stopped.`,
      );
      onNotify?.({
        variant: 'error',
        title: 'Bulk Stop Loss Threshold Hit',
        message: 'Auto High-Probability Bulk stopped automatically to limit drawdown.',
        meta: `Net P/L ${bulkSessionStats.netPnl.toFixed(2)} ${currency} <= -${Math.abs(stopLossUsd).toFixed(2)}`,
        persistent: true,
      });
    }
  }, [appendLog, autoLoopActive, bulkSessionStats, currency, onNotify, stopLossUsd, takeProfitUsd]);

  const executeOpportunities = useCallback(
    (targets: MarketScanOpportunity[]) => {
      if (targets.length === 0) {
        appendLog('warn', 'No markets met the winning probability and EV% thresholds.');
        return 0;
      }
      if (!authenticated) {
        appendLog('warn', 'Sign in with your Deriv API token to execute bulk contracts.');
        onRequireLogin?.();
        return 0;
      }

      const capped = targets.slice(0, maxBatchMarkets);
      let placedCount = 0;
      for (const opp of capped) {
        const ok = onPlaceTrade({
          symbol: opp.symbol,
          contractType: opp.contractType,
          barrier: opp.barrier,
          stake: stakePerTrade,
          durationTicks: opp.duration,
          durationUnit: opp.durationUnit,
          multiplier: opp.multiplier,
          source: 'bulk',
        });
        if (ok) {
          placedCount++;
        } else {
          break;
        }
      }

      if (placedCount > 0) {
        onSelectMarket(capped[0].symbol);
        const listSummary = capped
          .slice(0, placedCount)
          .map(
            (o) =>
              `${o.symbol} ${o.contractType}${o.contractType.startsWith('DIGIT') ? `[${o.barrier}]` : ''} (${o.winRatePct}%)`,
          )
          .join(', ');
        appendLog(
          'ok',
          `Executed ${placedCount} high-probability contract${placedCount > 1 ? 's' : ''}: ${listSummary}`,
        );
        onNotify?.({
          variant: 'info',
          title: 'Bulk Batch Executed',
          message: `Dispatched ${placedCount} high-probability contract${placedCount > 1 ? 's' : ''}.`,
          meta: `${listSummary.slice(0, 72)}${listSummary.length > 72 ? '...' : ''} · ${(placedCount * stakePerTrade).toFixed(2)} ${currency} total`,
          durationMs: 4500,
        });
      }
      return placedCount;
    },
    [
      appendLog,
      authenticated,
      currency,
      maxBatchMarkets,
      onNotify,
      onPlaceTrade,
      onRequireLogin,
      onSelectMarket,
      stakePerTrade,
    ],
  );

  const runBulkMarketAnalysis = useCallback(
    async (executeQualifiedAfterScan: boolean) => {
      if (scanInFlightRef.current) return;
      scanInFlightRef.current = true;
      setIsScanning(true);
      setScanError(null);

      try {
        const targetCount = scanGroup === 'All' ? Math.max(60, markets.length) : 45;
        const res = await derivFetch('/api/deriv/scan-markets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group: scanGroup,
            stake: stakePerTrade,
            minConfidence,
            minEvPct,
            perfectOnly: minConfidence >= 80 && minEvPct >= 1.5,
            maxMarkets: Math.min(120, targetCount),
            sortBy: 'probability',
          }),
        });
        const data = await parseJsonResponse<MarketScanResponse & { error?: string }>(
          res,
          'Market scan failed.',
        );
        if (!res.ok) {
          throw new Error(data.error || 'Market scan failed.');
        }

        setScanResult(data);
        const qualifying = data.results.filter(
          (opp) =>
            opp.winRatePct >= minWinProb &&
            opp.winRatePct > opp.breakEvenPct &&
            opp.expectedValuePct >= minEvPct &&
            opp.confidence >= minConfidence,
        );

        setSelectedSymbols(qualifying.slice(0, maxBatchMarkets).map((q) => q.symbol));

        appendLog(
          'info',
          `Analyzed ${data.totalScanned} live markets → ${qualifying.length} high-probability setup${qualifying.length === 1 ? '' : 's'} (>=${minWinProb}% win rate, >=+${minEvPct}% EV).`,
        );

        if (executeQualifiedAfterScan) {
          if (bulkSessionStats.hasOpen) {
            appendLog(
              'info',
              'Skipping auto-batch while previous bulk contracts are still settling.',
            );
          } else {
            executeOpportunities(qualifying);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to analyze markets.';
        setScanError(msg);
        appendLog('warn', msg);
      } finally {
        scanInFlightRef.current = false;
        setIsScanning(false);
      }
    },
    [
      appendLog,
      bulkSessionStats.hasOpen,
      executeOpportunities,
      markets.length,
      maxBatchMarkets,
      minConfidence,
      minEvPct,
      minWinProb,
      scanGroup,
      stakePerTrade,
    ],
  );

  // Periodic Auto-Bulk loop
  useEffect(() => {
    if (!autoLoopActive) return;
    runBulkMarketAnalysis(true);
    const interval = window.setInterval(() => {
      runBulkMarketAnalysis(true);
    }, autoIntervalSec * 1000);
    return () => window.clearInterval(interval);
  }, [autoIntervalSec, autoLoopActive, runBulkMarketAnalysis]);

  const handleToggleAutoBulk = () => {
    if (autoLoopActive) {
      setAutoLoopActive(false);
      appendLog('info', 'Auto Bulk Scanner paused.');
      return;
    }
    if (!authenticated) {
      appendLog('warn', 'Sign in with your Deriv API token before starting Auto Bulk execution.');
      onRequireLogin?.();
      return;
    }
    autoSessionStartRef.current = Date.now();
    setAutoLoopActive(true);
    appendLog(
      'ok',
      `Started Auto High-Probability Bulk (${scanGroup} · Win >=${minWinProb}% · Conf >=${minConfidence}% · Max ${maxBatchMarkets}/batch).`,
    );
  };

  const toggleSymbolSelection = (symbol: string) => {
    setSelectedSymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol],
    );
  };

  const selectedOpportunities = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.results.filter((r) => selectedSymbols.includes(r.symbol));
  }, [scanResult, selectedSymbols]);

  // Manual ticket calculations
  const selectedMeta =
    availableChoices.find((c) => c.value === contractType) ??
    availableChoices[0] ??
    CONTRACT_CHOICES[0];
  const isMultiplier = contractType === 'MULTUP' || contractType === 'MULTDOWN';
  const payoutMult = isMultiplier ? 1.95 : getPayoutMultiplier(contractType, barrier);
  const totalOutlay = stakePerTrade * batchCount;
  const estMaxPayout = Number((totalOutlay * payoutMult).toFixed(2));

  const fireManualBatch = () => {
    if (!authenticated) {
      onRequireLogin?.();
      return;
    }
    for (let i = 0; i < batchCount; i++) {
      onPlaceTrade({
        symbol: activeSymbol,
        contractType,
        barrier,
        stake: stakePerTrade,
        durationTicks,
        durationUnit,
        multiplier: multFactor,
        source: 'bulk',
      });
    }
  };

  const totalBulkProfit = useMemo(
    () =>
      Number(
        bulkTxs
          .filter((t) => t.status !== 'open')
          .reduce((acc, t) => acc + t.profit, 0)
          .toFixed(2),
      ),
    [bulkTxs],
  );

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-7xl mx-auto space-y-5">
        {/* Top Header & Mode Switch */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display font-bold text-xl text-slate-900 dark:text-slate-100">
              High-Probability Multi-Market Bulk Trader
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Analyzes all open Deriv markets simultaneously, ranks setups by empirical win probability vs break-even &amp; EV%, and executes the top qualifying contracts in bulk.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setModeTab('smart-bulk')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                modeTab === 'smart-bulk'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              All-Market Smart Bulk
            </button>
            <button
              type="button"
              onClick={() => setModeTab('manual-batch')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                modeTab === 'manual-batch'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Single-Market Batch Ticket
            </button>
          </div>
        </div>

        {modeTab === 'smart-bulk' ? (
          <>
            {/* Scanner Filter & Auto-Execution Controls */}
            <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Radar
                    className={`w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8] ${
                      isScanning || autoLoopActive ? 'animate-spin' : ''
                    }`}
                  />
                  <span className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                    All-Market Probability Scanner &amp; Batch Executor
                  </span>
                  {scanResult && (
                    <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      {scanResult.totalScanned} scanned · {qualifiedResults.length} qualified
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isScanning}
                    onClick={() => runBulkMarketAnalysis(false)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Activity className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
                    <span>{isScanning ? 'Analyzing Markets...' : 'Analyze All Markets'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={isScanning}
                    onClick={() => {
                      if (!authenticated) {
                        onRequireLogin?.();
                        return;
                      }
                      runBulkMarketAnalysis(true);
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-bold cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>Analyze &amp; Execute Best</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleAutoBulk}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-bold text-white cursor-pointer whitespace-nowrap shrink-0 ${
                      autoLoopActive
                        ? 'bg-rose-600 hover:bg-rose-700'
                        : 'bg-[#389E94] hover:bg-[#2F877E]'
                    }`}
                  >
                    {autoLoopActive ? (
                      <>
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop Auto-Bulk</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Auto Bulk Loop</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Filter Parameters Strip */}
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Scope:</span>
                  <select
                    value={scanGroup}
                    onChange={(e) => setScanGroup(e.target.value as 'All' | MarketGroup)}
                    className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-semibold"
                  >
                    {SCAN_GROUPS.map((g) => (
                      <option key={g} value={g}>
                        {g === 'All' ? `All Open Markets (${markets.length})` : g}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Min Win Prob %:</span>
                  <input
                    type="number"
                    min={40}
                    max={98}
                    value={minWinProb}
                    onChange={(e) =>
                      setMinWinProb(Math.min(98, Math.max(40, Number(e.target.value) || 65)))
                    }
                    className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
                  />
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Min Conf %:</span>
                  <input
                    type="number"
                    min={35}
                    max={95}
                    value={minConfidence}
                    onChange={(e) =>
                      setMinConfidence(Math.min(95, Math.max(35, Number(e.target.value) || 62)))
                    }
                    className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
                  />
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Min EV %:</span>
                  <input
                    type="number"
                    step="0.5"
                    value={minEvPct}
                    onChange={(e) => setMinEvPct(Number(e.target.value) || 0)}
                    className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
                  />
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Max / Batch:</span>
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={maxBatchMarkets}
                    onChange={(e) =>
                      setMaxBatchMarkets(Math.min(15, Math.max(1, Number(e.target.value) || 5)))
                    }
                    className="w-12 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
                  />
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Stake ({currency}):</span>
                  <input
                    type="number"
                    min={0.35}
                    step={0.5}
                    value={stakePerTrade}
                    onChange={(e) =>
                      setStakePerTrade(Math.max(0.35, Number(e.target.value) || 1))
                    }
                    className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => {
                    setMinWinProb(92);
                    setMinConfidence(84);
                    setMinEvPct(2.0);
                    setMaxBatchMarkets(3);
                  }}
                  className="px-2.5 py-1 rounded border border-[#0E5A78]/40 dark:border-[#00A8E8]/40 text-[#0E5A78] dark:text-[#00A8E8] hover:bg-sky-50 dark:hover:bg-sky-950/30 font-semibold cursor-pointer whitespace-nowrap"
                >
                  Perfect Conditions Preset (92% Win / 84% Conf / +2% EV)
                </button>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">Loop:</span>
                  <select
                    value={autoIntervalSec}
                    onChange={(e) => setAutoIntervalSec(Number(e.target.value))}
                    className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono font-semibold"
                  >
                    <option value={15}>15s</option>
                    <option value={20}>20s</option>
                    <option value={30}>30s</option>
                  </select>
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500">TP / SL:</span>
                  <input
                    type="number"
                    min={1}
                    value={takeProfitUsd}
                    onChange={(e) => setTakeProfitUsd(Math.max(1, Number(e.target.value) || 50))}
                    className="w-12 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1 font-mono tabular-nums text-center"
                    title="Auto-stop Take Profit"
                  />
                  <span className="text-slate-400">/</span>
                  <input
                    type="number"
                    min={1}
                    value={stopLossUsd}
                    onChange={(e) => setStopLossUsd(Math.max(1, Number(e.target.value) || 100))}
                    className="w-12 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-1 font-mono tabular-nums text-center"
                    title="Auto-stop Stop Loss"
                  />
                </label>
              </div>

              {scanError && (
                <div className="px-5 py-2.5 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2 border-b border-rose-200 dark:border-rose-800">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>{scanError}</span>
                </div>
              )}

              {/* Selection Action Strip */}
              {scanResult && scanResult.results.length > 0 && (
                <div className="px-5 py-2.5 bg-slate-50/70 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-3 text-slate-600 dark:text-slate-300">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      Selected: {Math.min(selectedOpportunities.length, maxBatchMarkets)} markets
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Total Batch Stake:{' '}
                      {(Math.min(selectedOpportunities.length, maxBatchMarkets) * stakePerTrade).toFixed(2)}{' '}
                      {currency}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedSymbols(
                          qualifiedResults.slice(0, maxBatchMarkets).map((q) => q.symbol),
                        )
                      }
                      className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 font-medium cursor-pointer"
                    >
                      Select Top Qualified ({Math.min(qualifiedResults.length, maxBatchMarkets)})
                    </button>
                    <button
                      type="button"
                      disabled={selectedOpportunities.length === 0}
                      onClick={() => executeOpportunities(selectedOpportunities)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-[#389E94] hover:bg-[#2F877E] text-white font-bold cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>
                        Execute {Math.min(selectedOpportunities.length, maxBatchMarkets)} Selected Markets
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* Ranked Market Opportunities Table */}
              <div className="max-h-[420px] overflow-y-auto studio-scroll">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5 w-8">Pick</th>
                      <th className="px-3 py-2.5 font-semibold">Market</th>
                      <th className="px-3 py-2.5 font-semibold">Contract Setup</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Win Prob</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Break-Even</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Edge / EV%</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Conf</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Single Trade</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {!scanResult ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-6 py-10 text-center text-slate-500 dark:text-slate-400"
                        >
                          Click <strong>Analyze All Markets</strong> to scan live Deriv markets for win probability, break-even edge, and EV%, or click <strong>Analyze &amp; Execute Best</strong> to trade qualifying setups immediately.
                        </td>
                      </tr>
                    ) : scanResult.results.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-6 py-8 text-center text-slate-500 dark:text-slate-400"
                        >
                          No market telemetry returned. Try widening scope to All Open Markets.
                        </td>
                      </tr>
                    ) : (
                      scanResult.results.map((row) => {
                        const qualified = isQualifiedOpportunity(row);
                        const checked = selectedSymbols.includes(row.symbol);
                        const edgeDelta = Number((row.winRatePct - row.breakEvenPct).toFixed(1));
                        return (
                          <tr
                            key={`${row.symbol}-${row.contractType}`}
                            className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                              qualified ? 'bg-teal-50/35 dark:bg-teal-950/15' : ''
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSymbolSelection(row.symbol)}
                                className="rounded border-slate-400 text-[#0E5A78] cursor-pointer"
                              />
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="font-semibold text-slate-900 dark:text-slate-100">
                                {row.name}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                {row.symbol} · {row.marketGroup} · {row.regime}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="font-mono font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                                {row.contractType}
                                {row.contractType.startsWith('DIGIT') ? ` [${row.barrier}]` : ''}{' '}
                                · {row.duration}
                                {row.durationUnit}
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[230px]">
                                {row.strategyLabel}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums">
                              <span
                                className={
                                  row.winRatePct >= minWinProb
                                    ? 'text-teal-600 dark:text-teal-400'
                                    : 'text-slate-700 dark:text-slate-300'
                                }
                              >
                                {row.winRatePct.toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-500">
                              {row.breakEvenPct.toFixed(1)}%
                              <span
                                className={`block text-[10px] ${
                                  edgeDelta > 0
                                    ? 'text-teal-600 dark:text-teal-400'
                                    : 'text-rose-500'
                                }`}
                              >
                                {edgeDelta >= 0 ? '+' : ''}
                                {edgeDelta}% vs BE
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums">
                              <span
                                className={
                                  row.expectedValuePct > 0
                                    ? 'text-teal-600 dark:text-teal-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }
                              >
                                {row.expectedValuePct >= 0 ? '+' : ''}
                                {row.expectedValuePct}%
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums">
                              <span
                                className={
                                  qualified
                                    ? 'text-teal-600 dark:text-teal-400'
                                    : 'text-slate-500'
                                }
                              >
                                {row.confidence}%
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => executeOpportunities([row])}
                                className="px-2.5 py-1 rounded bg-[#0E5A78] hover:bg-[#0B4861] text-white text-[11px] font-bold cursor-pointer"
                              >
                                Trade
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom Split: Execution Feed + Scanner Log */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div className="lg:col-span-7 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                    Bulk Execution Ledger
                  </h3>
                  <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
                    <span className="text-slate-500">{bulkTxs.length} trades</span>
                    <span
                      className={`font-bold ${
                        totalBulkProfit >= 0
                          ? 'text-teal-600 dark:text-teal-400'
                          : 'text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      Net: {totalBulkProfit >= 0 ? '+' : ''}
                      {totalBulkProfit.toFixed(2)} {currency}
                    </span>
                  </div>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto studio-scroll">
                  {bulkTxs.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                      Executed bulk contracts across selected high-probability markets appear here in real time.
                    </div>
                  ) : (
                    bulkTxs.map((tx) => (
                      <div
                        key={tx.id}
                        className="px-4 py-2.5 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-slate-100">
                            {tx.contractType}
                            {typeof tx.barrier === 'number' && tx.contractType.startsWith('DIGIT')
                              ? ` [${tx.barrier}]`
                              : ''}{' '}
                            · {tx.marketName} ({tx.symbol})
                          </div>
                          <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                            Ref #{tx.refId.slice(-6)} · Entry {tx.entrySpot} → Exit {tx.exitSpot}
                          </div>
                        </div>
                        <div className="text-right font-mono tabular-nums">
                          <div
                            className={`font-bold ${
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
                          <div className="text-[10px] text-slate-400">
                            Stake {tx.stake.toFixed(2)} {currency}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="lg:col-span-5 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                    Bulk Scanner Activity
                  </h3>
                  {autoLoopActive && (
                    <span className="font-mono text-[11px] font-bold text-teal-600 dark:text-teal-400">
                      AUTO LOOP ACTIVE
                    </span>
                  )}
                </div>
                <div className="p-3 space-y-1.5 max-h-72 overflow-y-auto studio-scroll">
                  {activityLog.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400 p-4 text-center">
                      No bulk scan runs yet.
                    </p>
                  ) : (
                    activityLog.map((entry) => (
                      <div
                        key={entry.id}
                        className={`text-[11px] rounded px-2.5 py-1.5 border ${
                          entry.level === 'ok'
                            ? 'bg-teal-50/70 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800 text-teal-900 dark:text-teal-200'
                            : entry.level === 'warn'
                              ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                              : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        <span className="font-mono text-[10px] opacity-70 mr-1.5">
                          {entry.time}
                        </span>
                        <span>{entry.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left Manual Batch Ticket */}
            <div className="lg:col-span-5 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4 h-fit">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-[#00A8E8]" />
                  <h2 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
                    Bulk Contract Ticket
                  </h2>
                </div>
                <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200 tabular-nums">
                  {latestTick ? latestTick.formattedQuote : '—'}
                </span>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Market ({activeMarketMeta.marketGroup})
                  </label>
                  <MarketSelector
                    markets={markets}
                    value={activeSymbol}
                    onChange={onSelectMarket}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 font-semibold"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Contract Type
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {availableChoices.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setContractType(c.value)}
                        className={`px-3 py-2 rounded border text-left font-medium transition-colors cursor-pointer ${
                          contractType === c.value
                            ? 'bg-[#0E5A78] border-[#0E5A78] text-white font-semibold'
                            : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                {selectedMeta.needsBarrier && (
                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Digit Prediction / Barrier
                    </label>
                    <div className="grid grid-cols-10 gap-1">
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setBarrier(d)}
                          className={`py-1.5 rounded font-mono font-bold cursor-pointer ${
                            barrier === d
                              ? 'bg-[#00A8E8] text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Stake ({currency})
                    </label>
                    <input
                      type="number"
                      min={0.35}
                      step={0.5}
                      value={stakePerTrade}
                      onChange={(e) =>
                        setStakePerTrade(Math.max(0.35, Number(e.target.value) || 1))
                      }
                      className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 font-mono tabular-nums"
                    />
                  </div>

                  {isMultiplier ? (
                    <div>
                      <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                        Multiplier
                      </label>
                      <select
                        value={multFactor}
                        onChange={(e) => setMultFactor(Number(e.target.value) || 100)}
                        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-2 font-mono font-bold"
                      >
                        {[20, 40, 50, 100, 200, 300, 500].map((m) => (
                          <option key={m} value={m}>
                            x{m}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                        Duration
                      </label>
                      <div className="flex gap-1">
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={durationTicks}
                          onChange={(e) =>
                            setDurationTicks(
                              Math.min(365, Math.max(1, Number(e.target.value) || 1)),
                            )
                          }
                          className="w-12 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-2 font-mono tabular-nums text-center"
                        />
                        <select
                          value={durationUnit}
                          onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}
                          className="flex-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-1 py-2 font-mono text-[11px]"
                        >
                          <option value="t">t</option>
                          <option value="s">s</option>
                          <option value="m">m</option>
                          <option value="h">h</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Batch Qty
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={batchCount}
                      onChange={(e) =>
                        setBatchCount(Math.min(10, Math.max(1, Number(e.target.value) || 1)))
                      }
                      className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 font-mono tabular-nums"
                    />
                  </div>
                </div>

                <div className="p-3 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1 font-mono text-[11px] tabular-nums">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Total Outlay:</span>
                    <span className="font-bold">
                      {totalOutlay.toFixed(2)} {currency}
                    </span>
                  </div>
                  {!isMultiplier && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Payout Multiplier:</span>
                        <span>{payoutMult.toFixed(3)}x</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Potential Gross Payout:</span>
                        <span className="font-bold text-teal-600 dark:text-teal-400">
                          {estMaxPayout.toFixed(2)} {currency}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={fireManualBatch}
                  className="w-full py-2.5 rounded-md bg-[#389E94] hover:bg-[#2F877E] text-white font-bold text-xs cursor-pointer"
                >
                  Execute {batchCount}x Bulk Contracts
                </button>
              </div>
            </div>

            {/* Right Batch Ledger */}
            <div className="lg:col-span-7 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Bulk Execution Feed
                </h3>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  {bulkTxs.length} recent
                </span>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 flex-1 overflow-y-auto studio-scroll">
                {bulkTxs.length === 0 ? (
                  <div className="p-10 text-center text-xs text-slate-500 dark:text-slate-400">
                    Configure your batch parameters on the left and click Execute to place simultaneous contracts across live Deriv markets.
                  </div>
                ) : (
                  bulkTxs.map((tx) => (
                    <div
                      key={tx.id}
                      className="px-4 py-3 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {tx.contractType} · {tx.symbol} (Ref #{tx.refId.slice(-5)})
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                          Entry {tx.entrySpot} → Exit {tx.exitSpot}
                        </div>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <div
                          className={`font-bold ${
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
                        <div className="text-[10px] text-slate-400">
                          Stake {tx.stake.toFixed(2)} {currency}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
