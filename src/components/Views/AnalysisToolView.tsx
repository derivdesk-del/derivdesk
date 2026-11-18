import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Play,
  Radar,
  ShieldAlert,
  Sliders,
  Square,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DigitStat } from '../../hooks/useDerivMarket.ts';
import { derivFetch, parseJsonResponse } from '../../lib/derivClient.ts';
import {
  analyzeMarketTicks,
  type StrategyEdgeOpportunity,
} from '../../lib/marketAnalysis.ts';
import {
  DERIV_MARKETS,
  type AppToastInput,
  type BotStrategyConfig,
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

interface AnalysisToolViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  ticks: TickPoint[];
  computeDigitStats: (sampleSize: number) => DigitStat[];
  currentStrategy: BotStrategyConfig;
  authenticated?: boolean;
  currency?: string;
  transactions?: TradeTransaction[];
  onRequireLogin?: () => void;
  onSelectMarket: (symbol: string) => void;
  onApplyStrategy: (strategy: BotStrategyConfig, runImmediately: boolean) => void;
  onNotify?: (toast: AppToastInput) => void;
  onPlaceTrade: (params: {
    symbol: string;
    contractType: ContractTypeOption;
    barrier: number;
    stake: number;
    durationTicks: number;
    durationUnit?: DurationUnit;
    multiplier?: number;
    source: 'manual' | 'scanner';
  }) => boolean;
}

const SCAN_GROUPS: ('All' | MarketGroup)[] = [
  'All',
  'Derived',
  'Forex',
  'Commodities',
  'Stock Indices',
  'Cryptocurrencies',
];

export function AnalysisToolView({
  activeSymbol,
  markets = DERIV_MARKETS,
  ticks,
  computeDigitStats,
  currentStrategy,
  authenticated = false,
  currency = 'USD',
  transactions = [],
  onRequireLogin,
  onSelectMarket,
  onApplyStrategy,
  onNotify,
  onPlaceTrade,
}: AnalysisToolViewProps) {
  const [sampleSize, setSampleSize] = useState(1000);
  const [barrier, setBarrier] = useState(4);
  const [stake, setStake] = useState(10);

  // Auto Multi-Market Analyser & Auto-Execute state
  const [scanGroup, setScanGroup] = useState<'All' | MarketGroup>('All');
  const [scanIntervalSec, setScanIntervalSec] = useState<number>(15);
  const [minConfidence, setMinConfidence] = useState<number>(62);
  const [minEvPct, setMinEvPct] = useState<number>(0.5);
  const [autoTakeProfit, setAutoTakeProfit] = useState<number>(50);
  const [autoStopLoss, setAutoStopLoss] = useState<number>(100);
  const [maxLossStreak, setMaxLossStreak] = useState<number>(3);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [autoExecuteActive, setAutoExecuteActive] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<MarketScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [autoLog, setAutoLog] = useState<
    { id: string; time: string; level: 'info' | 'ok' | 'warn'; text: string }[]
  >([]);

  const autoSessionStartRef = useRef<number>(0);
  const lastAutoTradeAtRef = useRef<number>(0);
  const scanInFlightRef = useRef<boolean>(false);

  const appendAutoLog = useCallback(
    (level: 'info' | 'ok' | 'warn', text: string) => {
      const time = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setAutoLog((prev) => [
        { id: `al-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, time, level, text },
        ...prev.slice(0, 29),
      ]);
    },
    [],
  );

  const scannerStats = useMemo(() => {
    const startTs = autoSessionStartRef.current;
    const sessionTxs =
      startTs > 0
        ? transactions.filter((t) => t.source === 'scanner' && t.timestamp >= startTs)
        : [];
    const hasOpen = sessionTxs.some((t) => t.status === 'open');
    const settled = sessionTxs.filter((t) => t.status !== 'open');
    const netPnl = Number(settled.reduce((acc, t) => acc + t.profit, 0).toFixed(2));
    let lossStreak = 0;
    for (const tx of settled) {
      if (tx.status === 'lost') lossStreak++;
      else break;
    }
    return {
      totalCount: sessionTxs.length,
      settledCount: settled.length,
      wins: settled.filter((t) => t.status === 'won').length,
      hasOpen,
      netPnl,
      lossStreak,
    };
  }, [transactions]);

  // Safety monitor: automatically stop Auto-Execute when TP, SL, or max loss streak triggers
  useEffect(() => {
    if (!autoExecuteActive) return;
    if (scannerStats.settledCount === 0) return;

    if (scannerStats.netPnl >= autoTakeProfit) {
      setAutoExecuteActive(false);
      appendAutoLog(
        'ok',
        `Auto-Execute stopped: Take Profit target reached (+$${scannerStats.netPnl.toFixed(2)} >= $${autoTakeProfit}).`,
      );
      onNotify?.({
        variant: 'success',
        title: 'Scanner Take Profit Reached',
        message: 'Auto-Analyse & Auto-Execute stopped cleanly after reaching target profit.',
        meta: `Net P/L +${scannerStats.netPnl.toFixed(2)} ${currency} >= +${autoTakeProfit.toFixed(2)}`,
        durationMs: 7500,
      });
    } else if (scannerStats.netPnl <= -Math.abs(autoStopLoss)) {
      setAutoExecuteActive(false);
      appendAutoLog(
        'warn',
        `Auto-Execute stopped: Stop Loss hit ($${scannerStats.netPnl.toFixed(2)} <= -$${autoStopLoss}).`,
      );
      onNotify?.({
        variant: 'error',
        title: 'Scanner Stop Loss Threshold Hit',
        message: 'Auto-Execute stopped automatically after hitting stop loss limit.',
        meta: `Net P/L ${scannerStats.netPnl.toFixed(2)} ${currency} <= -${Math.abs(autoStopLoss).toFixed(2)}`,
        persistent: true,
      });
    } else if (maxLossStreak > 0 && scannerStats.lossStreak >= maxLossStreak) {
      setAutoExecuteActive(false);
      appendAutoLog(
        'warn',
        `Auto-Execute paused: ${scannerStats.lossStreak} consecutive losses reached.`,
      );
      onNotify?.({
        variant: 'error',
        title: 'Scanner Loss Streak Threshold Hit',
        message: `Auto-Execute paused after ${scannerStats.lossStreak} consecutive losses.`,
        meta: `Streak ${scannerStats.lossStreak}/${maxLossStreak} · Net P/L ${scannerStats.netPnl >= 0 ? '+' : ''}${scannerStats.netPnl.toFixed(2)} ${currency}`,
        persistent: true,
      });
    }
  }, [
    appendAutoLog,
    autoExecuteActive,
    autoStopLoss,
    autoTakeProfit,
    currency,
    maxLossStreak,
    onNotify,
    scannerStats,
  ]);

  const buildBotFromScanOpportunity = useCallback(
    (opp: MarketScanOpportunity): BotStrategyConfig => {
      return {
        ...currentStrategy,
        id: `auto-scan-${opp.symbol}-${Date.now()}`,
        name: `Auto-Best: ${opp.symbol} ${opp.contractType}`,
        description: opp.rationale,
        tradeParams: {
          ...currentStrategy.tradeParams,
          marketGroup: opp.marketGroup,
          subGroup: opp.subGroup,
          symbol: opp.symbol,
          tradeCategory: opp.tradeCategory,
          tradeType: opp.tradeType,
          contractType: opp.contractType,
        },
        variables: currentStrategy.variables.map((v) =>
          v.name === 'stake' ? { ...v, value: stake } : v,
        ),
        purchaseConditions: {
          ...currentStrategy.purchaseConditions,
          mode: opp.conditionMode,
          durationTicks: opp.duration,
          durationUnit: opp.durationUnit,
          multiplier: opp.multiplier ?? 100,
          predictionDigit: opp.barrier,
        },
        preTradeAnalysis: {
          enabled: true,
          minConfidence,
          minEvPct,
          autoSelectBestContract: true,
          requireConfluence: true,
          lossCooldownTicks: 2,
          maxConsecutiveLosses: maxLossStreak,
          trailingProfitLockPct: 50,
        },
        restartConditions: {
          ...currentStrategy.restartConditions,
          takeProfit: autoTakeProfit,
          stopLoss: autoStopLoss,
        },
      };
    },
    [
      autoStopLoss,
      autoTakeProfit,
      currentStrategy,
      maxLossStreak,
      minConfidence,
      minEvPct,
      stake,
    ],
  );

  const runMarketScan = useCallback(
    async (allowAutoExecute: boolean) => {
      if (scanInFlightRef.current) return;
      scanInFlightRef.current = true;
      setIsScanning(true);
      setScanError(null);

      try {
        const res = await derivFetch('/api/deriv/scan-markets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group: scanGroup,
            stake,
            minConfidence,
            minEvPct,
            maxMarkets: 24,
          }),
        });
        const data = await parseJsonResponse<MarketScanResponse & { error?: string }>(
          res,
          'Failed to scan markets.',
        );
        if (!res.ok) {
          throw new Error(data.error || 'Failed to scan markets.');
        }

        setScanResult(data);
        const best = data.bestOpportunity;
        if (!best) {
          appendAutoLog('warn', `Scanned ${data.totalScanned} markets: no setups qualified yet.`);
          return;
        }

        if (allowAutoExecute) {
          onSelectMarket(best.symbol);
          const now = Date.now();
          if (scannerStats.hasOpen) {
            appendAutoLog(
              'info',
              `Best market: ${best.symbol} (${best.contractType}, EV ${best.expectedValuePct >= 0 ? '+' : ''}${best.expectedValuePct}%, ${best.confidence}% conf) · waiting for open contract to settle.`,
            );
            return;
          }
          if (now - lastAutoTradeAtRef.current < 4000) {
            return;
          }

          if (
            best.approved &&
            best.confidence >= minConfidence &&
            best.expectedValuePct >= minEvPct
          ) {
            lastAutoTradeAtRef.current = now;
            const placed = onPlaceTrade({
              symbol: best.symbol,
              contractType: best.contractType,
              barrier: best.barrier,
              stake,
              durationTicks: best.duration,
              durationUnit: best.durationUnit,
              multiplier: best.multiplier,
              source: 'scanner',
            });
            if (placed) {
              const barrierSuffix = best.contractType.startsWith('DIGIT')
                ? ` [${best.barrier}]`
                : '';
              appendAutoLog(
                'ok',
                `Auto-Executed #1 Best: ${best.symbol} → ${best.contractType}${barrierSuffix} · $${stake.toFixed(2)} · EV ${best.expectedValuePct >= 0 ? '+' : ''}${best.expectedValuePct}% (${best.confidence}% conf)`,
              );
              onNotify?.({
                variant: 'info',
                title: 'Auto-Scanner Executed Trade',
                message: `${best.contractType}${barrierSuffix} on ${best.name} (${best.confidence}% confidence).`,
                meta: `${best.symbol} · EV ${best.expectedValuePct >= 0 ? '+' : ''}${best.expectedValuePct}% · Stake ${stake.toFixed(2)} ${currency}`,
                durationMs: 4200,
              });
            }
          } else {
            appendAutoLog(
              'info',
              `Scanned ${data.totalScanned} markets · Top: ${best.symbol} (${best.confidence}% conf, EV ${best.expectedValuePct}%) below threshold (${minConfidence}% / +${minEvPct}%). Holding fire.`,
            );
          }
        } else {
          appendAutoLog(
            'info',
            `Scanned ${data.totalScanned} markets · #1 Best: ${best.symbol} (${best.contractType}, EV ${best.expectedValuePct >= 0 ? '+' : ''}${best.expectedValuePct}%, ${best.confidence}% conf).`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Multi-market scan error';
        setScanError(msg);
        appendAutoLog('warn', msg);
      } finally {
        scanInFlightRef.current = false;
        setIsScanning(false);
      }
    },
    [
      appendAutoLog,
      currency,
      minConfidence,
      minEvPct,
      onNotify,
      onPlaceTrade,
      onSelectMarket,
      scanGroup,
      scannerStats.hasOpen,
      stake,
    ],
  );

  // Periodic Auto-Analyse & Auto-Execute Loop
  useEffect(() => {
    if (!autoExecuteActive) return;
    runMarketScan(true);
    const timer = window.setInterval(() => {
      runMarketScan(true);
    }, scanIntervalSec * 1000);
    return () => window.clearInterval(timer);
  }, [autoExecuteActive, runMarketScan, scanIntervalSec]);

  const handleToggleAutoPilot = () => {
    if (autoExecuteActive) {
      setAutoExecuteActive(false);
      appendAutoLog('info', 'Auto-Analyse & Auto-Execute stopped by user.');
      return;
    }
    if (!authenticated) {
      appendAutoLog('warn', 'Sign in with your Deriv API token to run Auto-Execute.');
      onRequireLogin?.();
      return;
    }
    autoSessionStartRef.current = Date.now();
    lastAutoTradeAtRef.current = 0;
    setAutoExecuteActive(true);
    appendAutoLog(
      'ok',
      `Started Auto-Pilot (${scanGroup} markets · every ${scanIntervalSec}s · Min ${minConfidence}% conf / +${minEvPct}% EV · TP $${autoTakeProfit} / SL $${autoStopLoss}).`,
    );
  };

  const activeMarketMeta = useMemo(
    () =>
      markets.find((m) => m.symbol === activeSymbol) ??
      DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
      markets[0] ??
      DERIV_MARKETS[1],
    [activeSymbol, markets],
  );

  const digitStats = computeDigitStats(sampleSize);

  const report = useMemo(
    () => analyzeMarketTicks(ticks, activeMarketMeta, sampleSize, stake),
    [ticks, activeMarketMeta, sampleSize, stake],
  );

  const barrierMetrics = useMemo(() => {
    const slice = ticks.slice(-sampleSize);
    const total = Math.max(1, slice.length);
    const over = slice.filter((t) => t.lastDigit > barrier).length;
    const under = slice.filter((t) => t.lastDigit < barrier).length;
    const match = slice.filter((t) => t.lastDigit === barrier).length;

    return {
      total: slice.length,
      overPct: ((over / total) * 100).toFixed(1),
      underPct: ((under / total) * 100).toFixed(1),
      matchPct: ((match / total) * 100).toFixed(1),
    };
  }, [ticks, sampleSize, barrier]);

  const buildBotFromOpportunity = (opp: StrategyEdgeOpportunity): BotStrategyConfig => {
    return {
      ...currentStrategy,
      id: `edge-${opp.id}-${Date.now()}`,
      name: `${opp.label} (${activeMarketMeta.symbol})`,
      description: opp.rationale,
      tradeParams: {
        ...currentStrategy.tradeParams,
        marketGroup: activeMarketMeta.marketGroup,
        subGroup: activeMarketMeta.subGroup,
        symbol: activeMarketMeta.symbol,
        tradeCategory: opp.tradeCategory,
        tradeType: opp.tradeType,
        contractType: opp.contractType,
      },
      variables: currentStrategy.variables.map((v) =>
        v.name === 'stake' ? { ...v, value: stake } : v,
      ),
      purchaseConditions: {
        ...currentStrategy.purchaseConditions,
        mode: opp.conditionMode,
        durationTicks: opp.duration,
        durationUnit: opp.durationUnit,
        multiplier: opp.multiplier ?? 100,
        predictionDigit: opp.barrier,
      },
    };
  };

  const emaDiff = report.ema9 - report.ema21;
  const emaDiffPct = report.ema21 > 0 ? (emaDiff / report.ema21) * 100 : 0;

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Top Controls Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
          <div>
            <h1 className="font-display font-bold text-xl text-slate-900 dark:text-slate-100">
              Quantitative Profitability &amp; Market Edge Scanner
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Live technical indicators, backtested Expected Value (EV%), and 1-click strategy deployment across all Deriv markets.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <MarketSelector
              markets={markets}
              value={activeSymbol}
              onChange={onSelectMarket}
              className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 max-w-[240px]"
            />

            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-500">Stake $</span>
              <input
                type="number"
                min={0.35}
                step={1}
                value={stake}
                onChange={(e) => setStake(Math.max(0.35, Number(e.target.value) || 10))}
                className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-xs font-semibold"
              />
            </div>

            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-900 p-1 rounded">
              {[100, 250, 500, 1000].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSampleSize(s)}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-semibold cursor-pointer ${
                    sampleSize === s
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  {s}t
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Auto-Analyse Best Market & Auto-Execute Scanner */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden shadow-xs">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-[#0E5A78]/10 dark:bg-[#00A8E8]/15 flex items-center justify-center text-[#0E5A78] dark:text-[#00A8E8]">
                <Radar className={`w-4 h-4 ${isScanning || autoExecuteActive ? 'animate-spin' : ''}`} />
              </div>
              <div>
                <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <span>Auto Market Analyser &amp; Auto-Execute</span>
                  {autoExecuteActive && (
                    <span className="font-mono text-[11px] font-bold text-teal-600 dark:text-teal-400">
                      · AUTO-PILOT ACTIVE
                    </span>
                  )}
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Scans open Deriv markets concurrently, ranks highest EV% + confidence, selects the #1 best market, and auto-executes on your Deriv account.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isScanning}
                onClick={() => runMarketScan(false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                <Activity className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
                <span>{isScanning ? 'Scanning...' : 'Scan Best Market Now'}</span>
              </button>

              <button
                type="button"
                onClick={handleToggleAutoPilot}
                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-bold text-white cursor-pointer whitespace-nowrap ${
                  autoExecuteActive
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-[#389E94] hover:bg-[#2F877E]'
                }`}
              >
                {autoExecuteActive ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop Auto-Execute</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Auto Analyse &amp; Auto Execute</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Scanner Settings & Safety Controls */}
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs bg-white dark:bg-[#0F172A]">
            <label className="flex items-center gap-1.5">
              <span className="text-slate-500">Markets:</span>
              <select
                value={scanGroup}
                onChange={(e) => setScanGroup(e.target.value as 'All' | MarketGroup)}
                className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-semibold text-xs"
              >
                {SCAN_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {g === 'All' ? 'All Open Markets' : g}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5">
              <span className="text-slate-500">Interval:</span>
              <select
                value={scanIntervalSec}
                onChange={(e) => setScanIntervalSec(Number(e.target.value))}
                className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono font-semibold text-xs"
              >
                <option value={10}>10s</option>
                <option value={15}>15s</option>
                <option value={30}>30s</option>
              </select>
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
              <span className="text-slate-500">TP ({currency}):</span>
              <input
                type="number"
                min={1}
                value={autoTakeProfit}
                onChange={(e) => setAutoTakeProfit(Math.max(1, Number(e.target.value) || 50))}
                className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
              />
            </label>

            <label className="flex items-center gap-1.5">
              <span className="text-slate-500">SL ({currency}):</span>
              <input
                type="number"
                min={1}
                value={autoStopLoss}
                onChange={(e) => setAutoStopLoss(Math.max(1, Number(e.target.value) || 100))}
                className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
              />
            </label>

            <label className="flex items-center gap-1.5">
              <span className="text-slate-500">Max Losses:</span>
              <input
                type="number"
                min={1}
                max={15}
                value={maxLossStreak}
                onChange={(e) => setMaxLossStreak(Math.max(1, Number(e.target.value) || 3))}
                className="w-12 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums text-center font-semibold"
              />
            </label>

            <button
              type="button"
              onClick={() => {
                setMinConfidence(84);
                setMinEvPct(2.0);
                setMaxLossStreak(2);
              }}
              className="px-2.5 py-1 rounded border border-[#0E5A78]/40 dark:border-[#00A8E8]/40 text-[#0E5A78] dark:text-[#00A8E8] hover:bg-sky-50 dark:hover:bg-sky-950/30 font-semibold cursor-pointer whitespace-nowrap"
            >
              Perfect Conditions Preset (84% / +2% EV)
            </button>

            {autoSessionStartRef.current > 0 && (
              <div className="ml-auto flex items-center gap-3 font-mono tabular-nums text-[11px]">
                <span className="text-slate-500">
                  Trades: <strong className="text-slate-800 dark:text-slate-200">{scannerStats.totalCount}</strong>
                </span>
                <span
                  className={`font-bold ${
                    scannerStats.netPnl >= 0
                      ? 'text-teal-600 dark:text-teal-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  Auto P/L: {scannerStats.netPnl >= 0 ? '+' : '-'}$
                  {Math.abs(scannerStats.netPnl).toFixed(2)}
                </span>
              </div>
            )}
          </div>

          {scanError && (
            <div className="px-5 py-2 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2 border-b border-rose-200 dark:border-rose-800">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{scanError}</span>
            </div>
          )}

          {/* #1 Best Market Highlight Card */}
          {scanResult?.bestOpportunity && (
            <div className="px-5 py-3.5 bg-teal-50/60 dark:bg-teal-950/20 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    #1 Best Opportunity: {scanResult.bestOpportunity.name} ({scanResult.bestOpportunity.symbol})
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#0E5A78] text-white font-mono text-[10px] font-bold">
                    {scanResult.bestOpportunity.contractType}
                    {scanResult.bestOpportunity.contractType.startsWith('DIGIT')
                      ? ` [${scanResult.bestOpportunity.barrier}]`
                      : ''}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-200 font-mono text-[10px] font-bold">
                    EV {scanResult.bestOpportunity.expectedValuePct >= 0 ? '+' : ''}
                    {scanResult.bestOpportunity.expectedValuePct}% · {scanResult.bestOpportunity.confidence}% Conf
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-300">
                  {scanResult.bestOpportunity.reasons.join(' · ') || scanResult.bestOpportunity.rationale}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    onSelectMarket(scanResult.bestOpportunity!.symbol);
                    onPlaceTrade({
                      symbol: scanResult.bestOpportunity!.symbol,
                      contractType: scanResult.bestOpportunity!.contractType,
                      barrier: scanResult.bestOpportunity!.barrier,
                      stake,
                      durationTicks: scanResult.bestOpportunity!.duration,
                      durationUnit: scanResult.bestOpportunity!.durationUnit,
                      multiplier: scanResult.bestOpportunity!.multiplier,
                      source: 'scanner',
                    });
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-bold cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Execute #1 Trade</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onApplyStrategy(buildBotFromScanOpportunity(scanResult.bestOpportunity!), true)
                  }
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-bold cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Run Bot on #1</span>
                </button>
              </div>
            </div>
          )}

          {/* Multi-Market Scan Leaderboard + Auto-Pilot Log */}
          {scanResult && scanResult.results.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
              <div className="lg:col-span-2 max-h-64 overflow-y-auto studio-scroll">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Rank / Market</th>
                      <th className="px-2 py-2 font-semibold">Contract</th>
                      <th className="px-2 py-2 font-semibold text-right">Win / BE</th>
                      <th className="px-2 py-2 font-semibold text-right">EV %</th>
                      <th className="px-2 py-2 font-semibold text-right">Conf</th>
                      <th className="px-3 py-2 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {scanResult.results.slice(0, 12).map((row, idx) => (
                      <tr
                        key={`${row.symbol}-${row.contractType}`}
                        onClick={() => onSelectMarket(row.symbol)}
                        className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                          row.symbol === activeSymbol
                            ? 'bg-sky-50/60 dark:bg-sky-950/20'
                            : ''
                        }`}
                      >
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-100">
                            <span className="font-mono text-[10px] text-slate-400">
                              #{idx + 1}
                            </span>
                            <span className="truncate max-w-[150px]">{row.name}</span>
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {row.symbol} · {row.marketGroup} · {row.regime}
                          </div>
                        </td>
                        <td className="px-2 py-2 font-mono text-[11px] font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                          {row.contractType}
                          {row.contractType.startsWith('DIGIT') ? ` [${row.barrier}]` : ''}
                        </td>
                        <td className="px-2 py-2 text-right font-mono tabular-nums">
                          {row.winRatePct}% / <span className="text-slate-400">{row.breakEvenPct}%</span>
                        </td>
                        <td
                          className={`px-2 py-2 text-right font-mono font-bold tabular-nums ${
                            row.expectedValuePct > 0
                              ? 'text-teal-600 dark:text-teal-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {row.expectedValuePct >= 0 ? '+' : ''}
                          {row.expectedValuePct}%
                        </td>
                        <td className="px-2 py-2 text-right font-mono font-bold tabular-nums">
                          <span
                            className={
                              row.approved
                                ? 'text-teal-600 dark:text-teal-400'
                                : 'text-slate-500'
                            }
                          >
                            {row.confidence}%
                          </span>
                        </td>
                        <td
                          className="px-3 py-2 text-right whitespace-nowrap"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              onSelectMarket(row.symbol);
                              onPlaceTrade({
                                symbol: row.symbol,
                                contractType: row.contractType,
                                barrier: row.barrier,
                                stake,
                                durationTicks: row.duration,
                                durationUnit: row.durationUnit,
                                multiplier: row.multiplier,
                                source: 'scanner',
                              });
                            }}
                            className="px-2 py-1 rounded bg-[#0E5A78] hover:bg-[#0B4861] text-white text-[10px] font-bold cursor-pointer"
                          >
                            Trade
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Auto-Pilot Execution Activity Feed */}
              <div className="p-3 bg-slate-50/50 dark:bg-slate-900/40 max-h-64 overflow-y-auto studio-scroll space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Auto-Pilot Execution Log
                </div>
                {autoLog.length === 0 ? (
                  <p className="text-[11px] text-slate-400">
                    Click &ldquo;Scan Best Market Now&rdquo; or &ldquo;Auto Analyse &amp; Auto Execute&rdquo; to inspect multi-market signals.
                  </p>
                ) : (
                  autoLog.map((entry) => (
                    <div
                      key={entry.id}
                      className={`text-[11px] rounded px-2 py-1 border ${
                        entry.level === 'ok'
                          ? 'bg-teal-50/70 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800 text-teal-900 dark:text-teal-200'
                          : entry.level === 'warn'
                            ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
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
          )}
        </div>

        {/* 4-Column Quantitative Regime Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Market Regime ({activeMarketMeta.marketGroup})
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                {report.regime}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                  report.trendDirection === 'BULLISH'
                    ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300'
                    : report.trendDirection === 'BEARISH'
                      ? 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                }`}
              >
                {report.trendDirection}
              </span>
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 font-mono tabular-nums">
            <div className="text-[11px] font-sans font-medium text-slate-500 dark:text-slate-400">
              EMA(9) / EMA(21) Spread
            </div>
            <div
              className={`mt-1 text-sm font-bold ${
                emaDiff >= 0
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
            >
              {emaDiff >= 0 ? '+' : ''}
              {emaDiff.toFixed(activeMarketMeta.pipSize)} ({emaDiffPct >= 0 ? '+' : ''}
              {emaDiffPct.toFixed(3)}%)
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">
              EMA9: {report.ema9.toFixed(activeMarketMeta.pipSize)}
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 font-mono tabular-nums">
            <div className="text-[11px] font-sans font-medium text-slate-500 dark:text-slate-400">
              RSI(14) &amp; Bollinger %B
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span
                className={`text-sm font-bold ${
                  report.rsi14 >= 68
                    ? 'text-rose-600 dark:text-rose-400'
                    : report.rsi14 <= 32
                      ? 'text-teal-600 dark:text-teal-400'
                      : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                RSI {report.rsi14}
              </span>
              <span className="text-xs text-slate-500">BB {report.bollingerPctB}%</span>
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">
              {report.rsi14 <= 32
                ? 'Oversold zone'
                : report.rsi14 >= 68
                  ? 'Overbought zone'
                  : 'Neutral equilibrium'}
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Volatility &amp; Contract Modes
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100 tabular-nums">
                {report.volatilityBps} bps
              </span>
              <div className="flex items-center gap-1 text-[10px] font-semibold">
                {activeMarketMeta.supportsDigits && (
                  <span className="px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300">
                    Digits
                  </span>
                )}
                {activeMarketMeta.supportsRiseFall !== false && (
                  <span className="px-1.5 py-0.5 rounded bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300">
                    Rise/Fall
                  </span>
                )}
                {activeMarketMeta.supportsMultipliers && (
                  <span className="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300">
                    Mult
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Ranked Profitability Backtest Scanner */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-teal-600 dark:text-teal-400" />
              <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                Profitability &amp; Expected Value Backtest ({report.sampleSize} live ticks · ${stake} stake)
              </h2>
            </div>
            {report.topOpportunity && (
              <span className="text-xs font-mono font-semibold text-teal-700 dark:text-teal-400">
                Best Edge: {report.topOpportunity.contractType} (EV{' '}
                {report.topOpportunity.expectedValuePct >= 0 ? '+' : ''}
                {report.topOpportunity.expectedValuePct}%)
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-900/70 text-[11px] text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Strategy Setup</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Signals</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Win Rate / BE</th>
                  <th className="px-3 py-2.5 font-semibold text-right">EV %</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Backtest Net</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Profit Factor</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {report.opportunities.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      Collecting live tick window ({report.sampleSize} ticks)... Waiting for 25+ ticks to backtest setups.
                    </td>
                  </tr>
                ) : (
                  report.opportunities.map((opp, idx) => (
                    <tr
                      key={opp.id}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                        idx === 0 && opp.expectedValuePct > 0
                          ? 'bg-teal-50/40 dark:bg-teal-950/15'
                          : ''
                      }`}
                    >
                      <td className="px-4 py-3 max-w-sm">
                        <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                          <span>{opp.label}</span>
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[10px]">
                            {opp.contractType}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                          {opp.rationale}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {opp.sampleTrades}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums">
                        <span
                          className={`font-bold ${
                            opp.winRatePct >= opp.breakEvenPct
                              ? 'text-teal-600 dark:text-teal-400'
                              : 'text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {opp.winRatePct}%
                        </span>
                        <span className="text-slate-400 text-[10px] block">
                          BE {opp.breakEvenPct}%
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono font-bold tabular-nums">
                        <span
                          className={
                            opp.expectedValuePct > 0
                              ? 'text-teal-600 dark:text-teal-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }
                        >
                          {opp.expectedValuePct >= 0 ? '+' : ''}
                          {opp.expectedValuePct}%
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono font-bold tabular-nums">
                        <span
                          className={
                            opp.simulatedNetUsd >= 0
                              ? 'text-teal-600 dark:text-teal-400'
                              : 'text-rose-600 dark:text-rose-400'
                          }
                        >
                          {opp.simulatedNetUsd >= 0 ? '+' : '-'}$
                          {Math.abs(opp.simulatedNetUsd).toFixed(2)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {opp.profitFactor.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              onPlaceTrade({
                                symbol: activeMarketMeta.symbol,
                                contractType: opp.contractType,
                                barrier: opp.barrier,
                                stake,
                                durationTicks: opp.duration,
                                durationUnit: opp.durationUnit,
                                multiplier: opp.multiplier,
                                source: 'manual',
                              })
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#0E5A78] hover:bg-[#0B4861] text-white text-[11px] font-semibold cursor-pointer"
                          >
                            <Zap className="w-3 h-3" />
                            <span>Trade</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onApplyStrategy(buildBotFromOpportunity(opp), false)
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-semibold cursor-pointer"
                          >
                            <Sliders className="w-3 h-3" />
                            <span>Load</span>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onApplyStrategy(buildBotFromOpportunity(opp), true)
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#389E94] hover:bg-[#2F877E] text-white text-[11px] font-bold cursor-pointer"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>Run Bot</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Digit Distribution & Barrier Inspector (or Non-Digit Note) */}
        {activeMarketMeta.supportsDigits ? (
          <>
            <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Last Digit Frequency Histogram ({barrierMetrics.total} ticks)
                </h2>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="text-teal-600 dark:text-teal-400 font-semibold">
                    Hot Digit ({report.hottestDigit}: {report.hottestDigitPct}%)
                  </span>
                  <span className="text-rose-600 dark:text-rose-400 font-semibold">
                    Cold Digit ({report.coldestDigit}: {report.coldestDigitPct}%)
                  </span>
                </div>
              </div>
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={digitStats}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} vertical={false} />
                    <XAxis dataKey="digit" tick={{ fontSize: 12 }} />
                    <YAxis unit="%" width={42} tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(v) => [`${v}%`, 'Frequency']}
                      labelFormatter={(l) => `Digit ${l}`}
                      contentStyle={{ fontSize: '11px', borderRadius: '6px' }}
                    />
                    <Bar dataKey="pct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {digitStats.map((entry) => (
                        <Cell
                          key={entry.digit}
                          fill={
                            entry.isHot
                              ? '#0d9488'
                              : entry.isCold
                                ? '#e11d48'
                                : '#00A8E8'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                    Over / Under Barrier Breakdown
                  </h3>
                  <span className="font-mono text-xs font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                    Barrier: {barrier}
                  </span>
                </div>

                <div className="grid grid-cols-10 gap-1">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setBarrier(d)}
                      className={`py-1.5 rounded font-mono text-xs font-bold cursor-pointer ${
                        barrier === d
                          ? 'bg-[#0E5A78] text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-3 gap-3 text-center font-mono tabular-nums pt-2">
                  <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500 font-sans">Under {barrier}</div>
                    <div className="mt-1 text-base font-bold text-indigo-600 dark:text-indigo-400">
                      {barrierMetrics.underPct}%
                    </div>
                  </div>
                  <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500 font-sans">Exact {barrier}</div>
                    <div className="mt-1 text-base font-bold text-slate-900 dark:text-slate-100">
                      {barrierMetrics.matchPct}%
                    </div>
                  </div>
                  <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[11px] text-slate-500 font-sans">Over {barrier}</div>
                    <div className="mt-1 text-base font-bold text-teal-600 dark:text-teal-400">
                      {barrierMetrics.overPct}%
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
                <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Live Parity Streak Monitor
                </h3>
                <div className="grid grid-cols-2 gap-4 font-mono tabular-nums">
                  <div className="p-4 rounded bg-teal-50/70 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800">
                    <div className="text-xs font-sans text-teal-800 dark:text-teal-300">
                      Active Even Streak ({report.evenPct}%)
                    </div>
                    <div className="mt-1 text-2xl font-bold text-teal-700 dark:text-teal-400">
                      {report.currentEvenStreak} ticks
                    </div>
                  </div>
                  <div className="p-4 rounded bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800">
                    <div className="text-xs font-sans text-sky-800 dark:text-sky-300">
                      Active Odd Streak ({report.oddPct}%)
                    </div>
                    <div className="mt-1 text-2xl font-bold text-sky-700 dark:text-sky-400">
                      {report.currentOddStreak} ticks
                    </div>
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Calibrated parity streaks and coldest-digit frequency backtests update automatically on every live tick.
                </p>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div>
              <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                Directional &amp; Volatility Market ({activeMarketMeta.name})
              </h3>
              <p className="mt-1 text-slate-500 dark:text-slate-400">
                {activeMarketMeta.marketGroup} · {activeMarketMeta.subGroup} uses{' '}
                {activeMarketMeta.supportsRiseFall !== false
                  ? `Rise/Fall (${activeMarketMeta.defaultDuration ?? 15}${activeMarketMeta.defaultDurationUnit ?? 'm'})`
                  : 'Deriv Multipliers (MULTUP/MULTDOWN)'}{' '}
                contracts. Bollinger Band Range: {report.bollingerLower.toFixed(activeMarketMeta.pipSize)} –{' '}
                {report.bollingerUpper.toFixed(activeMarketMeta.pipSize)}.
              </p>
            </div>
            {activeMarketMeta.exchangeOpen === false && (
              <span className="px-2.5 py-1 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 font-semibold">
                Market session currently closed
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
