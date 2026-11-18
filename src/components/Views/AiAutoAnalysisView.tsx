import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CloudUpload,
  Cpu,
  Loader2,
  Lock,
  Play,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Sparkles,
  Square,
  Timer,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { parseJsonResponse } from '../../lib/derivClient.ts';
import { saveScannerSessionLog } from '../../lib/firebase.ts';
import {
  analyzeMarketTicks,
  computeLocalRegimeFilter,
  computeMarkovTransitionSurvival,
} from '../../lib/marketAnalysis.ts';
import {
  DERIV_MARKETS,
  type AiAnalysisResult,
  type AiScannerSignal,
  type AppToastInput,
  type BotStrategyConfig,
  type ContractTypeOption,
  type DurationUnit,
  type MarketSymbol,
  type TickPoint,
  type TradeCategory,
  type TradeTransaction,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface AiAutoAnalysisViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  ticks: TickPoint[];
  currentStrategy: BotStrategyConfig;
  balance?: number | null;
  currency?: string;
  authenticated?: boolean;
  transactions?: TradeTransaction[];
  appId?: string;
  onRequireLogin?: () => void;
  onNotify?: (toast: AppToastInput) => void;
  onPlaceTrade?: (params: {
    symbol: string;
    contractType: ContractTypeOption;
    barrier: number;
    stake: number;
    durationTicks: number;
    durationUnit?: DurationUnit;
    multiplier?: number;
    source: TradeTransaction['source'];
  }) => boolean;
  onSelectMarket: (symbol: string) => void;
  onApplyRecommended: (next: BotStrategyConfig, runNow?: boolean) => void;
}

interface ScannerLogEntry {
  id: string;
  time: number;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export function AiAutoAnalysisView({
  activeSymbol,
  markets = DERIV_MARKETS,
  ticks,
  currentStrategy,
  balance = null,
  currency = 'USD',
  authenticated = false,
  transactions = [],
  appId = '34RXuPGgdUNCTWhsYjRcD',
  onRequireLogin,
  onNotify,
  onPlaceTrade,
  onSelectMarket,
  onApplyRecommended,
}: AiAutoAnalysisViewProps) {
  const { user } = useAuth();

  // Manual One-Click Gemini Inspector State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiAnalysisResult | null>(null);

  // Quantitative AI Auto-Trading Engine Config State
  const [baseRiskPct, setBaseRiskPct] = useState<number>(1.5);
  const [dailyProfitTargetPct, setDailyProfitTargetPct] = useState<number>(6);
  const [dailyMaxLossPct, setDailyMaxLossPct] = useState<number>(4);
  const [maxRecoverySteps, setMaxRecoverySteps] = useState<number>(2);
  const [minAIConfidence, setMinAIConfidence] = useState<number>(85);
  const [lossCooldownSec, setLossCooldownSec] = useState<number>(45);
  const [evalEveryTicks, setEvalEveryTicks] = useState<number>(10);
  const [fastMode, setFastMode] = useState<boolean>(false);
  const [savingCloud, setSavingCloud] = useState<boolean>(false);

  // Quantitative Engine Runtime State
  const [isAutoTrading, setIsAutoTrading] = useState<boolean>(false);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [sessionInitialBalance, setSessionInitialBalance] = useState<number>(100);
  const [netSessionPnL, setNetSessionPnL] = useState<number>(0);
  const [consecutiveLosses, setConsecutiveLosses] = useState<number>(0);
  const [cooldownRemainingSec, setCooldownRemainingSec] = useState<number>(0);
  const [sessionLockReason, setSessionLockReason] = useState<string | null>(null);
  const [lastScannerSignal, setLastScannerSignal] = useState<AiScannerSignal | null>(null);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [engineLogs, setEngineLogs] = useState<ScannerLogEntry[]>([]);

  const cooldownUntilRef = useRef<number>(0);
  const sessionStartRef = useRef<number>(0);
  const lastEvalTickEpochRef = useRef<number>(0);
  const tickDeltaRef = useRef<number>(0);
  const processedTxIdsRef = useRef<Set<string>>(new Set());
  const evalInFlightRef = useRef<boolean>(false);

  const appendEngineLog = useCallback(
    (level: ScannerLogEntry['level'], text: string) => {
      setEngineLogs((prev) => [
        {
          id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          time: Date.now(),
          level,
          text,
        },
        ...prev.slice(0, 49),
      ]);
    },
    [],
  );

  const activeMarketMeta = useMemo(
    () =>
      markets.find((m) => m.symbol === activeSymbol) ??
      DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
      markets[0] ??
      DERIV_MARKETS[1],
    [activeSymbol, markets],
  );

  const quantPreview = useMemo(
    () => analyzeMarketTicks(ticks, activeMarketMeta, 1000, 10),
    [ticks, activeMarketMeta],
  );

  const markovPreview = useMemo(
    () => computeMarkovTransitionSurvival(ticks, 1000),
    [ticks],
  );

  const localRegime = useMemo(
    () =>
      computeLocalRegimeFilter(
        ticks.slice(-25).map((t) => t.quote),
        20,
        0.6,
      ),
    [ticks],
  );

  const effectiveBalance = useMemo(() => {
    if (authenticated && typeof balance === 'number' && balance > 0) {
      return balance;
    }
    return sessionInitialBalance;
  }, [authenticated, balance, sessionInitialBalance]);

  const baseStake = useMemo(
    () =>
      Math.max(
        0.35,
        Number(((effectiveBalance * Math.max(0.1, baseRiskPct)) / 100).toFixed(2)),
      ),
    [effectiveBalance, baseRiskPct],
  );

  const currentOptimalStake = useMemo(() => {
    if (consecutiveLosses === 0 || maxRecoverySteps === 0) return baseStake;
    const step = Math.min(consecutiveLosses, maxRecoverySteps);
    const mult = Math.pow(2.1, step);
    return Number((baseStake * mult).toFixed(2));
  }, [baseStake, consecutiveLosses, maxRecoverySteps]);

  const dailyTargets = useMemo(() => {
    const initBal = Math.max(10, sessionInitialBalance);
    return {
      maxProfit: Number(((initBal * dailyProfitTargetPct) / 100).toFixed(2)),
      maxLoss: -Number(((initBal * dailyMaxLossPct) / 100).toFixed(2)),
    };
  }, [sessionInitialBalance, dailyProfitTargetPct, dailyMaxLossPct]);

  // Cooldown 1s countdown ticker
  useEffect(() => {
    if (cooldownRemainingSec <= 0) return;
    const interval = setInterval(() => {
      const rem = Math.max(0, Math.ceil((cooldownUntilRef.current - Date.now()) / 1000));
      setCooldownRemainingSec(rem);
      if (rem === 0) {
        cooldownUntilRef.current = 0;
      }
    }, 500);
    return () => clearInterval(interval);
  }, [cooldownRemainingSec]);

  // Monitor settled scanner transactions for PnL, Capped Recovery, 45s Cooldown, & Session Locks
  useEffect(() => {
    if (sessionStartRef.current === 0) return;
    const settledScannerTxs = transactions.filter(
      (tx) =>
        tx.source === 'scanner' &&
        tx.status !== 'open' &&
        tx.timestamp >= sessionStartRef.current &&
        !processedTxIdsRef.current.has(tx.id),
    );
    if (settledScannerTxs.length === 0) return;

    let pnlDelta = 0;
    let lossesAfter = consecutiveLosses;
    let triggeredCooldown = false;

    for (const tx of settledScannerTxs.slice().reverse()) {
      processedTxIdsRef.current.add(tx.id);
      pnlDelta += tx.profit;
      if (tx.status === 'won') {
        lossesAfter = 0;
        appendEngineLog(
          'success',
          `WIN #${tx.refId} (${tx.contractType} · ${tx.symbol}): +$${tx.profit.toFixed(2)}. Recovery step reset to 0.`,
        );
      } else {
        lossesAfter += 1;
        if (lossesAfter > maxRecoverySteps) {
          lossesAfter = 0;
          appendEngineLog(
            'warning',
            `LOSS #${tx.refId}: -$${Math.abs(tx.profit).toFixed(2)}. Max recovery steps (${maxRecoverySteps}) exceeded — hard reset to base stake $${baseStake.toFixed(2)}.`,
          );
        } else {
          appendEngineLog(
            'warning',
            `LOSS #${tx.refId}: -$${Math.abs(tx.profit).toFixed(2)}. Recovery step ${lossesAfter}/${maxRecoverySteps} (${Math.pow(2.1, lossesAfter).toFixed(2)}x) + ${lossCooldownSec}s cooldown.`,
          );
        }
        if (lossCooldownSec > 0) {
          triggeredCooldown = true;
        }
      }
    }

    const updatedPnL = Number((netSessionPnL + pnlDelta).toFixed(2));
    setNetSessionPnL(updatedPnL);
    setConsecutiveLosses(lossesAfter);

    if (triggeredCooldown) {
      cooldownUntilRef.current = Date.now() + lossCooldownSec * 1000;
      setCooldownRemainingSec(lossCooldownSec);
    }

    // Enforce Daily Profit Target & Max Loss Locks
    if (updatedPnL >= dailyTargets.maxProfit) {
      const msg = `+${dailyProfitTargetPct}% Daily Profit Target Locked (+$${updatedPnL.toFixed(2)} >= +$${dailyTargets.maxProfit.toFixed(2)})`;
      setIsAutoTrading(false);
      setSessionLockReason(msg);
      appendEngineLog('success', msg);
      onNotify?.({
        variant: 'success',
        title: 'AI Engine Profit Target Locked',
        message: `Auto-trading halted after reaching +${dailyProfitTargetPct}% session target.`,
        meta: `Session P/L +${updatedPnL.toFixed(2)} ${currency}`,
        durationMs: 7500,
      });
    } else if (updatedPnL <= dailyTargets.maxLoss) {
      const msg = `-${dailyMaxLossPct}% Daily Max Loss Triggered ($${updatedPnL.toFixed(2)} <= $${dailyTargets.maxLoss.toFixed(2)})`;
      setIsAutoTrading(false);
      setSessionLockReason(msg);
      appendEngineLog('error', msg);
      onNotify?.({
        variant: 'error',
        title: 'AI Engine Daily Max Loss Hit',
        message: `Auto-trading halted after hitting -${dailyMaxLossPct}% drawdown lock.`,
        meta: `Session P/L ${updatedPnL.toFixed(2)} ${currency}`,
        persistent: true,
      });
    }
  }, [
    appendEngineLog,
    baseStake,
    consecutiveLosses,
    currency,
    dailyMaxLossPct,
    dailyProfitTargetPct,
    dailyTargets.maxLoss,
    dailyTargets.maxProfit,
    lossCooldownSec,
    maxRecoverySteps,
    netSessionPnL,
    onNotify,
    transactions,
  ]);

  const evaluateWithAiScanner = useCallback(
    async (manualTrigger = false) => {
      if (evalInFlightRef.current) return;
      if (ticks.length < 20) {
        if (manualTrigger) {
          setScannerError('Need at least 20 live ticks to evaluate.');
        }
        return;
      }

      // 1. Local Quantitative Pre-Filter + Full 1,000-Tick Context
      const prices = ticks.slice(-1000).map((t) => t.quote);
      const regime = computeLocalRegimeFilter(prices.slice(-25), 20, 0.6);
      if (!regime.valid) {
        appendEngineLog(
          'info',
          `Skipped Gemini scan on ${activeSymbol} (${ticks.slice(-1000).length}t): choppy regime (slopeRatio ${regime.slopeRatio} <= 0.60 stdDev).`,
        );
        setLastScannerSignal({
          symbol: activeSymbol,
          action: 'HOLD',
          confidence_score: 0,
          contract_type: activeMarketMeta.supportsRiseFall !== false ? 'CALL' : 'DIGITDIFF',
          barrier: 4,
          duration: activeMarketMeta.defaultDuration ?? 1,
          duration_unit: activeMarketMeta.defaultDurationUnit ?? 't',
          sampleSize1000: ticks.slice(-1000).length,
          rationale: `Blocked locally over ${ticks.slice(-1000).length}t: choppy/sideways volatility (${regime.slopeRatio} stdDev < 0.60 threshold).`,
        });
        return;
      }

      evalInFlightRef.current = true;
      setIsEvaluating(true);
      setScannerError(null);

      try {
        const res = await fetch('/api/ai/scanner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: activeSymbol,
            prices,
            fastMode,
          }),
        });
        const data = await parseJsonResponse<{
          signal?: AiScannerSignal;
          error?: string;
        }>(res, 'AI Scanner request failed');
        if (!res.ok) {
          const errMsg = data.error || 'AI Scanner request failed';
          setScannerError(errMsg);
          appendEngineLog('error', `Scanner error: ${errMsg}`);
          if (res.status === 503 && isAutoTrading) {
            setIsAutoTrading(false);
          }
          return;
        }

        const signal = data.signal as AiScannerSignal;
        setLastScannerSignal(signal);

        if (
          signal.action === 'AUTO_EXECUTE' &&
          signal.confidence_score >= minAIConfidence
        ) {
          if (manualTrigger && !isAutoTrading) {
            appendEngineLog(
              'success',
              `AI Signal Approved (${signal.confidence_score}% >= ${minAIConfidence}%): ${signal.contract_type} ${signal.duration}${signal.duration_unit} — ${signal.rationale}`,
            );
          } else if (isAutoTrading && onPlaceTrade) {
            if (!authenticated) {
              setIsAutoTrading(false);
              appendEngineLog('warning', 'Deriv sign-in required for auto-execution.');
              onRequireLogin?.();
              return;
            }
            const placed = onPlaceTrade({
              symbol: signal.symbol || activeSymbol,
              contractType: signal.contract_type,
              barrier: signal.barrier ?? 4,
              stake: currentOptimalStake,
              durationTicks: Math.max(1, signal.duration || 5),
              durationUnit: signal.duration_unit || activeMarketMeta.defaultDurationUnit || 't',
              multiplier: signal.multiplier,
              source: 'scanner',
            });
            if (placed) {
              appendEngineLog(
                'success',
                `AUTO-EXECUTED ${signal.contract_type} on ${activeSymbol} (${signal.confidence_score}% conf) · Stake $${currentOptimalStake.toFixed(2)}`,
              );
            }
          }
        } else {
          appendEngineLog(
            'info',
            `AI HOLD (${signal.confidence_score}% < ${minAIConfidence}% or HOLD): ${signal.rationale}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error';
        setScannerError(msg);
        appendEngineLog('error', `Scanner network error: ${msg}`);
      } finally {
        evalInFlightRef.current = false;
        setIsEvaluating(false);
      }
    },
    [
      activeMarketMeta.defaultDuration,
      activeMarketMeta.defaultDurationUnit,
      activeMarketMeta.supportsRiseFall,
      activeSymbol,
      appendEngineLog,
      authenticated,
      currentOptimalStake,
      fastMode,
      isAutoTrading,
      minAIConfidence,
      onPlaceTrade,
      onRequireLogin,
      ticks,
    ],
  );

  // Tick-driven Auto-Scanner Evaluation Loop
  useEffect(() => {
    if (!isAutoTrading || ticks.length === 0) return;
    const latest = ticks[ticks.length - 1];
    if (!latest || latest.epoch === lastEvalTickEpochRef.current) return;
    lastEvalTickEpochRef.current = latest.epoch;

    if (sessionLockReason) {
      setIsAutoTrading(false);
      return;
    }

    if (cooldownUntilRef.current > Date.now()) {
      return;
    }

    const hasOpenScannerTrade = transactions.some(
      (tx) => tx.source === 'scanner' && tx.status === 'open',
    );
    if (hasOpenScannerTrade) {
      return;
    }

    tickDeltaRef.current += 1;
    if (ticks.length >= 25 && tickDeltaRef.current >= Math.max(3, evalEveryTicks)) {
      tickDeltaRef.current = 0;
      void evaluateWithAiScanner(false);
    }
  }, [
    evalEveryTicks,
    evaluateWithAiScanner,
    isAutoTrading,
    sessionLockReason,
    ticks,
    transactions,
  ]);

  const toggleAutoEngine = () => {
    if (isAutoTrading) {
      setIsAutoTrading(false);
      appendEngineLog('info', 'AI Quantitative Auto-Engine paused by user.');
      return;
    }
    if (!authenticated) {
      appendEngineLog('warning', 'Please sign in with Deriv before starting AI Auto-Trading.');
      onRequireLogin?.();
      return;
    }
    const startingBal = Math.max(10, balance ?? 100);
    if (sessionStartRef.current === 0 || sessionLockReason) {
      sessionStartRef.current = Date.now();
      setSessionInitialBalance(startingBal);
      setNetSessionPnL(0);
      setConsecutiveLosses(0);
      setSessionLockReason(null);
      cooldownUntilRef.current = 0;
      setCooldownRemainingSec(0);
      processedTxIdsRef.current.clear();
    }
    tickDeltaRef.current = 0;
    setScannerError(null);
    setIsAutoTrading(true);
    appendEngineLog(
      'info',
      `Started AI Quantitative Auto-Engine on ${activeSymbol} (App ID ${appId}) | Risk ${baseRiskPct}% ($${Math.max(0.35, Number(((startingBal * baseRiskPct) / 100).toFixed(2))).toFixed(2)}) | +${dailyProfitTargetPct}% / -${dailyMaxLossPct}% Locks.`,
    );
  };

  const resetAutoSession = () => {
    setIsAutoTrading(false);
    sessionStartRef.current = Date.now();
    setSessionInitialBalance(Math.max(10, balance ?? 100));
    setNetSessionPnL(0);
    setConsecutiveLosses(0);
    setSessionLockReason(null);
    cooldownUntilRef.current = 0;
    setCooldownRemainingSec(0);
    tickDeltaRef.current = 0;
    processedTxIdsRef.current.clear();
    setEngineLogs([]);
    setScannerError(null);
  };

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: activeSymbol,
          metrics: {
            regime: quantPreview.regime,
            trendDirection: quantPreview.trendDirection,
            ema9: quantPreview.ema9,
            ema21: quantPreview.ema21,
            rsi14: quantPreview.rsi14,
            bollingerPctB: quantPreview.bollingerPctB,
            volatilityBps: quantPreview.volatilityBps,
            topQuantOpportunity: quantPreview.topOpportunity
              ? {
                  contractType: quantPreview.topOpportunity.contractType,
                  expectedValuePct: quantPreview.topOpportunity.expectedValuePct,
                  winRatePct: quantPreview.topOpportunity.winRatePct,
                }
              : null,
          },
        }),
      });
      const data = await parseJsonResponse<{
        analysis?: AiAnalysisResult;
        error?: string;
      }>(res, 'Analysis failed');
      if (!res.ok) {
        setError(data.error || 'Analysis failed');
      } else {
        setResult(data.analysis as AiAnalysisResult);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const applyRecommendation = (runNow: boolean) => {
    if (!result) return;
    const isMult =
      result.recommendedContract === 'MULTUP' ||
      result.recommendedContract === 'MULTDOWN' ||
      result.recommendedTradeType === 'Multipliers';
    const isRiseFall =
      result.recommendedContract === 'CALL' ||
      result.recommendedContract === 'PUT' ||
      result.recommendedTradeType === 'Rise/Fall';
    const tradeCategory: TradeCategory = isMult
      ? 'Multipliers'
      : isRiseFall
        ? 'Up/Down'
        : 'Digits';

    onApplyRecommended(
      {
        ...currentStrategy,
        id: `ai-rec-${Date.now()}`,
        name: `AI ${result.recommendedContract} (${activeSymbol})`,
        description: result.biasSummary,
        tradeParams: {
          ...currentStrategy.tradeParams,
          marketGroup: activeMarketMeta.marketGroup,
          subGroup: activeMarketMeta.subGroup,
          symbol: activeSymbol,
          tradeCategory,
          tradeType: isMult
            ? 'Multipliers'
            : isRiseFall
              ? 'Rise/Fall'
              : result.recommendedTradeType,
          contractType: result.recommendedContract,
        },
        variables: currentStrategy.variables.map((v) =>
          v.name === 'stake'
            ? { ...v, value: Math.max(0.35, result.suggestedStake || 5) }
            : v,
        ),
        purchaseConditions: {
          ...currentStrategy.purchaseConditions,
          mode: isRiseFall || isMult
            ? quantPreview.trendDirection === 'BEARISH'
              ? 'ema_bearish'
              : 'ema_bullish'
            : 'always',
          durationTicks: Math.max(1, result.suggestedDurationTicks || activeMarketMeta.defaultDuration || 1),
          durationUnit: result.suggestedDurationUnit || activeMarketMeta.defaultDurationUnit || 't',
          predictionDigit: Math.min(9, Math.max(0, result.targetDigit || 4)),
        },
      },
      runNow,
    );
  };

  const handleSaveCloudLog = async () => {
    if (!user || savingCloud) return;
    setSavingCloud(true);
    try {
      const opp = quantPreview.topOpportunity;
      await saveScannerSessionLog(user.uid, {
        symbol: activeSymbol,
        contractType: lastScannerSignal?.contract_type || opp?.contractType || 'DIGITDIFF',
        barrier: lastScannerSignal?.barrier ?? opp?.barrier ?? 4,
        sampleSize: Math.min(1000, ticks.length),
        winRatePct: opp?.winRatePct ?? 0,
        evPct: opp?.expectedValuePct ?? 0,
        confidence: lastScannerSignal?.confidence_score ?? 0,
        netPnl: netSessionPnL,
        wins: 0,
        losses: consecutiveLosses,
        rationale: lastScannerSignal?.rationale || `1,000-tick AI Engine snapshot (${quantPreview.regime})`,
      });
      onNotify?.({
        variant: 'success',
        title: 'AI Scanner Snapshot Saved',
        message: `Stored 1,000t scan log for ${activeSymbol} in Cloud.`,
        durationMs: 3500,
      });
    } catch {
      onNotify?.({
        variant: 'error',
        title: 'Cloud Save Failed',
        message: 'Could not save scanner snapshot to Firestore.',
        durationMs: 4000,
      });
    } finally {
      setSavingCloud(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Header Bar */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <div>
              <h1 className="font-display font-bold text-xl text-slate-900 dark:text-slate-100">
                1,000-Tick AI Quantitative Scanner &amp; Auto-Engine
              </h1>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Full 1,000-tick horizon ({Math.min(1000, ticks.length)}t buffered), Markov conditional transitions, capped 2-step recovery, and Gemini AI evaluation · App ID <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{appId}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <MarketSelector
              markets={markets}
              value={activeSymbol}
              onChange={onSelectMarket}
              className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold max-w-[230px]"
            />

            <button
              type="button"
              onClick={runAnalysis}
              disabled={loading || ticks.length < 10}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer whitespace-nowrap"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{loading ? 'Analyzing 1,000t...' : 'Analyze 1,000 Ticks'}</span>
            </button>
          </div>
        </div>

        {/* Profitable Deriv AI Auto-Trading Engine Card */}
        <section className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3.5">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
              <div>
                <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Quantitative Auto-Trading Engine (1,000-Tick + Markov)
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Evaluates up to 1,000 ticks + 10×10 Markov survival, enforces {minAIConfidence}% min Gemini confidence ({fastMode ? '3.1 Flash-Lite Fast Triage' : '4 Hydrogen Deep Quant'}), caps recovery at {maxRecoverySteps} steps, and pauses {lossCooldownSec}s after losses.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setFastMode((f) => !f)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-semibold cursor-pointer whitespace-nowrap ${
                  fastMode
                    ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300'
                    : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <span>{fastMode ? 'Mode: Fast Triage (Flash-Lite)' : 'Mode: Deep 1000t (Hydrogen)'}</span>
              </button>

              {user && (
                <button
                  type="button"
                  disabled={savingCloud}
                  onClick={handleSaveCloudLog}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold cursor-pointer whitespace-nowrap"
                >
                  <CloudUpload className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                  <span>{savingCloud ? 'Saving...' : 'Save Log'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => void evaluateWithAiScanner(true)}
                disabled={isEvaluating || ticks.length < 20}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                {isEvaluating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Activity className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
                )}
                <span>Scan 1,000t Once</span>
              </button>

              <button
                type="button"
                onClick={resetAutoSession}
                title="Reset session PnL, cooldown & lock"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>

              <button
                type="button"
                onClick={toggleAutoEngine}
                className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-white text-xs font-bold cursor-pointer whitespace-nowrap ${
                  isAutoTrading
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-[#0F766E] hover:bg-[#0D5F59]'
                }`}
              >
                {isAutoTrading ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop Auto-Engine</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Start Auto-Engine</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Quant Risk Parameters Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5 text-xs">
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Base Risk %</span>
              <input
                type="number"
                step="0.1"
                min={0.1}
                max={10}
                value={baseRiskPct}
                onChange={(e) => setBaseRiskPct(Math.max(0.1, Number(e.target.value) || 1.5))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Daily Target %</span>
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={50}
                value={dailyProfitTargetPct}
                onChange={(e) => setDailyProfitTargetPct(Math.max(0.5, Number(e.target.value) || 6))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Daily Max Loss %</span>
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={50}
                value={dailyMaxLossPct}
                onChange={(e) => setDailyMaxLossPct(Math.max(0.5, Number(e.target.value) || 4))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Max Recovery Steps</span>
              <input
                type="number"
                min={0}
                max={5}
                value={maxRecoverySteps}
                onChange={(e) => setMaxRecoverySteps(Math.min(5, Math.max(0, Number(e.target.value) || 0)))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Min AI Conf %</span>
              <input
                type="number"
                min={50}
                max={99}
                value={minAIConfidence}
                onChange={(e) => setMinAIConfidence(Math.min(99, Math.max(50, Number(e.target.value) || 85)))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Loss Cooldown (s)</span>
              <input
                type="number"
                min={0}
                max={300}
                value={lossCooldownSec}
                onChange={(e) => setLossCooldownSec(Math.min(300, Math.max(0, Number(e.target.value) || 0)))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
            <label className="rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2">
              <span className="block text-[10px] text-slate-500">Eval Interval (t)</span>
              <input
                type="number"
                min={3}
                max={60}
                value={evalEveryTicks}
                onChange={(e) => setEvalEveryTicks(Math.min(60, Math.max(3, Number(e.target.value) || 10)))}
                className="mt-1 w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 font-mono font-bold tabular-nums text-xs"
              />
            </label>
          </div>

          {/* Live 3-Pillar Status Cards: Regime Pre-Filter, Capped Sizing, Session Locks */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-xs tabular-nums">
            <div className="rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 space-y-1">
              <div className="flex items-center justify-between font-sans">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  1. Local Regime Pre-Filter
                </span>
                <span
                  className={`text-[10px] font-bold ${
                    localRegime.valid
                      ? 'text-teal-600 dark:text-teal-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }`}
                >
                  {localRegime.valid ? `TRENDING (${localRegime.direction})` : 'CHOPPY · BLOCKED'}
                </span>
              </div>
              <div className="text-slate-900 dark:text-slate-100 font-bold">
                |Slope|/σ: {localRegime.slopeRatio}x (min 0.60x)
              </div>
              <div className="text-[11px] text-slate-500">
                Slope {localRegime.slope >= 0 ? '+' : ''}{localRegime.slope} · σ {localRegime.volatility}
              </div>
            </div>

            <div className="rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 space-y-1">
              <div className="flex items-center justify-between font-sans">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  2. Capped Recovery Sizing
                </span>
                <span className="text-[10px] font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                  Step {consecutiveLosses}/{maxRecoverySteps}
                </span>
              </div>
              <div className="text-slate-900 dark:text-slate-100 font-bold">
                Next Stake: ${currentOptimalStake.toFixed(2)} {currency}
              </div>
              <div className="text-[11px] text-slate-500">
                Base ({baseRiskPct}%): ${baseStake.toFixed(2)} · 2.1x Cap
              </div>
            </div>

            <div className="rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3 space-y-1">
              <div className="flex items-center justify-between font-sans">
                <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  3. Session Locks &amp; Cooldown
                </span>
                {cooldownRemainingSec > 0 ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-400">
                    <Timer className="w-3 h-3" />
                    {cooldownRemainingSec}s
                  </span>
                ) : sessionLockReason ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-600 dark:text-rose-400">
                    <Lock className="w-3 h-3" />
                    LOCKED
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-teal-600 dark:text-teal-400">
                    <ShieldCheck className="w-3 h-3" />
                    {isAutoTrading ? 'ARMED' : 'STANDBY'}
                  </span>
                )}
              </div>
              <div
                className={`font-bold ${
                  netSessionPnL > 0
                    ? 'text-teal-600 dark:text-teal-400'
                    : netSessionPnL < 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                Session P/L: {netSessionPnL >= 0 ? '+' : ''}${netSessionPnL.toFixed(2)}
              </div>
              <div className="text-[11px] text-slate-500">
                Locks: +${dailyTargets.maxProfit.toFixed(2)} / ${dailyTargets.maxLoss.toFixed(2)}
              </div>
            </div>
          </div>

          {sessionLockReason && (
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3.5 py-2.5 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3">
              <span>
                <strong>Session Lock Active:</strong> {sessionLockReason}
              </span>
              <button
                type="button"
                onClick={resetAutoSession}
                className="px-2.5 py-1 rounded bg-amber-600 text-white text-[11px] font-semibold cursor-pointer"
              >
                Unlock &amp; Reset
              </button>
            </div>
          )}

          {scannerError && (
            <div className="rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 px-3.5 py-2.5 text-xs text-rose-700 dark:text-rose-300">
              {scannerError}
            </div>
          )}

          {lastScannerSignal && (
            <div className="rounded-md bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  Latest Verdict ({lastScannerSignal.symbol}):{' '}
                  <span
                    className={
                      lastScannerSignal.action === 'AUTO_EXECUTE' &&
                      lastScannerSignal.confidence_score >= minAIConfidence
                        ? 'text-teal-600 dark:text-teal-400 font-mono'
                        : 'text-amber-600 dark:text-amber-400 font-mono'
                    }
                  >
                    {lastScannerSignal.action} · {lastScannerSignal.confidence_score}%
                  </span>{' '}
                  · {lastScannerSignal.contract_type} ({lastScannerSignal.duration}
                  {lastScannerSignal.duration_unit})
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  {lastScannerSignal.rationale}
                </p>
              </div>
            </div>
          )}

          {engineLogs.length > 0 && (
            <div className="rounded-md bg-slate-950 text-slate-200 border border-slate-800 p-3 max-h-40 overflow-y-auto studio-scroll font-mono text-[11px] space-y-1">
              {engineLogs.map((entry) => (
                <div
                  key={entry.id}
                  className={
                    entry.level === 'success'
                      ? 'text-emerald-400'
                      : entry.level === 'warning'
                        ? 'text-amber-300'
                        : entry.level === 'error'
                          ? 'text-rose-400'
                          : 'text-slate-300'
                  }
                >
                  [{new Date(entry.time).toLocaleTimeString()}] {entry.text}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Instant 1,000-Tick Quantitative Telemetry Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs tabular-nums">
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-3">
            <div className="text-[11px] font-sans text-slate-500">1,000t Horizon &amp; Markov</div>
            <div className="mt-0.5 font-bold text-slate-900 dark:text-slate-100">
              {quantPreview.sampleSize}t · {markovPreview.sampleTransitions} trans
            </div>
          </div>
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-3">
            <div className="text-[11px] font-sans text-slate-500">Quant Regime</div>
            <div className="mt-0.5 font-bold text-slate-900 dark:text-slate-100 truncate">
              {quantPreview.regime}
            </div>
          </div>
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-3">
            <div className="text-[11px] font-sans text-slate-500">RSI(14) / Volatility</div>
            <div className="mt-0.5 font-bold text-slate-900 dark:text-slate-100">
              {quantPreview.rsi14} · {quantPreview.volatilityBps} bps
            </div>
          </div>
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-3">
            <div className="text-[11px] font-sans text-slate-500">Top 1,000t EV</div>
            <div className="mt-0.5 font-bold text-teal-600 dark:text-teal-400">
              {quantPreview.topOpportunity
                ? `${quantPreview.topOpportunity.contractType} (${quantPreview.topOpportunity.expectedValuePct >= 0 ? '+' : ''}${quantPreview.topOpportunity.expectedValuePct}%)`
                : 'Collecting...'}
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 p-4 text-xs text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}

        {!result && !loading && !error && (
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-8 text-center space-y-2">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Deep-Dive Gemini 1,000-Tick Market Inspector ({activeMarketMeta.name} · {activeSymbol})
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Click Analyze 1,000 Ticks for a full one-click Bot Builder setup recommendation based on the live {Math.min(1000, ticks.length)}-tick sample, Markov matrix, EMA(9/21), RSI(14), and EV metrics.
            </p>
          </div>
        )}

        {result && (
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
              <div>
                <div className="text-xs font-mono text-slate-500 uppercase">
                  {result.symbol} · AI Market Regime
                </div>
                <h2 className="font-display font-bold text-lg text-slate-900 dark:text-slate-100">
                  {result.regime}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => applyRecommendation(false)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold cursor-pointer"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Apply Setup</span>
                </button>
                <button
                  type="button"
                  onClick={() => applyRecommendation(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-bold cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Apply &amp; Run</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 font-mono text-xs tabular-nums">
              <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500 font-sans">Trade Type</div>
                <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">
                  {result.recommendedTradeType}
                </div>
              </div>
              <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500 font-sans">Contract</div>
                <div className="mt-1 font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                  {result.recommendedContract}
                </div>
              </div>
              <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500 font-sans">Target Digit</div>
                <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">
                  {result.targetDigit}
                </div>
              </div>
              <div className="p-3 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <div className="text-[11px] text-slate-500 font-sans">Stake / Expiry</div>
                <div className="mt-1 font-bold text-slate-900 dark:text-slate-100">
                  ${result.suggestedStake} · {result.suggestedDurationTicks}
                  {result.suggestedDurationUnit || activeMarketMeta.defaultDurationUnit || 't'}
                </div>
              </div>
            </div>

            <div className="space-y-3 text-xs leading-relaxed">
              <div>
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
                  Distribution &amp; Momentum Observation
                </h3>
                <p className="text-slate-600 dark:text-slate-300">{result.biasSummary}</p>
              </div>
              <div>
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">
                  Statistical Confidence Note
                </h3>
                <p className="text-slate-600 dark:text-slate-300">{result.confidenceNote}</p>
              </div>
              <div className="p-3 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200">
                <strong>Risk Note:</strong> {result.riskWarning}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
