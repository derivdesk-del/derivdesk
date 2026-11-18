import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Radar, Scale, Sparkles, Square } from 'lucide-react';
import { getPayoutMultiplier } from '../../hooks/useBotEngine.ts';
import {
  DERIV_MARKETS,
  type AppToastInput,
  type ContractTypeOption,
  type DurationUnit,
  type MarketSymbol,
  type TickPoint,
  type TradeTransaction,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface HedgingBeastViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  currency?: string;
  authenticated?: boolean;
  ticks?: TickPoint[];
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
    source: 'hedge';
  }) => boolean;
}

const HEDGE_PAIR_PRESETS: {
  label: string;
  legA: ContractTypeOption;
  barrierA: number;
  legB: ContractTypeOption;
  barrierB: number;
}[] = [
  { label: 'Over 1 + Under 8 (Wide Safe Overlap)', legA: 'DIGITOVER', barrierA: 1, legB: 'DIGITUNDER', barrierB: 8 },
  { label: 'Over 2 + Under 7 (Balanced Overlap)', legA: 'DIGITOVER', barrierA: 2, legB: 'DIGITUNDER', barrierB: 7 },
  { label: 'Over 3 + Under 6 (Symmetric Middle)', legA: 'DIGITOVER', barrierA: 3, legB: 'DIGITUNDER', barrierB: 6 },
];

export function HedgingBeastView({
  activeSymbol,
  markets = DERIV_MARKETS,
  currency = 'USD',
  authenticated = false,
  ticks = [],
  latestTick,
  transactions = [],
  onSelectMarket,
  onRequireLogin,
  onNotify,
  onPlaceTrade,
}: HedgingBeastViewProps) {
  const [legAContract, setLegAContract] = useState<ContractTypeOption>('DIGITOVER');
  const [legABarrier, setLegABarrier] = useState(2);
  const [legAStake, setLegAStake] = useState(10);

  const [legBContract, setLegBContract] = useState<ContractTypeOption>('DIGITUNDER');
  const [legBBarrier, setLegBBarrier] = useState(7);
  const [legBStake, setLegBStake] = useState(10);

  const [durationTicks, setDurationTicks] = useState(1);

  // Auto-Scan & Execute Hedge state
  const [autoHedgeActive, setAutoHedgeActive] = useState(false);
  const [minHedgeEvPct, setMinHedgeEvPct] = useState(1.2);
  const [takeProfitUsd, setTakeProfitUsd] = useState(30);
  const [stopLossUsd, setStopLossUsd] = useState(50);

  const sessionStartRef = useRef<number>(Date.now());
  const lastHedgeEpochRef = useRef<number>(0);

  const activeMarketMeta = markets.find((m) => m.symbol === activeSymbol);
  const supportsDigits = activeMarketMeta ? activeMarketMeta.supportsDigits !== false : true;

  const multA = getPayoutMultiplier(legAContract, legABarrier);
  const multB = getPayoutMultiplier(legBContract, legBBarrier);
  const totalOutlay = legAStake + legBStake;

  const evalDigitWin = (d: number, type: ContractTypeOption, barrier: number) =>
    type === 'DIGITOVER'
      ? d > barrier
      : type === 'DIGITUNDER'
        ? d < barrier
        : type === 'DIGITEVEN'
          ? d % 2 === 0
          : d % 2 !== 0;

  const digitOutcomes = useMemo(
    () =>
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
        const winA = evalDigitWin(d, legAContract, legABarrier);
        const winB = evalDigitWin(d, legBContract, legBBarrier);
        const payout = (winA ? legAStake * multA : 0) + (winB ? legBStake * multB : 0);
        const net = Number((payout - totalOutlay).toFixed(2));
        return { digit: d, winA, winB, net };
      }),
    [legABarrier, legAContract, legAStake, legBBarrier, legBContract, legBStake, multA, multB, totalOutlay],
  );

  // Empirical hedge expectation over last 250 ticks
  const empiricalEdge = useMemo(() => {
    const sample = ticks.slice(-250);
    if (sample.length < 30 || totalOutlay <= 0) {
      return { evPct: 0, bothWinPct: 0, zeroWinPct: 0, perfectReady: false };
    }
    let totalNet = 0;
    let bothCount = 0;
    let loseCount = 0;
    for (const t of sample) {
      const outcome = digitOutcomes[t.lastDigit];
      totalNet += outcome?.net ?? 0;
      if (outcome?.winA && outcome?.winB) bothCount += 1;
      if (!outcome?.winA && !outcome?.winB) loseCount += 1;
    }
    const evPct = Number((((totalNet / sample.length) / totalOutlay) * 100).toFixed(2));
    const bothWinPct = Number(((bothCount / sample.length) * 100).toFixed(1));
    const zeroWinPct = Number(((loseCount / sample.length) * 100).toFixed(1));
    const perfectReady = sample.length >= 60 && evPct >= minHedgeEvPct && zeroWinPct <= 10;
    return { evPct, bothWinPct, zeroWinPct, perfectReady };
  }, [digitOutcomes, minHedgeEvPct, ticks, totalOutlay]);

  const optimalPreset = useMemo(() => {
    const sample = ticks.slice(-250);
    if (sample.length < 30) return null;
    let best = { ...HEDGE_PAIR_PRESETS[0], evPct: -999 };
    for (const p of HEDGE_PAIR_PRESETS) {
      const mA = getPayoutMultiplier(p.legA, p.barrierA);
      const mB = getPayoutMultiplier(p.legB, p.barrierB);
      let netSum = 0;
      for (const t of sample) {
        const wA = evalDigitWin(t.lastDigit, p.legA, p.barrierA);
        const wB = evalDigitWin(t.lastDigit, p.legB, p.barrierB);
        netSum += (wA ? mA : 0) + (wB ? mB : 0) - 2;
      }
      const evPct = Number(((netSum / sample.length / 2) * 100).toFixed(2));
      if (evPct > best.evPct) best = { ...p, evPct };
    }
    return best;
  }, [ticks]);

  const hedgeStats = useMemo(() => {
    const start = sessionStartRef.current;
    const rel = transactions.filter((t) => t.source === 'hedge' && t.timestamp >= start);
    let netPnl = 0;
    let hasOpen = false;
    for (const t of rel) {
      if (t.status === 'open') hasOpen = true;
      else netPnl += t.profit;
    }
    return { count: rel.length, netPnl: Number(netPnl.toFixed(2)), hasOpen };
  }, [transactions]);

  const snapOptimalHedge = () => {
    if (!optimalPreset) return;
    setLegAContract(optimalPreset.legA);
    setLegABarrier(optimalPreset.barrierA);
    setLegBContract(optimalPreset.legB);
    setLegBBarrier(optimalPreset.barrierB);
  };

  const executeHedge = () => {
    onPlaceTrade({
      symbol: activeSymbol,
      contractType: legAContract,
      barrier: legABarrier,
      stake: legAStake,
      durationTicks,
      durationUnit: 't',
      source: 'hedge',
    });
    onPlaceTrade({
      symbol: activeSymbol,
      contractType: legBContract,
      barrier: legBBarrier,
      stake: legBStake,
      durationTicks,
      durationUnit: 't',
      source: 'hedge',
    });
  };

  useEffect(() => {
    if (!autoHedgeActive) return;
    if (hedgeStats.netPnl >= takeProfitUsd || hedgeStats.netPnl <= -Math.abs(stopLossUsd)) {
      setAutoHedgeActive(false);
      onNotify?.({
        variant: hedgeStats.netPnl >= takeProfitUsd ? 'success' : 'error',
        title: hedgeStats.netPnl >= takeProfitUsd ? 'Hedge TP Reached' : 'Hedge Stop Loss Hit',
        message: `Auto-Hedge stopped at ${hedgeStats.netPnl >= 0 ? '+' : ''}${hedgeStats.netPnl.toFixed(2)} ${currency}.`,
        persistent: true,
      });
    }
  }, [autoHedgeActive, currency, hedgeStats.netPnl, onNotify, stopLossUsd, takeProfitUsd]);

  useEffect(() => {
    if (!autoHedgeActive || !latestTick || !supportsDigits) return;
    if (!authenticated) {
      setAutoHedgeActive(false);
      onRequireLogin?.();
      return;
    }
    if (hedgeStats.hasOpen || latestTick.epoch === lastHedgeEpochRef.current) return;
    if (!empiricalEdge.perfectReady) return;

    lastHedgeEpochRef.current = latestTick.epoch;
    executeHedge();
    onNotify?.({
      variant: 'info',
      title: 'Perfect Dual-Leg Hedge Fired',
      message: `${legAContract}[${legABarrier}] + ${legBContract}[${legBBarrier}] on ${activeSymbol}`,
      meta: `Empirical EV ${empiricalEdge.evPct >= 0 ? '+' : ''}${empiricalEdge.evPct}% · Both-Win ${empiricalEdge.bothWinPct}%`,
      durationMs: 4000,
    });
  });

  const handleToggleAutoHedge = () => {
    if (autoHedgeActive) {
      setAutoHedgeActive(false);
      return;
    }
    if (!authenticated) {
      onRequireLogin?.();
      return;
    }
    sessionStartRef.current = Date.now();
    setAutoHedgeActive(true);
  };

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Scale className="w-5 h-5 text-[#0E5A78] dark:text-[#00A8E8]" />
            <div>
              <h1 className="font-display font-bold text-xl text-slate-900 dark:text-slate-100">
                Hedging Beast — Dual-Leg Overlap Matrix
              </h1>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Pair complementary Over/Under or Even/Odd contracts and auto-execute only when live empirical EV &gt;= +{minHedgeEvPct}%.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <MarketSelector
              markets={markets}
              value={activeSymbol}
              onChange={onSelectMarket}
              digitsOnly
              className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold"
            />
            <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              {latestTick ? latestTick.formattedQuote : '—'}
            </span>
          </div>
        </div>

        {/* Auto-Scan & Optimal Overlap Header */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Radar className={`w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8] ${autoHedgeActive ? 'animate-spin' : ''}`} />
              <div>
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  Empirical 250t Edge: {' '}
                  <span className={empiricalEdge.evPct >= minHedgeEvPct ? 'text-teal-600 dark:text-teal-400 font-mono' : 'text-amber-600 font-mono'}>
                    {empiricalEdge.evPct >= 0 ? '+' : ''}{empiricalEdge.evPct}% EV
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                  Double-Win: {empiricalEdge.bothWinPct}% · Zero-Win Loss Zone: {empiricalEdge.zeroWinPct}%
                  {optimalPreset && ` · Best Pair: ${optimalPreset.label} (${optimalPreset.evPct >= 0 ? '+' : ''}${optimalPreset.evPct}%)`}
                </div>
              </div>
            </div>
            <label className="flex items-center gap-1.5">
              <span className="text-slate-500">Min EV%:</span>
              <input
                type="number"
                step={0.2}
                value={minHedgeEvPct}
                onChange={(e) => setMinHedgeEvPct(Number(e.target.value) || 1.0)}
                className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-slate-500">TP/SL ($):</span>
              <input
                type="number"
                min={1}
                value={takeProfitUsd}
                onChange={(e) => setTakeProfitUsd(Math.max(1, Number(e.target.value) || 30))}
                className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
              />
              <span className="text-slate-400">/</span>
              <input
                type="number"
                min={1}
                value={stopLossUsd}
                onChange={(e) => setStopLossUsd(Math.max(1, Number(e.target.value) || 50))}
                className="w-14 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {optimalPreset && (
              <button
                type="button"
                onClick={snapOptimalHedge}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#00A8E8]" />
                <span>Snap Optimal Pair</span>
              </button>
            )}
            <button
              type="button"
              disabled={!supportsDigits}
              onClick={handleToggleAutoHedge}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-bold text-white cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                autoHedgeActive
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-[#0E5A78] hover:bg-[#0B4861]'
              }`}
            >
              {autoHedgeActive ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Stop Auto-Hedge</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Auto-Execute Perfect Hedges</span>
                </>
              )}
            </button>
          </div>
        </div>

        {!supportsDigits && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-4">
            <span>
              <strong>{activeMarketMeta?.name || activeSymbol}</strong> does not support Digits contracts. Switch to a Volatility or Jump index above to run Dual-Leg Digit Hedges.
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

        {/* Two Legs Configuration */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3 text-xs">
            <div className="font-display font-bold text-sm text-[#0E5A78] dark:text-[#00A8E8]">
              Leg A (Primary)
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-slate-500 mb-1">Type</label>
                <select
                  value={legAContract}
                  onChange={(e) => setLegAContract(e.target.value as ContractTypeOption)}
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
                >
                  <option value="DIGITOVER">Over</option>
                  <option value="DIGITUNDER">Under</option>
                  <option value="DIGITEVEN">Even</option>
                  <option value="DIGITODD">Odd</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Barrier</label>
                <input
                  type="number"
                  min={0}
                  max={9}
                  value={legABarrier}
                  onChange={(e) => setLegABarrier(Math.min(9, Math.max(0, Number(e.target.value) || 0)))}
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Stake ($)</label>
                <input
                  type="number"
                  min={0.35}
                  step={0.5}
                  value={legAStake}
                  onChange={(e) => setLegAStake(Math.max(0.35, Number(e.target.value) || 1))}
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 font-mono tabular-nums"
                />
              </div>
            </div>
            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
              Multiplier: {multA.toFixed(3)}x · Gross Win: ${(legAStake * multA).toFixed(2)}
            </div>
          </div>

          <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-3 text-xs">
            <div className="font-display font-bold text-sm text-teal-600 dark:text-teal-400">
              Leg B (Counter-Hedge)
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-slate-500 mb-1">Type</label>
                <select
                  value={legBContract}
                  onChange={(e) => setLegBContract(e.target.value as ContractTypeOption)}
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
                >
                  <option value="DIGITUNDER">Under</option>
                  <option value="DIGITOVER">Over</option>
                  <option value="DIGITODD">Odd</option>
                  <option value="DIGITEVEN">Even</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Barrier</label>
                <input
                  type="number"
                  min={0}
                  max={9}
                  value={legBBarrier}
                  onChange={(e) => setLegBBarrier(Math.min(9, Math.max(0, Number(e.target.value) || 0)))}
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 font-mono tabular-nums"
                />
              </div>
              <div>
                <label className="block text-slate-500 mb-1">Stake ($)</label>
                <input
                  type="number"
                  min={0.35}
                  step={0.5}
                  value={legBStake}
                  onChange={(e) => setLegBStake(Math.max(0.35, Number(e.target.value) || 1))}
                  className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 font-mono tabular-nums"
                />
              </div>
            </div>
            <div className="text-[11px] font-mono text-slate-500 tabular-nums">
              Multiplier: {multB.toFixed(3)}x · Gross Win: ${(legBStake * multB).toFixed(2)}
            </div>
          </div>
        </div>

        {/* Payoff Matrix by Digit */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
              Net Payoff Matrix by Settlement Digit (0–9)
            </h2>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              Combined Stake: ${totalOutlay.toFixed(2)} USD · Auto Session P/L: {hedgeStats.netPnl >= 0 ? '+' : ''}${hedgeStats.netPnl.toFixed(2)}
            </span>
          </div>

          <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
            {digitOutcomes.map((o) => (
              <div
                key={o.digit}
                className={`p-2.5 rounded-md border text-center ${
                  o.net > 0
                    ? 'bg-teal-50/70 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800'
                    : o.net === 0
                      ? 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      : 'bg-rose-50/70 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800'
                }`}
              >
                <div className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">
                  {o.digit}
                </div>
                <div
                  className={`mt-1 font-mono text-[11px] font-bold tabular-nums ${
                    o.net >= 0
                      ? 'text-teal-700 dark:text-teal-400'
                      : 'text-rose-700 dark:text-rose-400'
                  }`}
                >
                  {o.net >= 0 ? '+' : ''}${o.net.toFixed(2)}
                </div>
                <div className="mt-0.5 text-[10px] text-slate-500">
                  {o.winA && o.winB ? 'Both' : o.winA ? 'Leg A' : o.winB ? 'Leg B' : 'None'}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Duration (ticks):</span>
              <input
                type="number"
                min={1}
                max={10}
                value={durationTicks}
                onChange={(e) =>
                  setDurationTicks(Math.min(10, Math.max(1, Number(e.target.value) || 1)))
                }
                className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono tabular-nums"
              />
            </div>
            <button
              type="button"
              disabled={!supportsDigits}
              onClick={executeHedge}
              className="px-5 py-2.5 rounded-md bg-[#389E94] hover:bg-[#2F877E] disabled:opacity-45 text-white text-xs font-bold cursor-pointer"
            >
              Execute Dual-Leg Hedge (${totalOutlay.toFixed(2)})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
