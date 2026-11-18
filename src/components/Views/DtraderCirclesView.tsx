import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Circle,
  CloudUpload,
  Play,
  Radar,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import type { DigitStat } from '../../hooks/useDerivMarket.ts';
import { derivFetch, parseJsonResponse } from '../../lib/derivClient.ts';
import { saveScannerSessionLog } from '../../lib/firebase.ts';
import { evaluateDtraderPerfectSetup } from '../../lib/marketAnalysis.ts';
import {
  DERIV_MARKETS,
  type AppToastInput,
  type ContractTypeOption,
  type DurationUnit,
  type MarketScanResponse,
  type MarketSymbol,
  type TickPoint,
  type TradeTransaction,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface DtraderCirclesViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  currency?: string;
  authenticated?: boolean;
  ticks: TickPoint[];
  latestTick: TickPoint | null;
  transactions?: TradeTransaction[];
  computeDigitStats: (sampleSize: number) => DigitStat[];
  onSelectMarket: (symbol: string) => void;
  onRequireLogin?: () => void;
  onNotify?: (toast: AppToastInput) => void;
  onPlaceTrade: (params: {
    symbol: string;
    contractType: ContractTypeOption;
    barrier: number;
    stake: number;
    durationTicks: number;
    durationUnit?: DurationUnit;
    source: 'manual' | 'scanner';
  }) => boolean;
}

export function DtraderCirclesView({
  activeSymbol,
  markets = DERIV_MARKETS,
  currency = 'USD',
  authenticated = false,
  ticks,
  latestTick,
  transactions = [],
  computeDigitStats,
  onSelectMarket,
  onRequireLogin,
  onNotify,
  onPlaceTrade,
}: DtraderCirclesViewProps) {
  const { user } = useAuth();
  const [sampleSize, setSampleSize] = useState<number>(1000);
  const [selectedDigit, setSelectedDigit] = useState<number>(4);
  const [stake, setStake] = useState<number>(5);
  const [durationTicks, setDurationTicks] = useState<number>(1);

  // Master 7-Gate 1000-Tick DTrader Auto-Sniper state
  const [autoSniperActive, setAutoSniperActive] = useState(false);
  const [autoHopMarkets, setAutoHopMarkets] = useState(true);
  const [minConfidence, setMinConfidence] = useState(88);
  const [minEvPct, setMinEvPct] = useState(2.5);
  const [minZScore, setMinZScore] = useState(-1.75);
  const [minMarkovSurvivalPct, setMinMarkovSurvivalPct] = useState(91.5);
  const [circuitBreakerHopOnLoss, setCircuitBreakerHopOnLoss] = useState(true);
  const [useCappedRecovery, setUseCappedRecovery] = useState(true);
  const [lossCooldownSec, setLossCooldownSec] = useState(25);
  const [takeProfitUsd, setTakeProfitUsd] = useState(25);
  const [stopLossUsd, setStopLossUsd] = useState(40);
  const [isScanningHop, setIsScanningHop] = useState(false);
  const [savingLog, setSavingLog] = useState(false);
  const [lastSniperAction, setLastSniperAction] = useState<string>(
    'Evaluating 1,000-tick Tri-Horizon & Markov chain — fires strictly when all 7 Master Gates turn green.',
  );

  const sessionStartRef = useRef<number>(Date.now());
  const lastTradeEpochRef = useRef<number>(0);
  const cooldownUntilRef = useRef<number>(0);
  const lossStreakRef = useRef<number>(0);
  const processedSettledRef = useRef<Set<string>>(new Set());
  const lastHopScanRef = useRef<number>(0);

  const activeMarketMeta = useMemo(
    () =>
      markets.find((m) => m.symbol === activeSymbol) ??
      DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
      markets[0] ??
      DERIV_MARKETS[1],
    [activeSymbol, markets],
  );
  const supportsDigits = activeMarketMeta ? activeMarketMeta.supportsDigits !== false : true;

  const digitStats = computeDigitStats(sampleSize);
  const recent20 = ticks.slice(-20);
  const evenCount = ticks.slice(-sampleSize).filter((t) => t.lastDigit % 2 === 0).length;
  const sampleLen = Math.max(1, Math.min(sampleSize, ticks.length));
  const evenPct = ((evenCount / sampleLen) * 100).toFixed(1);
  const oddPct = (100 - Number(evenPct)).toFixed(1);

  const perfectSetup = useMemo(
    () =>
      evaluateDtraderPerfectSetup(ticks, activeMarketMeta, {
        minConfidence,
        minEvPct,
        minZScore,
        minBufferTicks: 300,
        minMarkovSurvivalPct,
      }),
    [activeMarketMeta, minConfidence, minEvPct, minMarkovSurvivalPct, minZScore, ticks],
  );

  const sniperSessionStats = useMemo(() => {
    const start = sessionStartRef.current;
    const relevant = transactions.filter(
      (t) => t.source === 'scanner' && t.timestamp >= start,
    );
    let netPnl = 0;
    let won = 0;
    let lost = 0;
    let hasOpen = false;
    for (const tx of relevant) {
      if (tx.status === 'open') {
        hasOpen = true;
      } else {
        netPnl += tx.profit;
        if (tx.status === 'won') won += 1;
        if (tx.status === 'lost') lost += 1;
      }
    }
    return {
      total: relevant.length,
      won,
      lost,
      hasOpen,
      netPnl: Number(netPnl.toFixed(2)),
      recent: relevant.slice(0, 6),
    };
  }, [transactions]);

  // Update capped recovery streak & cooldown on settled DTrader sniper trades
  useEffect(() => {
    const start = sessionStartRef.current;
    const settled = transactions.filter(
      (t) =>
        t.source === 'scanner' &&
        t.timestamp >= start &&
        (t.status === 'won' || t.status === 'lost') &&
        !processedSettledRef.current.has(t.id),
    );
    if (settled.length === 0) return;

    for (const tx of settled) {
      processedSettledRef.current.add(tx.id);
      if (tx.status === 'won') {
        lossStreakRef.current = 0;
        cooldownUntilRef.current = 0;
      } else {
        lossStreakRef.current += 1;
        if (lossStreakRef.current > 2) {
          lossStreakRef.current = 0; // Hard cap recovery at 2 steps
        }
        if (lossCooldownSec > 0) {
          cooldownUntilRef.current = Date.now() + lossCooldownSec * 1000;
        }
        if (circuitBreakerHopOnLoss && autoHopMarkets) {
          setLastSniperAction('Loss circuit-breaker triggered: locking cooldown & hopping to freshest 1,000t market.');
          void scanBestDigitMarket();
        }
      }
    }
  }, [autoHopMarkets, circuitBreakerHopOnLoss, lossCooldownSec, transactions]);

  // Auto-stop when TP / SL reached
  useEffect(() => {
    if (!autoSniperActive) return;
    if (sniperSessionStats.netPnl >= takeProfitUsd) {
      setAutoSniperActive(false);
      setLastSniperAction(
        `Take Profit target hit (+${sniperSessionStats.netPnl.toFixed(2)} ${currency}). DTrader Sniper stopped.`,
      );
      onNotify?.({
        variant: 'success',
        title: 'DTrader Auto-Sniper TP Reached',
        message: `Locked +${sniperSessionStats.netPnl.toFixed(2)} ${currency} across ${sniperSessionStats.won} wins.`,
        persistent: true,
      });
    } else if (sniperSessionStats.netPnl <= -Math.abs(stopLossUsd)) {
      setAutoSniperActive(false);
      setLastSniperAction(
        `Stop Loss limit reached (${sniperSessionStats.netPnl.toFixed(2)} ${currency}). Capital protected.`,
      );
      onNotify?.({
        variant: 'error',
        title: 'DTrader Auto-Sniper Stop Loss Hit',
        message: 'Stopped automatically at session stop-loss ceiling.',
        persistent: true,
      });
    }
  }, [autoSniperActive, currency, onNotify, sniperSessionStats, stopLossUsd, takeProfitUsd]);

  const scanBestDigitMarket = useCallback(async () => {
    if (isScanningHop) return;
    setIsScanningHop(true);
    try {
      const res = await derivFetch('/api/deriv/scan-markets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'Derived',
          stake,
          minConfidence,
          minEvPct,
          perfectOnly: true,
          maxMarkets: 24,
          sortBy: 'score',
        }),
      });
      if (!res.ok) return;
      const data = await parseJsonResponse<MarketScanResponse>(res);
      const bestDigitMarket = data.results.find((opp) => {
        const meta = markets.find((m) => m.symbol === opp.symbol);
        return meta?.supportsDigits !== false && opp.contractType.startsWith('DIGIT');
      });
      if (bestDigitMarket && bestDigitMarket.symbol !== activeSymbol) {
        onSelectMarket(bestDigitMarket.symbol);
        setSelectedDigit(bestDigitMarket.barrier);
        setLastSniperAction(
          `Hopped to ${bestDigitMarket.name} (${bestDigitMarket.contractType} [${bestDigitMarket.barrier}], Conf ${bestDigitMarket.confidence}%, EV ${bestDigitMarket.expectedValuePct >= 0 ? '+' : ''}${bestDigitMarket.expectedValuePct}%).`,
        );
      } else if (bestDigitMarket) {
        setLastSniperAction(
          `Confirmed ${bestDigitMarket.name} remains top digit market (${bestDigitMarket.confidence}% conf).`,
        );
      }
    } catch {
      // Keep active market on transient scan error
    } finally {
      setIsScanningHop(false);
    }
  }, [activeSymbol, isScanningHop, markets, minConfidence, minEvPct, onSelectMarket, stake]);

  // Automated "Perfect Conditions Only" DTrader Execution Loop
  useEffect(() => {
    if (!autoSniperActive || !latestTick) return;
    if (!authenticated) {
      setAutoSniperActive(false);
      onRequireLogin?.();
      return;
    }
    if (!supportsDigits) {
      if (autoHopMarkets) scanBestDigitMarket();
      return;
    }
    if (sniperSessionStats.hasOpen) {
      setLastSniperAction('Waiting for active DTrader contract settlement...');
      return;
    }
    const now = Date.now();
    if (cooldownUntilRef.current > now) {
      const secs = Math.ceil((cooldownUntilRef.current - now) / 1000);
      setLastSniperAction(`Post-loss capital cooldown active (${secs}s remaining)...`);
      return;
    }
    if (latestTick.epoch === lastTradeEpochRef.current) return;

    if (!perfectSetup.allGatesPassed) {
      if (autoHopMarkets && now - lastHopScanRef.current > 18000) {
        lastHopScanRef.current = now;
        scanBestDigitMarket();
      }
      return;
    }

    lastTradeEpochRef.current = latestTick.epoch;
    const recoveryMult = useCappedRecovery
      ? Math.pow(2.1, Math.min(2, lossStreakRef.current))
      : 1;
    const effectiveStake = Math.max(0.35, Number((stake * recoveryMult).toFixed(2)));
    setSelectedDigit(perfectSetup.barrier);

    const ok = onPlaceTrade({
      symbol: activeSymbol,
      contractType: perfectSetup.contractType,
      barrier: perfectSetup.barrier,
      stake: effectiveStake,
      durationTicks,
      durationUnit: 't',
      source: 'scanner',
    });

    if (ok) {
      setLastSniperAction(
        `PERFECT ENTRY FIRED: ${perfectSetup.contractType}${perfectSetup.contractType === 'DIGITEVEN' || perfectSetup.contractType === 'DIGITODD' ? '' : ` [${perfectSetup.barrier}]`} · ${perfectSetup.confidence}% Conf · EV +${perfectSetup.expectedValuePct}% · Stake $${effectiveStake.toFixed(2)}`,
      );
      onNotify?.({
        variant: 'info',
        title: 'DTrader Perfect-Condition Entry',
        message: `${perfectSetup.contractType} [${perfectSetup.barrier}] on ${activeMarketMeta.name}`,
        meta: `Conf ${perfectSetup.confidence}% · EV +${perfectSetup.expectedValuePct}% · $${effectiveStake.toFixed(2)}`,
        durationMs: 4000,
      });
    }
  }, [
    activeMarketMeta.name,
    activeSymbol,
    authenticated,
    autoHopMarkets,
    autoSniperActive,
    durationTicks,
    latestTick,
    onNotify,
    onPlaceTrade,
    onRequireLogin,
    perfectSetup,
    scanBestDigitMarket,
    sniperSessionStats.hasOpen,
    stake,
    supportsDigits,
    useCappedRecovery,
  ]);

  const toggleAutoSniper = () => {
    if (autoSniperActive) {
      setAutoSniperActive(false);
      setLastSniperAction('DTrader Auto-Sniper paused.');
      return;
    }
    if (!authenticated) {
      onRequireLogin?.();
      return;
    }
    sessionStartRef.current = Date.now();
    lossStreakRef.current = 0;
    cooldownUntilRef.current = 0;
    setAutoSniperActive(true);
    setLastSniperAction('Armed Master 7-Gate 1,000-Tick DTrader Sniper. Scanning live feeds...');
  };

  const handleSaveCloudLog = async () => {
    if (!user || savingLog) return;
    setSavingLog(true);
    try {
      await saveScannerSessionLog(user.uid, {
        symbol: perfectSetup.symbol,
        contractType: perfectSetup.contractType,
        barrier: perfectSetup.barrier,
        sampleSize: perfectSetup.sampleDepth,
        winRatePct: perfectSetup.winRatePct,
        evPct: perfectSetup.expectedValuePct,
        confidence: perfectSetup.confidence,
        netPnl: sniperSessionStats.netPnl,
        wins: sniperSessionStats.won,
        losses: sniperSessionStats.lost,
        rationale: perfectSetup.reasons[0] || 'Master 7-gate DTrader session log',
      });
      onNotify?.({
        variant: 'success',
        title: 'DTrader Snapshot Saved',
        message: `Logged 1,000t ${perfectSetup.symbol} (${perfectSetup.contractType}) stats to Cloud.`,
        durationMs: 3500,
      });
    } catch {
      onNotify?.({
        variant: 'error',
        title: 'Cloud Save Failed',
        message: 'Could not save DTrader snapshot to Firestore.',
        durationMs: 4000,
      });
    } finally {
      setSavingLog(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-6xl mx-auto space-y-5">
        {/* Header Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <MarketSelector
              markets={markets}
              value={activeSymbol}
              onChange={onSelectMarket}
              digitsOnly
              className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold"
            />

            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-900 p-1 rounded-md">
              {[50, 100, 250, 500, 1000].map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => setSampleSize(sz)}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-semibold cursor-pointer ${
                    sampleSize === sz
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {sz}t
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs">
            <div>
              <span className="text-slate-500 mr-1.5">Even / Odd:</span>
              <span className="font-mono font-bold text-teal-600 dark:text-teal-400 tabular-nums">
                {evenPct}%
              </span>
              <span className="mx-1 text-slate-400">/</span>
              <span className="font-mono font-bold text-sky-600 dark:text-sky-400 tabular-nums">
                {oddPct}%
              </span>
            </div>
            <div className="font-mono text-base font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {latestTick ? latestTick.formattedQuote : '—'}
            </div>
          </div>
        </div>

        {/* DTrader Perfect-Condition Automated Sniper Strip */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Radar className={`w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8] ${autoSniperActive || isScanningHop ? 'animate-spin' : ''}`} />
              <div>
                <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Master 7-Gate 1,000-Tick DTrader Auto-Sniper
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Evaluates 1,000t / 250t / 60t Tri-Horizon confluence, 10×10 Markov survival probabilities, 10-tick anti-cluster guard, Dual-Z, and loss circuit-breakers.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {user && (
                <button
                  type="button"
                  disabled={savingLog}
                  onClick={handleSaveCloudLog}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-semibold cursor-pointer whitespace-nowrap"
                >
                  <CloudUpload className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                  <span>{savingLog ? 'Saving...' : 'Save Session'}</span>
                </button>
              )}
              <button
                type="button"
                disabled={isScanningHop}
                onClick={scanBestDigitMarket}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                <Activity className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
                <span>{isScanningHop ? 'Scanning 1,000t...' : 'Hop Best 1,000t Market'}</span>
              </button>
              <button
                type="button"
                onClick={toggleAutoSniper}
                className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-bold text-white cursor-pointer whitespace-nowrap ${
                  autoSniperActive
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-[#389E94] hover:bg-[#2F877E]'
                }`}
              >
                {autoSniperActive ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop Auto-Sniper</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Start Master Sniper</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="p-4 space-y-3 text-xs">
            {/* Risk & Threshold Controls */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3 border-b border-slate-100 dark:border-slate-800">
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Min Conf %:</span>
                <input
                  type="number"
                  min={70}
                  max={97}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(Math.min(97, Math.max(70, Number(e.target.value) || 88)))}
                  className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Min EV %:</span>
                <input
                  type="number"
                  step={0.2}
                  min={0}
                  max={25}
                  value={minEvPct}
                  onChange={(e) => setMinEvPct(Math.max(0, Number(e.target.value) || 2.5))}
                  className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Dual-Z &lt;=:</span>
                <input
                  type="number"
                  step={0.05}
                  max={0}
                  min={-3.5}
                  value={minZScore}
                  onChange={(e) => setMinZScore(Number(e.target.value) || -1.75)}
                  className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Markov % &gt;=:</span>
                <input
                  type="number"
                  step={0.2}
                  min={85}
                  max={99}
                  value={minMarkovSurvivalPct}
                  onChange={(e) => setMinMarkovSurvivalPct(Math.min(99, Math.max(85, Number(e.target.value) || 91.5)))}
                  className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">Cooldown (s):</span>
                <input
                  type="number"
                  min={0}
                  max={180}
                  value={lossCooldownSec}
                  onChange={(e) => setLossCooldownSec(Math.max(0, Number(e.target.value) || 0))}
                  className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="text-slate-500">TP / SL ($):</span>
                <input
                  type="number"
                  min={1}
                  value={takeProfitUsd}
                  onChange={(e) => setTakeProfitUsd(Math.max(1, Number(e.target.value) || 25))}
                  className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
                <span className="text-slate-400">/</span>
                <input
                  type="number"
                  min={1}
                  value={stopLossUsd}
                  onChange={(e) => setStopLossUsd(Math.max(1, Number(e.target.value) || 40))}
                  className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
                />
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={autoHopMarkets}
                  onChange={(e) => setAutoHopMarkets(e.target.checked)}
                  className="rounded border-slate-400 text-[#0E5A78]"
                />
                <span>Auto Market-Hop</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={circuitBreakerHopOnLoss}
                  onChange={(e) => setCircuitBreakerHopOnLoss(e.target.checked)}
                  className="rounded border-slate-400 text-[#0E5A78]"
                />
                <span>Loss Circuit-Hop</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={useCappedRecovery}
                  onChange={(e) => setUseCappedRecovery(e.target.checked)}
                  className="rounded border-slate-400 text-[#0E5A78]"
                />
                <span>2-Step Recovery (2.1x)</span>
              </label>
            </div>

            {/* Live 7-Gate Master Readiness Checklist + Tri-Horizon & Session KPIs */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
              <div className="lg:col-span-8 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-2">
                {perfectSetup.checklist.map((gate) => (
                  <div
                    key={gate.label}
                    className={`rounded-md border p-2.5 flex flex-col justify-between ${
                      gate.passed
                        ? 'bg-teal-50/70 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800'
                        : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="flex items-start gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                      {gate.passed ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      )}
                      <span className="leading-tight">{gate.label}</span>
                    </div>
                    <div className="mt-1.5 font-mono text-[11px] font-bold tabular-nums text-slate-900 dark:text-slate-100 truncate">
                      {gate.value}
                    </div>
                  </div>
                ))}
              </div>

              <div className="lg:col-span-4 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                    <ShieldCheck className={`w-3.5 h-3.5 ${perfectSetup.allGatesPassed ? 'text-teal-600' : 'text-amber-500'}`} />
                    <span>Master Setup ({perfectSetup.symbol} · {perfectSetup.sampleDepth}t)</span>
                  </div>
                  <div className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                    {perfectSetup.contractType} [{perfectSetup.barrier}] · EV {perfectSetup.expectedValuePct >= 0 ? '+' : ''}{perfectSetup.expectedValuePct}%
                  </div>
                  <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
                    1k: {perfectSetup.horizonBreakdown.h1000}% · 250t: {perfectSetup.horizonBreakdown.h250}% · 60t: {perfectSetup.horizonBreakdown.h60}% · Markov {perfectSetup.markovSurvivalPct}%
                  </div>
                  <div className="text-[11px] text-slate-500 truncate max-w-[260px] mt-0.5">
                    {lastSniperAction}
                  </div>
                </div>
                <div className="text-right font-mono tabular-nums shrink-0">
                  <div className="text-[10px] text-slate-400">Session P/L</div>
                  <div
                    className={`text-sm font-bold ${
                      sniperSessionStats.netPnl >= 0
                        ? 'text-teal-600 dark:text-teal-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    {sniperSessionStats.netPnl >= 0 ? '+' : ''}${sniperSessionStats.netPnl.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {sniperSessionStats.won}W / {sniperSessionStats.lost}L
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {!supportsDigits && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-4">
            <span>
              <strong>{activeMarketMeta?.name || activeSymbol}</strong> does not support Digits contracts on Deriv. Switch to a Volatility, Jump, or Daily Reset index above to place Digits trades.
            </span>
            <button
              type="button"
              onClick={() => onSelectMarket('R_25')}
              className="px-3 py-1 rounded bg-amber-600 text-white font-semibold shrink-0 cursor-pointer"
            >
              Switch to Volatility 25
            </button>
          </div>
        )}

        {/* 0-9 Digit Circles Ring Grid */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-6">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-6">
            {digitStats.map((stat) => {
              const isCurrent = latestTick?.lastDigit === stat.digit;
              const isSelected = selectedDigit === stat.digit;
              const isRecommended = perfectSetup.barrier === stat.digit && perfectSetup.contractType === 'DIGITDIFF';
              const circumference = 2 * Math.PI * 36;
              const fillRatio = Math.min(1, stat.pct / 25);
              const strokeOffset = circumference * (1 - fillRatio);

              const ringColor = stat.isHot
                ? '#0d9488'
                : stat.isCold
                  ? '#e11d48'
                  : '#00A8E8';

              return (
                <button
                  key={stat.digit}
                  type="button"
                  onClick={() => setSelectedDigit(stat.digit)}
                  className={`flex flex-col items-center p-3 rounded-lg border transition-all cursor-pointer ${
                    isSelected
                      ? 'border-[#00A8E8] bg-sky-50/70 dark:bg-sky-950/30'
                      : isRecommended
                        ? 'border-teal-400/70 dark:border-teal-700 bg-teal-50/30 dark:bg-teal-950/15'
                        : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="relative w-24 h-24 flex items-center justify-center">
                    <svg className="w-24 h-24 -rotate-90" viewBox="0 0 88 88">
                      <circle
                        cx="44"
                        cy="44"
                        r="36"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="6"
                        className="text-slate-200 dark:text-slate-800"
                      />
                      <circle
                        cx="44"
                        cy="44"
                        r="36"
                        fill="none"
                        stroke={ringColor}
                        strokeWidth="6"
                        strokeDasharray={circumference}
                        strokeDashoffset={strokeOffset}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span
                        className={`font-mono text-2xl font-bold tabular-nums ${
                          isCurrent
                            ? 'text-[#00A8E8] scale-110 transition-transform'
                            : 'text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        {stat.digit}
                      </span>
                      <span className="font-mono text-[11px] font-semibold text-slate-600 dark:text-slate-300 tabular-nums">
                        {stat.pct}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    {stat.isHot ? 'Hot' : stat.isCold ? 'Cold' : `${stat.count} hits`}
                    {isRecommended ? ' · Target' : ''}
                    {isCurrent ? ' · Live' : ''}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Live Last-20 Digit Tape */}
          <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 mr-2">
              Last 20 Digits:
            </span>
            {recent20.map((t, idx) => (
              <span
                key={`${t.epoch}-${idx}`}
                className={`w-7 h-7 rounded flex items-center justify-center font-mono text-xs font-bold tabular-nums ${
                  idx === recent20.length - 1
                    ? 'bg-[#0E5A78] text-white'
                    : t.lastDigit % 2 === 0
                      ? 'bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800'
                      : 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800'
                }`}
              >
                {t.lastDigit}
              </span>
            ))}
          </div>
        </div>

        {/* Instant Digit Execution Strip */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div>
              <span className="text-slate-500 block mb-1">Selected Digit</span>
              <span className="font-mono text-base font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                Digit {selectedDigit}
              </span>
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Stake ({currency})</label>
              <input
                type="number"
                min={0.35}
                step={0.5}
                value={stake}
                onChange={(e) => setStake(Math.max(0.35, Number(e.target.value) || 1))}
                className="w-24 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-slate-500 mb-1">Ticks</label>
              <input
                type="number"
                min={1}
                max={10}
                value={durationTicks}
                onChange={(e) =>
                  setDurationTicks(Math.min(10, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-20 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono tabular-nums"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { type: 'DIGITDIFF', label: `Differs ${selectedDigit}`, cls: 'bg-[#389E94] hover:bg-[#2F877E]' },
                { type: 'DIGITMATCH', label: `Matches ${selectedDigit}`, cls: 'bg-[#0E5A78] hover:bg-[#0B4861]' },
                { type: 'DIGITOVER', label: `Over ${selectedDigit}`, cls: 'bg-sky-600 hover:bg-sky-700' },
                { type: 'DIGITUNDER', label: `Under ${selectedDigit}`, cls: 'bg-indigo-600 hover:bg-indigo-700' },
                { type: 'DIGITEVEN', label: 'Even', cls: 'bg-teal-700 hover:bg-teal-800' },
                { type: 'DIGITODD', label: 'Odd', cls: 'bg-slate-700 hover:bg-slate-800' },
              ] as { type: ContractTypeOption; label: string; cls: string }[]
            ).map((btn) => (
              <button
                key={btn.type}
                type="button"
                disabled={!supportsDigits}
                onClick={() =>
                  onPlaceTrade({
                    symbol: activeSymbol,
                    contractType: btn.type,
                    barrier: selectedDigit,
                    stake,
                    durationTicks,
                    durationUnit: 't',
                    source: 'manual',
                  })
                }
                className={`px-3.5 py-2 rounded-md text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${btn.cls}`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
