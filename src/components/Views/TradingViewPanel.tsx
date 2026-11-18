import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
} from 'lucide-react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { derivFetch, parseJsonResponse, tryParseJsonResponse } from '../../lib/derivClient.ts';
import {
  computeEmaSeries,
  computeLocalRegimeFilter,
  computeRsi,
} from '../../lib/marketAnalysis.ts';
import {
  DERIV_MARKETS,
  type AppToastInput,
  type ContractTypeOption,
  type DerivCandle,
  type DerivContractSpec,
  type DerivProposalQuote,
  type DurationUnit,
  type MarketSymbol,
  type TickPoint,
  type TradeTransaction,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface TradingViewPanelProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  currency?: string;
  authenticated?: boolean;
  ticks: TickPoint[];
  latestTick: TickPoint | null;
  transactions?: TradeTransaction[];
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
    multiplier?: number;
    limitOrder?: { takeProfit?: number; stopLoss?: number };
    source: 'manual' | 'scanner';
  }) => boolean;
}

const TIMEFRAMES: { label: string; granularity: number }[] = [
  { label: 'Ticks', granularity: 0 },
  { label: '1m', granularity: 60 },
  { label: '5m', granularity: 300 },
  { label: '15m', granularity: 900 },
  { label: '1h', granularity: 3600 },
];

export function TradingViewPanel({
  activeSymbol,
  markets = DERIV_MARKETS,
  currency = 'USD',
  authenticated = false,
  ticks,
  latestTick,
  transactions = [],
  onSelectMarket,
  onRequireLogin,
  onNotify,
  onPlaceTrade,
}: TradingViewPanelProps) {
  const activeMarketMeta = useMemo(
    () =>
      markets.find((m) => m.symbol === activeSymbol) ??
      DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
      markets[0] ??
      DERIV_MARKETS[1],
    [activeSymbol, markets],
  );

  const [contractSpecs, setContractSpecs] = useState<DerivContractSpec[]>([]);
  const [granularity, setGranularity] = useState<number>(0);
  const [candles, setCandles] = useState<DerivCandle[]>([]);
  const [candleSource, setCandleSource] = useState<string>('');
  const [candlesLoading, setCandlesLoading] = useState<boolean>(false);

  const [windowSize, setWindowSize] = useState(120);
  const [stake, setStake] = useState(10);
  const [duration, setDuration] = useState(activeMarketMeta.defaultDuration ?? 5);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>(
    activeMarketMeta.defaultDurationUnit ?? 't',
  );
  const [orderMode, setOrderMode] = useState<'risefall' | 'multipliers'>(
    activeMarketMeta.supportsRiseFall !== false ? 'risefall' : 'multipliers',
  );
  const [multiplier, setMultiplier] = useState(100);
  const [takeProfit, setTakeProfit] = useState<string>('');
  const [stopLoss, setStopLoss] = useState<string>('');

  // Perfect-Conditions Auto-Trend Sniper
  const [autoTrendActive, setAutoTrendActive] = useState(false);
  const [autoTpUsd, setAutoTpUsd] = useState(40);
  const [autoSlUsd, setAutoSlUsd] = useState(40);
  const sessionStartRef = useRef<number>(Date.now());
  const lastAutoEpochRef = useRef<number>(0);
  const cooldownUntilRef = useRef<number>(0);

  const [quote, setQuote] = useState<DerivProposalQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const lastResetSymbolRef = useRef<string>(activeMarketMeta.symbol);

  const supportsRiseFall = useMemo(() => {
    if (contractSpecs.length > 0) {
      return contractSpecs.some((c) => c.contract_type === 'CALL' || c.contract_type === 'PUT');
    }
    return activeMarketMeta.supportsRiseFall !== false;
  }, [activeMarketMeta.supportsRiseFall, contractSpecs]);

  const supportsMultipliers = useMemo(() => {
    if (contractSpecs.length > 0) {
      return contractSpecs.some(
        (c) => c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN',
      );
    }
    return Boolean(activeMarketMeta.supportsMultipliers);
  }, [activeMarketMeta.supportsMultipliers, contractSpecs]);

  const multiplierChoices = useMemo(() => {
    const spec = contractSpecs.find(
      (c) =>
        (c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN') &&
        Array.isArray(c.multiplier_range) &&
        c.multiplier_range.length > 0,
    );
    return spec?.multiplier_range ?? [20, 40, 50, 100, 200, 300, 500];
  }, [contractSpecs]);

  useEffect(() => {
    if (lastResetSymbolRef.current !== activeMarketMeta.symbol) {
      lastResetSymbolRef.current = activeMarketMeta.symbol;
      setDuration(activeMarketMeta.defaultDuration ?? 5);
      setDurationUnit(activeMarketMeta.defaultDurationUnit ?? 't');
      setOrderMode(activeMarketMeta.supportsRiseFall !== false ? 'risefall' : 'multipliers');
    }
  }, [activeMarketMeta]);

  useEffect(() => {
    if (orderMode === 'risefall' && !supportsRiseFall && supportsMultipliers) {
      setOrderMode('multipliers');
    } else if (orderMode === 'multipliers' && !supportsMultipliers && supportsRiseFall) {
      setOrderMode('risefall');
    }
  }, [orderMode, supportsMultipliers, supportsRiseFall]);

  // Fetch contracts_for specs whenever symbol changes
  useEffect(() => {
    let cancelled = false;
    derivFetch(
      `/api/deriv/contracts-for?symbol=${encodeURIComponent(activeSymbol)}&currency=${encodeURIComponent(currency)}`,
    )
      .then((res) => (res.ok ? tryParseJsonResponse<{ available?: DerivContractSpec[] }>(res) : null))
      .then((data: { available?: DerivContractSpec[] } | null) => {
        if (!cancelled && data && Array.isArray(data.available)) {
          setContractSpecs(data.available);
        }
      })
      .catch(() => {
        if (!cancelled) setContractSpecs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSymbol, currency]);

  // Fetch OHLC candles when granularity > 0
  const fetchCandles = useCallback(async () => {
    if (granularity <= 0) return;
    setCandlesLoading(true);
    try {
      const res = await derivFetch(
        `/api/deriv/candles?symbol=${encodeURIComponent(activeSymbol)}&granularity=${granularity}&count=80`,
      );
      if (res.ok) {
        const data = await parseJsonResponse<{ candles?: DerivCandle[]; source?: string }>(res);
        setCandles(data.candles ?? []);
        setCandleSource(data.source ?? '');
      }
    } catch {
      // Keep prior candles on transient error
    } finally {
      setCandlesLoading(false);
    }
  }, [activeSymbol, granularity]);

  useEffect(() => {
    if (granularity <= 0) return;
    fetchCandles();
    const timer = window.setInterval(fetchCandles, 15000);
    return () => window.clearInterval(timer);
  }, [fetchCandles, granularity]);

  // Fetch live pre-trade proposal quote (debounced)
  const fetchProposalQuote = useCallback(async () => {
    setQuoteLoading(true);
    setQuoteError(null);
    try {
      const res = await derivFetch('/api/deriv/proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: activeSymbol,
          contractType: orderMode === 'multipliers' ? 'MULTUP' : 'CALL',
          stake,
          durationTicks: duration,
          durationUnit,
          multiplier,
          currency,
        }),
      });
      const data = await parseJsonResponse<{ quote?: DerivProposalQuote; error?: string }>(
        res,
        'Proposal unavailable for current parameters.',
      );
      if (!res.ok || !data.quote) {
        setQuote(null);
        setQuoteError(data.error || 'Proposal unavailable for current parameters.');
      } else {
        setQuote(data.quote);
      }
    } catch (err) {
      setQuote(null);
      setQuoteError(err instanceof Error ? err.message : 'Proposal lookup failed.');
    } finally {
      setQuoteLoading(false);
    }
  }, [activeSymbol, currency, duration, durationUnit, multiplier, orderMode, stake]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetchProposalQuote();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [fetchProposalQuote]);

  interface ChartPoint {
    time: string;
    quote: number;
    ema9: number;
    ema21: number;
    open?: number;
    high?: number;
    low?: number;
    range?: number;
    digit?: number;
  }

  const { chartData, latestEma9, prevEma9, latestEma21, rsi14, latestCandle } = useMemo(() => {
    if (granularity > 0 && candles.length > 0) {
      const closes = candles.map((c) => c.close);
      const ema9 = computeEmaSeries(closes, 9);
      const ema21 = computeEmaSeries(closes, 21);
      const rsi = computeRsi(closes, 14);
      const data: ChartPoint[] = candles.map((c, i) => ({
        time: new Date(c.epoch * 1000).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        quote: c.close,
        open: c.open,
        high: c.high,
        low: c.low,
        range: Number((c.high - c.low).toFixed(activeMarketMeta.pipSize)),
        ema9: Number(ema9[i]?.toFixed(activeMarketMeta.pipSize) ?? c.close),
        ema21: Number(ema21[i]?.toFixed(activeMarketMeta.pipSize) ?? c.close),
      }));
      return {
        chartData: data,
        latestEma9: ema9.length > 0 ? ema9[ema9.length - 1] : 0,
        prevEma9: ema9.length > 3 ? ema9[ema9.length - 4] : 0,
        latestEma21: ema21.length > 0 ? ema21[ema21.length - 1] : 0,
        rsi14: rsi,
        latestCandle: candles[candles.length - 1],
      };
    }

    const slice = ticks.slice(-windowSize);
    const quotes = slice.map((t) => t.quote);
    const ema9 = computeEmaSeries(quotes, 9);
    const ema21 = computeEmaSeries(quotes, 21);
    const rsi = computeRsi(quotes, 14);
    const data: ChartPoint[] = slice.map((t, i) => ({
      time: new Date(t.epoch * 1000).toLocaleTimeString(),
      quote: t.quote,
      ema9: Number(ema9[i]?.toFixed(activeMarketMeta.pipSize) ?? t.quote),
      ema21: Number(ema21[i]?.toFixed(activeMarketMeta.pipSize) ?? t.quote),
      digit: t.lastDigit,
    }));
    return {
      chartData: data,
      latestEma9: ema9.length > 0 ? ema9[ema9.length - 1] : 0,
      prevEma9: ema9.length > 3 ? ema9[ema9.length - 4] : 0,
      latestEma21: ema21.length > 0 ? ema21[ema21.length - 1] : 0,
      rsi14: rsi,
      latestCandle: null,
    };
  }, [activeMarketMeta.pipSize, candles, granularity, ticks, windowSize]);

  const bullishSignal = latestEma9 >= latestEma21;

  // 4-Point Perfect Trend Confluence Verdict
  const trendConfluence = useMemo(() => {
    const prices = ticks.slice(-30).map((t) => t.quote);
    const regime = computeLocalRegimeFilter(prices, Math.min(20, prices.length), 0.65);
    const wantBull = latestEma9 > latestEma21;
    const emaExpanding = wantBull ? latestEma9 > prevEma9 : latestEma9 < prevEma9;
    const rsiHealthy = wantBull ? rsi14 >= 44 && rsi14 <= 68 : rsi14 >= 32 && rsi14 <= 56;
    const last4 = prices.slice(-4);
    const microMove = last4.length >= 2 ? last4[last4.length - 1] - last4[0] : 0;
    const microAligned = wantBull ? microMove > 0 : microMove < 0;
    const regimeValid = regime.valid && ((wantBull && regime.direction === 'BULLISH') || (!wantBull && regime.direction === 'BEARISH'));

    const gates = [
      { label: 'EMA(9/21) Expansion', passed: emaExpanding, value: wantBull ? 'Bull Expand' : 'Bear Expand' },
      { label: 'RSI Healthy Zone', passed: rsiHealthy, value: `${rsi14}` },
      { label: 'WASM Slope >= 0.65', passed: regimeValid, value: `${regime.slopeRatio}x` },
      { label: '3-Tick Micro Impulse', passed: microAligned, value: microAligned ? 'Confirmed' : 'Pending' },
    ];
    const allPassed = ticks.length >= 25 && gates.every((g) => g.passed);
    const recommendedContract: ContractTypeOption =
      orderMode === 'multipliers'
        ? wantBull
          ? 'MULTUP'
          : 'MULTDOWN'
        : wantBull
          ? 'CALL'
          : 'PUT';

    return { gates, allPassed, recommendedContract, wantBull };
  }, [latestEma21, latestEma9, orderMode, prevEma9, rsi14, ticks]);

  const sniperStats = useMemo(() => {
    const start = sessionStartRef.current;
    const rel = transactions.filter((t) => t.source === 'scanner' && t.timestamp >= start);
    let netPnl = 0;
    let hasOpen = false;
    for (const t of rel) {
      if (t.status === 'open') hasOpen = true;
      else netPnl += t.profit;
    }
    return { netPnl: Number(netPnl.toFixed(2)), hasOpen, total: rel.length };
  }, [transactions]);

  const parsedLimitOrder = useMemo(() => {
    if (orderMode !== 'multipliers') return undefined;
    const tp = Number(takeProfit);
    const sl = Number(stopLoss);
    if ((Number.isFinite(tp) && tp > 0) || (Number.isFinite(sl) && sl > 0)) {
      return {
        takeProfit: Number.isFinite(tp) && tp > 0 ? tp : undefined,
        stopLoss: Number.isFinite(sl) && sl > 0 ? sl : undefined,
      };
    }
    return undefined;
  }, [orderMode, stopLoss, takeProfit]);

  useEffect(() => {
    if (!autoTrendActive) return;
    if (sniperStats.netPnl >= autoTpUsd || sniperStats.netPnl <= -Math.abs(autoSlUsd)) {
      setAutoTrendActive(false);
      onNotify?.({
        variant: sniperStats.netPnl >= autoTpUsd ? 'success' : 'error',
        title: sniperStats.netPnl >= autoTpUsd ? 'Trend Sniper TP Hit' : 'Trend Sniper SL Hit',
        message: `Auto-Trend Sniper stopped at ${sniperStats.netPnl >= 0 ? '+' : ''}${sniperStats.netPnl.toFixed(2)} ${currency}.`,
        persistent: true,
      });
    }
  }, [autoSlUsd, autoTpUsd, autoTrendActive, currency, onNotify, sniperStats.netPnl]);

  useEffect(() => {
    if (!autoTrendActive || !latestTick) return;
    if (!authenticated) {
      setAutoTrendActive(false);
      onRequireLogin?.();
      return;
    }
    const now = Date.now();
    if (
      sniperStats.hasOpen ||
      cooldownUntilRef.current > now ||
      latestTick.epoch === lastAutoEpochRef.current
    ) {
      return;
    }
    if (!trendConfluence.allPassed) return;

    lastAutoEpochRef.current = latestTick.epoch;
    cooldownUntilRef.current = now + 20000;
    const ok = onPlaceTrade({
      symbol: activeSymbol,
      contractType: trendConfluence.recommendedContract,
      barrier: 0,
      stake,
      durationTicks: duration,
      durationUnit,
      multiplier: orderMode === 'multipliers' ? multiplier : undefined,
      limitOrder: parsedLimitOrder,
      source: 'scanner',
    });
    if (ok) {
      onNotify?.({
        variant: 'info',
        title: 'Trend Sniper Executed',
        message: `${trendConfluence.recommendedContract} on ${activeMarketMeta.name}`,
        meta: `RSI ${rsi14} · 4/4 Trend Gates Green · Stake ${stake} ${currency}`,
        durationMs: 4000,
      });
    }
  }, [
    activeMarketMeta.name,
    activeSymbol,
    authenticated,
    autoTrendActive,
    currency,
    duration,
    durationUnit,
    latestTick,
    multiplier,
    onNotify,
    onPlaceTrade,
    onRequireLogin,
    orderMode,
    parsedLimitOrder,
    rsi14,
    sniperStats.hasOpen,
    stake,
    trendConfluence,
  ]);

  const toggleAutoTrend = () => {
    if (autoTrendActive) {
      setAutoTrendActive(false);
      return;
    }
    if (!authenticated) {
      onRequireLogin?.();
      return;
    }
    sessionStartRef.current = Date.now();
    cooldownUntilRef.current = 0;
    setAutoTrendActive(true);
  };

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-5 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Main Chart Area */}
        <div className="lg:col-span-9 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2.5">
              <MarketSelector
                markets={markets}
                value={activeSymbol}
                onChange={onSelectMarket}
                className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold max-w-[230px]"
              />

              {/* Candle / Tick Timeframe Switcher */}
              <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-900 p-1 rounded">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.label}
                    type="button"
                    onClick={() => setGranularity(tf.granularity)}
                    className={`px-2 py-1 rounded text-[11px] font-mono font-semibold cursor-pointer ${
                      granularity === tf.granularity
                        ? 'bg-[#0E5A78] text-white shadow-xs'
                        : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>

              {granularity === 0 ? (
                <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-900 p-1 rounded">
                  {[60, 120, 250, 500].map((w) => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setWindowSize(w)}
                      className={`px-2 py-1 rounded text-[11px] font-mono font-semibold cursor-pointer ${
                        windowSize === w
                          ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-500'
                      }`}
                    >
                      {w}t
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={fetchCandles}
                  disabled={candlesLoading}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${candlesLoading ? 'animate-spin' : ''}`} />
                  <span>{candleSource === 'deriv-ws' ? 'Deriv OHLC' : 'Aggregated'}</span>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span
                className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold ${
                  bullishSignal
                    ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300'
                    : 'bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300'
                }`}
              >
                EMA(9/21) {bullishSignal ? 'BULL' : 'BEAR'}
              </span>
              <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
                RSI(14): <strong>{rsi14}</strong>
              </span>
              <span className="font-mono text-base font-bold text-slate-900 dark:text-slate-100 tabular-nums">
                {latestTick ? latestTick.formattedQuote : '—'}
              </span>
            </div>
          </div>

          {latestCandle && granularity > 0 && (
            <div className="pt-2.5 flex flex-wrap items-center gap-4 text-[11px] font-mono text-slate-500 dark:text-slate-400">
              <span>
                O: <strong className="text-slate-800 dark:text-slate-200">{latestCandle.open}</strong>
              </span>
              <span>
                H: <strong className="text-teal-600 dark:text-teal-400">{latestCandle.high}</strong>
              </span>
              <span>
                L: <strong className="text-rose-600 dark:text-rose-400">{latestCandle.low}</strong>
              </span>
              <span>
                C: <strong className="text-slate-800 dark:text-slate-200">{latestCandle.close}</strong>
              </span>
            </div>
          )}

          <div className="h-[420px] pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.18} />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={30} />
                <YAxis
                  domain={['auto', 'auto']}
                  width={74}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => Number(v).toFixed(Math.min(5, activeMarketMeta.pipSize))}
                />
                <Tooltip contentStyle={{ fontSize: '11px', borderRadius: '6px' }} />
                {granularity > 0 && (
                  <Bar
                    dataKey="high"
                    name="Candle High"
                    fill="#00A8E8"
                    fillOpacity={0.12}
                    isAnimationActive={false}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="quote"
                  name={granularity > 0 ? 'Close' : 'Spot'}
                  stroke="#00A8E8"
                  fill="#00A8E8"
                  fillOpacity={0.1}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="ema9"
                  name="EMA(9)"
                  stroke="#10b981"
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="ema21"
                  name="EMA(21)"
                  stroke="#f59e0b"
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right Quick Trade Ticket + Auto-Trend Sniper */}
        <div className="lg:col-span-3 space-y-4">
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                Auto-Trend Sniper
              </span>
              <span className="font-mono text-[11px] font-bold text-slate-600 dark:text-slate-300 tabular-nums">
                {sniperStats.netPnl >= 0 ? '+' : ''}${sniperStats.netPnl.toFixed(2)}
              </span>
            </div>
            <div className="space-y-1.5">
              {trendConfluence.gates.map((g) => (
                <div
                  key={g.label}
                  className="flex items-center justify-between text-[11px]"
                >
                  <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                    {g.passed ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                    ) : (
                      <Circle className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                    <span>{g.label}</span>
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{g.value}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <label className="text-[10px] text-slate-500">
                TP ({currency})
                <input
                  type="number"
                  min={1}
                  value={autoTpUsd}
                  onChange={(e) => setAutoTpUsd(Math.max(1, Number(e.target.value) || 40))}
                  className="mt-0.5 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs tabular-nums"
                />
              </label>
              <label className="text-[10px] text-slate-500">
                SL ({currency})
                <input
                  type="number"
                  min={1}
                  value={autoSlUsd}
                  onChange={(e) => setAutoSlUsd(Math.max(1, Number(e.target.value) || 40))}
                  className="mt-0.5 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono text-xs tabular-nums"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={toggleAutoTrend}
              className={`w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-md text-white font-bold cursor-pointer ${
                autoTrendActive
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-[#0E5A78] hover:bg-[#0B4861]'
              }`}
            >
              {autoTrendActive ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Stop Auto-Trend Sniper</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Auto-Execute Perfect Trend</span>
                </>
              )}
            </button>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                Execution Ticket
              </h2>
              <span className="text-[10px] font-mono text-slate-500">
                {contractSpecs.length > 0
                  ? `${contractSpecs.length} contracts live`
                  : activeMarketMeta.marketGroup}
              </span>
            </div>

            {supportsRiseFall && supportsMultipliers && (
              <div className="grid grid-cols-2 gap-1 p-1 rounded bg-slate-100 dark:bg-slate-900">
                <button
                  type="button"
                  onClick={() => setOrderMode('risefall')}
                  className={`py-1.5 rounded text-[11px] font-semibold cursor-pointer ${
                    orderMode === 'risefall'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  Rise / Fall
                </button>
                <button
                  type="button"
                  onClick={() => setOrderMode('multipliers')}
                  className={`py-1.5 rounded text-[11px] font-semibold cursor-pointer ${
                    orderMode === 'multipliers'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  Multipliers
                </button>
              </div>
            )}

            <div>
              <label className="block text-slate-500 mb-1">Stake ({currency})</label>
              <input
                type="number"
                min={0.35}
                step={0.5}
                value={stake}
                onChange={(e) => setStake(Math.max(0.35, Number(e.target.value) || 1))}
                className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono tabular-nums"
              />
            </div>

            {orderMode === 'multipliers' ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-500 mb-1">Multiplier</label>
                  <select
                    value={multiplier}
                    onChange={(e) => setMultiplier(Number(e.target.value) || 100)}
                    className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono font-bold"
                  >
                    {multiplierChoices.map((m) => (
                      <option key={m} value={m}>
                        x{m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">
                      Take Profit ({currency})
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="Optional"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value)}
                      className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono tabular-nums text-[11px]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">
                      Stop Loss ({currency})
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="Optional"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value)}
                      className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 font-mono tabular-nums text-[11px]"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-slate-500 mb-1">Duration</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={duration}
                    onChange={(e) =>
                      setDuration(Math.min(365, Math.max(1, Number(e.target.value) || 1)))
                    }
                    className="w-20 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 font-mono tabular-nums"
                  />
                  <select
                    value={durationUnit}
                    onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}
                    className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 font-semibold"
                  >
                    <option value="t">Ticks</option>
                    <option value="s">Seconds</option>
                    <option value="m">Minutes</option>
                    <option value="h">Hours</option>
                    <option value="d">Days</option>
                  </select>
                </div>
              </div>
            )}

            {/* Live Pre-Trade Deriv Proposal Quote */}
            <div className="rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="inline-flex items-center gap-1 font-semibold text-slate-700 dark:text-slate-200">
                  <ShieldCheck className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                  <span>Deriv Proposal Quote</span>
                </span>
                <button
                  type="button"
                  onClick={fetchProposalQuote}
                  disabled={quoteLoading}
                  className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                  title="Refresh live Deriv proposal quote"
                >
                  <RefreshCw className={`w-3 h-3 ${quoteLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              {quote ? (
                <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] text-slate-400 font-sans">Ask / Payout</div>
                    <div className="font-bold text-slate-900 dark:text-slate-100">
                      {quote.ask_price.toFixed(2)} →{' '}
                      <span className="text-teal-600 dark:text-teal-400">
                        {quote.payout > 0 ? quote.payout.toFixed(2) : 'Unlimited'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-slate-400 font-sans">Return / BE</div>
                    <div className="font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                      {quote.payout > 0
                        ? `+${quote.impliedReturnPct}% · ${quote.breakEvenPct}%`
                        : `Spot ${quote.spot}`}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {quoteLoading ? 'Requesting live quote...' : quoteError || 'Awaiting quote...'}
                </div>
              )}
            </div>

            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={() =>
                  onPlaceTrade({
                    symbol: activeSymbol,
                    contractType: orderMode === 'multipliers' ? 'MULTUP' : 'CALL',
                    barrier: 0,
                    stake,
                    durationTicks: duration,
                    durationUnit,
                    multiplier,
                    limitOrder: parsedLimitOrder,
                    source: 'manual',
                  })
                }
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white font-bold cursor-pointer"
              >
                <ArrowUpRight className="w-4 h-4" />
                <span>
                  {orderMode === 'multipliers'
                    ? `Multiplier UP · x${multiplier}`
                    : `Rise (Call) · ${duration}${durationUnit}`}
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  onPlaceTrade({
                    symbol: activeSymbol,
                    contractType: orderMode === 'multipliers' ? 'MULTDOWN' : 'PUT',
                    barrier: 0,
                    stake,
                    durationTicks: duration,
                    durationUnit,
                    multiplier,
                    limitOrder: parsedLimitOrder,
                    source: 'manual',
                  })
                }
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-rose-600 hover:bg-rose-700 text-white font-bold cursor-pointer"
              >
                <ArrowDownRight className="w-4 h-4" />
                <span>
                  {orderMode === 'multipliers'
                    ? `Multiplier DOWN · x${multiplier}`
                    : `Fall (Put) · ${duration}${durationUnit}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
