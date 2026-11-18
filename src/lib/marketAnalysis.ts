import {
  DEFAULT_PRETRADE_ANALYSIS,
  type BotStrategyConfig,
  type ContractTypeOption,
  type DtraderPerfectSetup,
  type DurationUnit,
  type MarketSymbol,
  type PerfectGateChecklistItem,
  type PreTradeSignalVerdict,
  type PurchaseConditionMode,
  type TickPoint,
  type TradeCategory,
  type TradeSubType,
} from '../shared/types.ts';
import {
  computeBinomialZScoreWasm,
  computeSeriesStatsWasm,
} from './wasmQuant.ts';

export interface StrategyEdgeOpportunity {
  id: string;
  label: string;
  tradeCategory: TradeCategory;
  tradeType: TradeSubType;
  contractType: ContractTypeOption;
  conditionMode: PurchaseConditionMode;
  barrier: number;
  duration: number;
  durationUnit: DurationUnit;
  multiplier?: number;
  sampleTrades: number;
  wins: number;
  winRatePct: number;
  breakEvenPct: number;
  payoutMultiplier: number;
  expectedValuePct: number;
  simulatedNetUsd: number;
  profitFactor: number;
  rationale: string;
}

export interface MarketAnalyticsReport {
  symbol: string;
  sampleSize: number;
  latestPrice: number;
  ema9: number;
  ema21: number;
  rsi14: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerPctB: number;
  volatilityBps: number;
  regime: 'Bullish Trend' | 'Bearish Trend' | 'Mean-Reverting Range' | 'High Volatility Breakout';
  trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  evenPct: number;
  oddPct: number;
  currentEvenStreak: number;
  currentOddStreak: number;
  coldestDigit: number;
  coldestDigitPct: number;
  hottestDigit: number;
  hottestDigitPct: number;
  opportunities: StrategyEdgeOpportunity[];
  topOpportunity: StrategyEdgeOpportunity | null;
}

export function computeEmaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function computeRsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

export interface LocalRegimeResult {
  valid: boolean;
  direction: 'BULLISH' | 'BEARISH';
  volatility: number;
  slope: number;
  slopeRatio: number;
  mean: number;
}

export function computeLocalRegimeFilter(
  prices: number[],
  windowSize = 20,
  thresholdRatio = 0.6,
): LocalRegimeResult {
  if (prices.length < windowSize) {
    return {
      valid: false,
      direction: 'BULLISH',
      volatility: 0,
      slope: 0,
      slopeRatio: 0,
      mean: prices[prices.length - 1] ?? 0,
    };
  }
  const recent = prices.slice(-windowSize);
  const stats = computeSeriesStatsWasm(recent);
  const valid = stats.stdDev > 0 && Math.abs(stats.slope) > stats.stdDev * thresholdRatio;

  return {
    valid,
    direction: stats.slope >= 0 ? 'BULLISH' : 'BEARISH',
    volatility: Number(stats.stdDev.toFixed(5)),
    slope: Number(stats.slope.toFixed(5)),
    slopeRatio: Number(stats.slopeRatio.toFixed(2)),
    mean: Number(stats.mean.toFixed(5)),
  };
}

export interface DualWindowDigitZScoreOptions {
  longWindow?: number;
  shortWindow?: number;
  recentWindow?: number;
  wLong?: number;
  wShort?: number;
  minZThreshold?: number;
  excludedDigit?: number | null;
  lockedDigit?: number | null;
}

export interface DualWindowDigitZScoreResult {
  predDigit: number;
  bestZ: number;
  cRecent: number;
  cLong: number;
  cShort: number;
  windowN: number;
  shortN: number;
  scoresByDigit: {
    digit: number;
    cLong: number;
    cShort: number;
    zLong: number;
    zShort: number;
    score: number;
  }[];
}

export interface MarkovTransitionResult {
  sampleTransitions: number;
  currentLastDigit: number | null;
  matrix: number[][];
  rowTotals: number[];
  /** Posterior shrinkage probability P(next !== d | lastDigit) * 100 for d=0..9 */
  differSurvivalPctByDigit: number[];
  /** Posterior shrinkage probability P(next > barrier | lastDigit) * 100 */
  overSurvivalPct: (barrier: number) => number;
  /** Posterior shrinkage probability P(next < barrier | lastDigit) * 100 */
  underSurvivalPct: (barrier: number) => number;
  /** Posterior shrinkage probability P(next even | lastDigit) * 100 */
  evenAfterLastPct: number;
}

export function computeMarkovTransitionSurvival(
  ticks: TickPoint[],
  maxTicks = 1000,
): MarkovTransitionResult {
  const slice = ticks.slice(-Math.max(2, maxTicks));
  const matrix: number[][] = Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => 0),
  );
  const rowTotals = Array.from({ length: 10 }, () => 0);
  const globalCounts = Array.from({ length: 10 }, () => 0);

  for (let i = 0; i < slice.length; i++) {
    const d = slice[i].lastDigit;
    if (d >= 0 && d <= 9) globalCounts[d]++;
    if (i > 0) {
      const prevD = slice[i - 1].lastDigit;
      if (prevD >= 0 && prevD <= 9 && d >= 0 && d <= 9) {
        matrix[prevD][d]++;
        rowTotals[prevD]++;
      }
    }
  }

  const totalDigits = Math.max(1, slice.length);
  const currentLastDigit = slice.length > 0 ? slice[slice.length - 1].lastDigit : null;
  const condRow =
    currentLastDigit !== null && currentLastDigit >= 0 && currentLastDigit <= 9
      ? matrix[currentLastDigit]
      : null;
  const condTotal =
    currentLastDigit !== null && currentLastDigit >= 0 && currentLastDigit <= 9
      ? rowTotals[currentLastDigit]
      : 0;

  // Dirichlet / Empirical Bayes shrinkage weight against global 1000t baseline
  const priorWeight = 20;
  const condDist = Array.from({ length: 10 }, (_, d) => {
    const globalProb = globalCounts[d] / totalDigits;
    const obsCount = condRow ? condRow[d] : 0;
    return (obsCount + priorWeight * globalProb) / (condTotal + priorWeight);
  });

  const differSurvivalPctByDigit = condDist.map((p) =>
    Number(((1 - p) * 100).toFixed(2)),
  );

  const overSurvivalPct = (barrier: number): number => {
    let p = 0;
    for (let d = barrier + 1; d <= 9; d++) p += condDist[d];
    return Number((p * 100).toFixed(2));
  };

  const underSurvivalPct = (barrier: number): number => {
    let p = 0;
    for (let d = 0; d < barrier; d++) p += condDist[d];
    return Number((p * 100).toFixed(2));
  };

  let evenProb = 0;
  for (let d = 0; d <= 9; d += 2) evenProb += condDist[d];

  return {
    sampleTransitions: Math.max(0, slice.length - 1),
    currentLastDigit,
    matrix,
    rowTotals,
    differSurvivalPctByDigit,
    overSurvivalPct,
    underSurvivalPct,
    evenAfterLastPct: Number((evenProb * 100).toFixed(2)),
  };
}

export function computeDualWindowDigitZScores(
  ticks: TickPoint[],
  options: DualWindowDigitZScoreOptions = {},
): DualWindowDigitZScoreResult {
  const longWindow = Math.max(20, options.longWindow ?? 1000);
  const shortWindow = Math.max(10, options.shortWindow ?? 60);
  const recentWindow = Math.max(1, options.recentWindow ?? 10);
  const wLong = options.wLong ?? 0.55;
  const wShort = options.wShort ?? 0.45;
  const minZThreshold = options.minZThreshold ?? -1.6;
  const excludedDigit =
    options.excludedDigit !== undefined && options.excludedDigit !== null
      ? options.excludedDigit
      : -1;

  const windowN = Math.min(ticks.length, longWindow);
  const shortN = Math.min(ticks.length, shortWindow);
  const longSlice = windowN > 0 ? ticks.slice(-windowN) : [];
  const shortSlice = shortN > 0 ? ticks.slice(-shortN) : [];
  const recentSlice = ticks.slice(-Math.min(ticks.length, recentWindow));

  const longCounts = Array.from({ length: 10 }, () => 0);
  const shortCounts = Array.from({ length: 10 }, () => 0);
  const recentCounts = Array.from({ length: 10 }, () => 0);

  for (const t of longSlice) longCounts[t.lastDigit]++;
  for (const t of shortSlice) shortCounts[t.lastDigit]++;
  for (const t of recentSlice) recentCounts[t.lastDigit]++;

  const scoresByDigit: DualWindowDigitZScoreResult['scoresByDigit'] = [];
  let bestScore = Infinity;
  let bestDigit = ticks.length > 0 ? ticks[ticks.length - 1].lastDigit : 0;

  for (let d = 0; d <= 9; d++) {
    const cLong = longCounts[d];
    const cShort = shortCounts[d];
    const zLong = windowN > 0 ? computeBinomialZScoreWasm(cLong, windowN, 0.1) : 0;
    const zShort = shortN > 0 ? computeBinomialZScoreWasm(cShort, shortN, 0.1) : 0;
    const score = wLong * zLong + wShort * zShort;
    scoresByDigit.push({ digit: d, cLong, cShort, zLong, zShort, score });

    if (excludedDigit >= 0 && d === excludedDigit) continue;
    if (score < bestScore) {
      bestScore = score;
      bestDigit = d;
    }
  }

  let predDigit = bestDigit;
  let bestZ = Number((Number.isFinite(bestScore) ? bestScore : 0).toFixed(3));

  if (
    options.lockedDigit !== undefined &&
    options.lockedDigit !== null &&
    options.lockedDigit >= 0 &&
    options.lockedDigit <= 9
  ) {
    predDigit = options.lockedDigit;
    bestZ = minZThreshold;
  }

  return {
    predDigit,
    bestZ,
    cRecent: recentCounts[predDigit] ?? 0,
    cLong: longCounts[predDigit] ?? 0,
    cShort: shortCounts[predDigit] ?? 0,
    windowN,
    shortN,
    scoresByDigit,
  };
}

export function analyzeMarketTicks(
  ticks: TickPoint[],
  market: MarketSymbol,
  sampleSize = 1000,
  stake = 10,
): MarketAnalyticsReport {
  const slice = ticks.slice(-sampleSize);
  const prices = slice.map((t) => t.quote);
  const latestPrice = prices.length > 0 ? prices[prices.length - 1] : market.basePrice;

  const ema9Series = computeEmaSeries(prices, 9);
  const ema21Series = computeEmaSeries(prices, 21);
  const ema9 = ema9Series.length > 0 ? ema9Series[ema9Series.length - 1] : latestPrice;
  const ema21 = ema21Series.length > 0 ? ema21Series[ema21Series.length - 1] : latestPrice;
  const rsi14 = computeRsi(prices, 14);

  const bbSlice = prices.slice(-20);
  const bbStats = bbSlice.length > 0 ? computeSeriesStatsWasm(bbSlice) : null;
  const bbMean = bbStats ? bbStats.mean : latestPrice;
  const bbStd = bbSlice.length > 1 && bbStats ? bbStats.stdDev : 0;
  const bollingerUpper = bbMean + 2 * bbStd;
  const bollingerLower = bbMean - 2 * bbStd;
  const bbWidth = bollingerUpper - bollingerLower;
  const bollingerPctB =
    bbWidth > 0 ? Number((((latestPrice - bollingerLower) / bbWidth) * 100).toFixed(1)) : 50;

  // Tick-to-tick return volatility in basis points
  let sqReturns = 0;
  for (let i = 1; i < prices.length; i++) {
    const r = prices[i - 1] > 0 ? (prices[i] - prices[i - 1]) / prices[i - 1] : 0;
    sqReturns += r * r;
  }
  const volatilityBps =
    prices.length > 1
      ? Number((Math.sqrt(sqReturns / (prices.length - 1)) * 10000).toFixed(2))
      : 0;

  const emaSpreadPct = ema21 > 0 ? ((ema9 - ema21) / ema21) * 100 : 0;
  let trendDirection: MarketAnalyticsReport['trendDirection'] = 'NEUTRAL';
  if (ema9 > ema21 && rsi14 >= 52) trendDirection = 'BULLISH';
  else if (ema9 < ema21 && rsi14 <= 48) trendDirection = 'BEARISH';

  let regime: MarketAnalyticsReport['regime'] = 'Mean-Reverting Range';
  if (volatilityBps > 12 && Math.abs(emaSpreadPct) > 0.04) {
    regime = 'High Volatility Breakout';
  } else if (trendDirection === 'BULLISH') {
    regime = 'Bullish Trend';
  } else if (trendDirection === 'BEARISH') {
    regime = 'Bearish Trend';
  }

  // Digit frequencies & streaks
  const counts = Array.from({ length: 10 }, () => 0);
  let evenCount = 0;
  for (const t of slice) {
    counts[t.lastDigit]++;
    if (t.lastDigit % 2 === 0) evenCount++;
  }
  const total = Math.max(1, slice.length);
  const evenPct = Number(((evenCount / total) * 100).toFixed(1));
  const oddPct = Number((100 - evenPct).toFixed(1));

  let coldestDigit = 0;
  let hottestDigit = 0;
  for (let d = 1; d < 10; d++) {
    if (counts[d] < counts[coldestDigit]) coldestDigit = d;
    if (counts[d] > counts[hottestDigit]) hottestDigit = d;
  }
  const coldestDigitPct = Number(((counts[coldestDigit] / total) * 100).toFixed(1));
  const hottestDigitPct = Number(((counts[hottestDigit] / total) * 100).toFixed(1));

  let currentEvenStreak = 0;
  let currentOddStreak = 0;
  for (let i = slice.length - 1; i >= 0; i--) {
    if (slice[i].lastDigit % 2 === 0) {
      if (currentOddStreak > 0) break;
      currentEvenStreak++;
    } else {
      if (currentEvenStreak > 0) break;
      currentOddStreak++;
    }
  }

  // Backtest candidate strategies across the live sample window
  const opportunities: StrategyEdgeOpportunity[] = [];

  const pushBacktest = (cfg: {
    id: string;
    label: string;
    tradeCategory: TradeCategory;
    tradeType: TradeSubType;
    contractType: ContractTypeOption;
    conditionMode: PurchaseConditionMode;
    barrier: number;
    duration: number;
    durationUnit: DurationUnit;
    multiplier?: number;
    payoutMultiplier: number;
    rationale: string;
    evaluate: (idx: number) => boolean | null; // null = skip entry
  }) => {
    let sampleTrades = 0;
    let wins = 0;
    let grossWin = 0;
    let grossLoss = 0;

    for (let i = 22; i < slice.length - 1; i++) {
      const outcome = cfg.evaluate(i);
      if (outcome === null) continue;
      sampleTrades++;
      if (outcome) {
        wins++;
        grossWin += stake * (cfg.payoutMultiplier - 1);
      } else {
        grossLoss += stake;
      }
    }

    const winRatePct =
      sampleTrades > 0 ? Number(((wins / sampleTrades) * 100).toFixed(1)) : 0;
    const breakEvenPct = Number(((1 / cfg.payoutMultiplier) * 100).toFixed(1));
    const expectedValuePct =
      sampleTrades > 0
        ? Number(((winRatePct / 100) * cfg.payoutMultiplier * 100 - 100).toFixed(2))
        : 0;
    const simulatedNetUsd = Number((grossWin - grossLoss).toFixed(2));
    const profitFactor =
      grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 9.99 : 0;

    opportunities.push({
      id: cfg.id,
      label: cfg.label,
      tradeCategory: cfg.tradeCategory,
      tradeType: cfg.tradeType,
      contractType: cfg.contractType,
      conditionMode: cfg.conditionMode,
      barrier: cfg.barrier,
      duration: cfg.duration,
      durationUnit: cfg.durationUnit,
      multiplier: cfg.multiplier,
      sampleTrades,
      wins,
      winRatePct,
      breakEvenPct,
      payoutMultiplier: cfg.payoutMultiplier,
      expectedValuePct,
      simulatedNetUsd,
      profitFactor,
      rationale: cfg.rationale,
    });
  };

  const supportsDigits = market.supportsDigits ?? false;
  const supportsRiseFall = market.supportsRiseFall ?? true;
  const supportsMultipliers = market.supportsMultipliers ?? false;
  const baseDur = market.defaultDuration ?? 1;
  const baseUnit = market.defaultDurationUnit ?? 't';

  if (supportsDigits) {
    // 1. Coldest Digit Differ Sniper
    pushBacktest({
      id: `diff-${coldestDigit}`,
      label: `Digit Differ ${coldestDigit} (Coldest Digit Guard)`,
      tradeCategory: 'Digits',
      tradeType: 'Matches/Differs',
      contractType: 'DIGITDIFF',
      conditionMode: 'digit_pct_lte',
      barrier: coldestDigit,
      duration: 1,
      durationUnit: 't',
      payoutMultiplier: 1.095,
      rationale: `Digit ${coldestDigit} appeared only ${coldestDigitPct}% in the last ${slice.length} ticks (vs 10% baseline). Break-even is 91.3%.`,
      evaluate: (i) => slice[i + 1].lastDigit !== coldestDigit,
    });

    // 1b. Dual-Window Binomial Z-Score Digit Differ (400t + 50t, z <= -1.6)
    const zEval = computeDualWindowDigitZScores(ticks, {
      longWindow: 400,
      shortWindow: 50,
      recentWindow: 5,
      minZThreshold: -1.6,
    });
    const zTargetPct =
      zEval.windowN > 0 ? Number(((zEval.cLong / zEval.windowN) * 100).toFixed(1)) : 10;
    pushBacktest({
      id: `dual-z-diff-${zEval.predDigit}`,
      label: `Dual-Z Digit Differ ${zEval.predDigit} (Z=${zEval.bestZ.toFixed(2)})`,
      tradeCategory: 'Digits',
      tradeType: 'Matches/Differs',
      contractType: 'DIGITDIFF',
      conditionMode: 'dual_zscore_digit',
      barrier: zEval.predDigit,
      duration: 1,
      durationUnit: 't',
      payoutMultiplier: 1.095,
      rationale: `Dual-window (400t/50t) binomial Z-score selected digit ${zEval.predDigit} (Z=${zEval.bestZ.toFixed(2)}, ${zTargetPct}% freq, ${zEval.cRecent}/5 recent hits).`,
      evaluate: (i) => {
        if (i < 55) return null;
        const recentHit = slice
          .slice(Math.max(0, i - 4), i + 1)
          .some((t) => t.lastDigit === zEval.predDigit);
        if (recentHit) return null;
        return slice[i + 1].lastDigit !== zEval.predDigit;
      },
    });

    // 2. Digit Over 2 (70% theoretical zone)
    pushBacktest({
      id: 'over-2',
      label: 'Digit Over 2 (Digits 3–9)',
      tradeCategory: 'Digits',
      tradeType: 'Over/Under',
      contractType: 'DIGITOVER',
      conditionMode: 'always',
      barrier: 2,
      duration: 1,
      durationUnit: 't',
      payoutMultiplier: 1.343,
      rationale: 'Covers 7 of 10 digits (3–9) with ~1.34x payout; profitable above 74.5% empirical hit rate.',
      evaluate: (i) => slice[i + 1].lastDigit > 2,
    });

    // 3. Digit Under 7 (70% theoretical zone)
    pushBacktest({
      id: 'under-7',
      label: 'Digit Under 7 (Digits 0–6)',
      tradeCategory: 'Digits',
      tradeType: 'Over/Under',
      contractType: 'DIGITUNDER',
      conditionMode: 'always',
      barrier: 7,
      duration: 1,
      durationUnit: 't',
      payoutMultiplier: 1.343,
      rationale: 'Covers 7 of 10 digits (0–6) with ~1.34x payout; profitable above 74.5% empirical hit rate.',
      evaluate: (i) => slice[i + 1].lastDigit < 7,
    });

    // 4. Parity Reversal after 3+ streak
    const favorEven = evenPct >= oddPct;
    pushBacktest({
      id: favorEven ? 'even-streak' : 'odd-streak',
      label: favorEven
        ? 'Digit Even (3x Odd Streak Reversal)'
        : 'Digit Odd (3x Even Streak Reversal)',
      tradeCategory: 'Digits',
      tradeType: 'Even/Odd',
      contractType: favorEven ? 'DIGITEVEN' : 'DIGITODD',
      conditionMode: favorEven ? 'odd_streak_gte' : 'even_streak_gte',
      barrier: 0,
      duration: 1,
      durationUnit: 't',
      payoutMultiplier: 1.95,
      rationale: `Current parity split is ${evenPct}% Even / ${oddPct}% Odd. Enters only after a 3-tick opposite parity streak.`,
      evaluate: (i) => {
        const s1 = slice[i].lastDigit % 2 === 0;
        const s2 = slice[i - 1].lastDigit % 2 === 0;
        const s3 = slice[i - 2].lastDigit % 2 === 0;
        if (favorEven) {
          if (!s1 && !s2 && !s3) return slice[i + 1].lastDigit % 2 === 0;
          return null;
        }
        if (s1 && s2 && s3) return slice[i + 1].lastDigit % 2 !== 0;
        return null;
      },
    });
  }

  if (supportsRiseFall) {
    // 5. EMA(9) > EMA(21) Bullish Trend Call
    pushBacktest({
      id: 'ema-call',
      label: `EMA(9/21) Bullish Trend Call (${baseDur}${baseUnit})`,
      tradeCategory: 'Up/Down',
      tradeType: 'Rise/Fall',
      contractType: 'CALL',
      conditionMode: 'ema_bullish',
      barrier: 0,
      duration: baseDur,
      durationUnit: baseUnit,
      payoutMultiplier: 1.95,
      rationale: `Enters Call when EMA(9) > EMA(21) with upward slope. Current EMA9=${ema9.toFixed(market.pipSize)} vs EMA21=${ema21.toFixed(market.pipSize)}.`,
      evaluate: (i) => {
        if (i + 3 >= slice.length) return null;
        if (ema9Series[i] > ema21Series[i] && prices[i] > ema9Series[i]) {
          return prices[i + 3] > prices[i];
        }
        return null;
      },
    });

    // 6. EMA(9) < EMA(21) Bearish Trend Put
    pushBacktest({
      id: 'ema-put',
      label: `EMA(9/21) Bearish Trend Put (${baseDur}${baseUnit})`,
      tradeCategory: 'Up/Down',
      tradeType: 'Rise/Fall',
      contractType: 'PUT',
      conditionMode: 'ema_bearish',
      barrier: 0,
      duration: baseDur,
      durationUnit: baseUnit,
      payoutMultiplier: 1.95,
      rationale: `Enters Put when EMA(9) < EMA(21) with downward momentum. RSI(14)=${rsi14}.`,
      evaluate: (i) => {
        if (i + 3 >= slice.length) return null;
        if (ema9Series[i] < ema21Series[i] && prices[i] < ema9Series[i]) {
          return prices[i + 3] < prices[i];
        }
        return null;
      },
    });

    // 7. RSI Oversold Rebound Call
    pushBacktest({
      id: 'rsi-rebound',
      label: `RSI(14) Oversold Rebound Call (${baseDur}${baseUnit})`,
      tradeCategory: 'Up/Down',
      tradeType: 'Rise/Fall',
      contractType: 'CALL',
      conditionMode: 'rsi_oversold',
      barrier: 0,
      duration: baseDur,
      durationUnit: baseUnit,
      payoutMultiplier: 1.95,
      rationale: `Mean-reversion Call triggered when RSI(14) dips below 32 (current RSI=${rsi14}, Bollinger %B=${bollingerPctB}%).`,
      evaluate: (i) => {
        if (i + 3 >= slice.length || i < 16) return null;
        const localRsi = computeRsi(prices.slice(i - 15, i + 1), 14);
        if (localRsi < 32) return prices[i + 3] > prices[i];
        return null;
      },
    });
  }

  if (supportsMultipliers) {
    const isBull = trendDirection !== 'BEARISH';
    pushBacktest({
      id: isBull ? 'mult-up' : 'mult-down',
      label: isBull
        ? 'Multiplier UP x100 (EMA Trend)'
        : 'Multiplier DOWN x100 (EMA Trend)',
      tradeCategory: 'Multipliers',
      tradeType: 'Multipliers',
      contractType: isBull ? 'MULTUP' : 'MULTDOWN',
      conditionMode: isBull ? 'ema_bullish' : 'ema_bearish',
      barrier: 0,
      duration: 1,
      durationUnit: 't',
      multiplier: 100,
      payoutMultiplier: 1.9,
      rationale: `Uses Deriv Multiplier x100 aligned with EMA(9/21) direction (${trendDirection}) for Crypto, Crash/Boom, and Indices.`,
      evaluate: (i) => {
        if (i + 4 >= slice.length) return null;
        if (isBull && ema9Series[i] > ema21Series[i]) {
          return prices[i + 4] > prices[i];
        }
        if (!isBull && ema9Series[i] < ema21Series[i]) {
          return prices[i + 4] < prices[i];
        }
        return null;
      },
    });
  }

  // Sort by Expected Value % descending, then sample trades
  opportunities.sort((a, b) => {
    if (b.expectedValuePct !== a.expectedValuePct) {
      return b.expectedValuePct - a.expectedValuePct;
    }
    return b.simulatedNetUsd - a.simulatedNetUsd;
  });

  return {
    symbol: market.symbol,
    sampleSize: slice.length,
    latestPrice,
    ema9,
    ema21,
    rsi14,
    bollingerUpper,
    bollingerLower,
    bollingerPctB,
    volatilityBps,
    regime,
    trendDirection,
    evenPct,
    oddPct,
    currentEvenStreak,
    currentOddStreak,
    coldestDigit,
    coldestDigitPct,
    hottestDigit,
    hottestDigitPct,
    opportunities,
    topOpportunity: opportunities[0] ?? null,
  };
}

export interface PreTradeRuntimeContext {
  lossStreak?: number;
  lockedLosingDigit?: number | null;
  lastTriggeredDigit?: number | null;
  ticksSinceLastTrade?: number;
}

export function evaluatePreTradeGate(
  ticks: TickPoint[],
  market: MarketSymbol,
  strategy: BotStrategyConfig,
  currentStake: number,
  cooldownRemaining = 0,
  runtimeContext: PreTradeRuntimeContext = {},
): PreTradeSignalVerdict {
  const cfg = {
    ...DEFAULT_PRETRADE_ANALYSIS,
    ...strategy.preTradeAnalysis,
  };
  const baseContract: ContractTypeOption =
    strategy.tradeParams.contractType === 'Both'
      ? 'DIGITDIFF'
      : strategy.tradeParams.contractType;
  const baseBarrier = strategy.purchaseConditions.predictionDigit ?? 4;

  // Dedicated Dual-Window Binomial Z-Score Gate (VALID DREAM v2 PRO engine)
  if (strategy.purchaseConditions.mode === 'dual_zscore_digit') {
    const longWindow = strategy.purchaseConditions.longWindow ?? 400;
    const shortWindow = strategy.purchaseConditions.shortWindow ?? 50;
    const recentWindow = strategy.purchaseConditions.recentWindow ?? 5;
    const hotLimit = strategy.purchaseConditions.hotLimit ?? 0;
    const minHistory = strategy.purchaseConditions.minHistoryTicks ?? 200;
    const minZ = strategy.purchaseConditions.dualZScoreThreshold ?? -1.6;
    const lossStreak = runtimeContext.lossStreak ?? 0;
    const activeGap =
      lossStreak > 0
        ? cfg.lossCooldownTicks
        : (strategy.purchaseConditions.tradeGapTicks ?? 10);
    const maxWait = strategy.purchaseConditions.maxWaitTicks ?? 120;
    const ticksSinceTrade = runtimeContext.ticksSinceLastTrade ?? activeGap;
    const lockActive =
      Boolean(strategy.restartConditions.lockLosingDigitOnLoss) &&
      lossStreak > 0 &&
      runtimeContext.lockedLosingDigit !== undefined &&
      runtimeContext.lockedLosingDigit !== null &&
      runtimeContext.lockedLosingDigit >= 0;

    const zResult = computeDualWindowDigitZScores(ticks, {
      longWindow,
      shortWindow,
      recentWindow,
      minZThreshold: minZ,
      excludedDigit: lossStreak > 0 ? runtimeContext.lastTriggeredDigit : null,
      lockedDigit: lockActive ? runtimeContext.lockedLosingDigit : null,
    });

    const historyOk = ticks.length >= minHistory;
    const gapOk = ticksSinceTrade >= activeGap;
    const recencyOk = zResult.cRecent <= hotLimit;
    const zOk = zResult.bestZ <= minZ;
    const fallbackOk = ticksSinceTrade >= maxWait && zResult.cRecent === 0;
    const approved = historyOk && cooldownRemaining <= 0 && ((gapOk && recencyOk && zOk) || fallbackOk);

    const longPct =
      zResult.windowN > 0 ? (zResult.cLong / zResult.windowN) * 100 : 10;
    const expectedValuePct = Number(
      (((100 - longPct) / 100) * 1.095 * 100 - 100).toFixed(2),
    );
    const zStrength = Math.max(0, Math.min(38, Math.round((-zResult.bestZ / Math.abs(minZ || 1.6)) * 28)));
    const confidence = historyOk
      ? Math.max(
          25,
          Math.min(
            99,
            45 + zStrength + (recencyOk ? 14 : -14) + (gapOk ? 6 : -8) + (lockActive ? 6 : 0),
          ),
        )
      : Math.min(40, Math.round((ticks.length / Math.max(1, minHistory)) * 40));

    const reasons: string[] = [];
    if (!historyOk) {
      reasons.push(`Warming digit buffer (${ticks.length}/${minHistory} ticks required)`);
    }
    if (lockActive) {
      reasons.push(
        `Losing-digit lock active: re-targeting digit ${zResult.predDigit} (streak ${lossStreak})`,
      );
    } else {
      reasons.push(
        `Digit ${zResult.predDigit} dual Z=${zResult.bestZ.toFixed(2)} (threshold <= ${minZ})`,
      );
    }
    reasons.push(
      `Anti-cluster ${zResult.cRecent}/${recentWindow} recent hits · Gap ${ticksSinceTrade}/${activeGap}t`,
    );
    if (fallbackOk && !(gapOk && recencyOk && zOk)) {
      reasons.unshift(`Max-wait fallback armed (${ticksSinceTrade}t >= ${maxWait}t, 0 recent hits)`);
    }

    return {
      approved,
      confidence,
      expectedValuePct,
      regime: lockActive ? 'Losing-Digit Recovery' : zOk ? 'Dual-Z Cold Edge' : 'Dual-Z Scanning',
      recommendedContract:
        baseContract === 'DIGITMATCH' ? 'DIGITMATCH' : 'DIGITDIFF',
      recommendedBarrier: zResult.predDigit,
      reasons: reasons.slice(0, 4),
      cooldownRemaining,
      evaluatedAt: Date.now(),
      bestZScore: zResult.bestZ,
      recentDigitHits: zResult.cRecent,
      lockedLosingDigit: lockActive ? runtimeContext.lockedLosingDigit ?? null : null,
      ticksSinceLastTrade: ticksSinceTrade,
      activeGapTicks: activeGap,
      isFallbackTrigger: fallbackOk && !(gapOk && recencyOk && zOk),
    };
  }

  if (ticks.length < 35) {
    return {
      approved: false,
      confidence: 0,
      expectedValuePct: 0,
      regime: 'Warming Up',
      recommendedContract: baseContract,
      recommendedBarrier: baseBarrier,
      reasons: [`Collecting tick history (${ticks.length}/35 minimum ticks)`],
      cooldownRemaining,
      evaluatedAt: Date.now(),
    };
  }

  const macroReport = analyzeMarketTicks(ticks, market, 250, currentStake);
  const shortSlice = ticks.slice(-60);
  const shortPrices = shortSlice.map((t) => t.quote);
  const ema9Series = computeEmaSeries(shortPrices, 9);
  const ema21Series = computeEmaSeries(shortPrices, 21);
  const ema9Now = ema9Series[ema9Series.length - 1] ?? macroReport.ema9;
  const ema9Prev = ema9Series[Math.max(0, ema9Series.length - 4)] ?? ema9Now;
  const ema21Now = ema21Series[ema21Series.length - 1] ?? macroReport.ema21;
  const emaExpandingUp = ema9Now > ema21Now && ema9Now > ema9Prev;
  const emaExpandingDown = ema9Now < ema21Now && ema9Now < ema9Prev;

  const last4 = shortPrices.slice(-4);
  const microImpulse =
    last4.length >= 2 ? last4[last4.length - 1] - last4[0] : 0;
  const lastTickMove =
    last4.length >= 2 ? last4[last4.length - 1] - last4[last4.length - 2] : 0;

  const reasons: string[] = [];
  let recommendedContract: ContractTypeOption = baseContract;
  let recommendedBarrier: number = baseBarrier;
  let confidence = 50;
  let expectedValuePct = 0;

  const autoBest =
    cfg.autoSelectBestContract || strategy.tradeParams.contractType === 'Both';

  // Candidate list ordered by quantitative suitability
  const topOpp = macroReport.topOpportunity;

  if (autoBest && topOpp) {
    recommendedContract = topOpp.contractType;
    recommendedBarrier = topOpp.barrier;
    expectedValuePct = topOpp.expectedValuePct;
  }

  // Evaluate Digits edge
  if (
    recommendedContract === 'DIGITDIFF' ||
    recommendedContract === 'DIGITMATCH' ||
    recommendedContract === 'DIGITOVER' ||
    recommendedContract === 'DIGITUNDER' ||
    recommendedContract === 'DIGITEVEN' ||
    recommendedContract === 'DIGITODD'
  ) {
    if (recommendedContract === 'DIGITDIFF') {
      const targetDigit = autoBest ? macroReport.coldestDigit : baseBarrier;
      recommendedBarrier = targetDigit;
      const macroCount = ticks
        .slice(-250)
        .filter((t) => t.lastDigit === targetDigit).length;
      const macroPct = (macroCount / Math.min(250, ticks.length)) * 100;
      const shortCount = shortSlice.filter((t) => t.lastDigit === targetDigit).length;
      const shortPct = (shortCount / Math.max(1, shortSlice.length)) * 100;
      const recent3 = ticks.slice(-3).some((t) => t.lastDigit === targetDigit);

      const survivalPct = 100 - macroPct;
      expectedValuePct = Number(((survivalPct / 100) * 1.095 * 100 - 100).toFixed(2));
      confidence = 52;
      if (macroPct <= 9.2) {
        confidence += 20;
        reasons.push(`Macro digit ${targetDigit} cold (${macroPct.toFixed(1)}% <= 9.2%)`);
      } else {
        reasons.push(`Macro digit ${targetDigit} frequency elevated (${macroPct.toFixed(1)}%)`);
      }
      if (shortPct <= 10.0) {
        confidence += 14;
        reasons.push(`60t confirmation cold (${shortPct.toFixed(1)}%)`);
      }
      if (!recent3) {
        confidence += 12;
        reasons.push(`Anti-cluster clear (absent in last 3 ticks)`);
      } else {
        confidence -= 15;
        reasons.push(`Anti-cluster wait: digit ${targetDigit} appeared in last 3 ticks`);
      }
    } else if (
      recommendedContract === 'DIGITOVER' ||
      recommendedContract === 'DIGITUNDER'
    ) {
      const isOver = recommendedContract === 'DIGITOVER';
      const winsPer10 = isOver
        ? Math.max(1, 9 - recommendedBarrier)
        : Math.max(1, recommendedBarrier);
      const payoutMult = Number(((10 / winsPer10) * 0.94).toFixed(3));
      const macroWin =
        (ticks
          .slice(-250)
          .filter((t) =>
            isOver ? t.lastDigit > recommendedBarrier : t.lastDigit < recommendedBarrier,
          ).length /
          Math.min(250, ticks.length)) *
        100;
      const shortWin =
        (shortSlice.filter((t) =>
          isOver ? t.lastDigit > recommendedBarrier : t.lastDigit < recommendedBarrier,
        ).length /
          Math.max(1, shortSlice.length)) *
        100;
      const breakEven = (1 / payoutMult) * 100;
      expectedValuePct = Number(((macroWin / 100) * payoutMult * 100 - 100).toFixed(2));
      confidence = 48;
      if (macroWin >= breakEven + 0.5) {
        confidence += 22;
        reasons.push(`250t win rate ${macroWin.toFixed(1)}% > BE ${breakEven.toFixed(1)}%`);
      } else {
        reasons.push(`250t win rate ${macroWin.toFixed(1)}% below BE ${breakEven.toFixed(1)}%`);
      }
      if (shortWin >= breakEven) {
        confidence += 18;
        reasons.push(`60t momentum strong (${shortWin.toFixed(1)}%)`);
      }
      if (expectedValuePct > 0) confidence += 10;
    } else if (
      recommendedContract === 'DIGITEVEN' ||
      recommendedContract === 'DIGITODD'
    ) {
      const wantEven = recommendedContract === 'DIGITEVEN';
      const targetBias = wantEven ? macroReport.evenPct : macroReport.oddPct;
      const oppStreak = wantEven
        ? macroReport.currentOddStreak
        : macroReport.currentEvenStreak;
      const matchingOpp = macroReport.opportunities.find(
        (o) => o.contractType === recommendedContract,
      );
      expectedValuePct = matchingOpp?.expectedValuePct ?? Number(((targetBias / 100) * 1.95 * 100 - 100).toFixed(2));
      confidence = 45;
      if (oppStreak >= 2) {
        confidence += oppStreak >= 3 ? 28 : 16;
        reasons.push(`${oppStreak}x opposite parity streak active`);
      } else {
        reasons.push(`Waiting for >=2x opposite parity streak`);
      }
      if (targetBias >= 51.0) {
        confidence += 18;
        reasons.push(`Macro parity skew favorable (${targetBias.toFixed(1)}%)`);
      }
    } else {
      // DIGITMATCH
      const matchPct = macroReport.hottestDigitPct;
      recommendedBarrier = autoBest ? macroReport.hottestDigit : baseBarrier;
      expectedValuePct = Number(((matchPct / 100) * 8.85 * 100 - 100).toFixed(2));
      confidence = matchPct >= 13.5 ? 72 : 42;
      reasons.push(`Hot digit ${recommendedBarrier} hitting ${matchPct}%`);
    }
  } else {
    // Rise/Fall (CALL/PUT) or Multipliers (MULTUP/MULTDOWN)
    const wantBull =
      recommendedContract === 'CALL' || recommendedContract === 'MULTUP';
    const matchingOpp = macroReport.opportunities.find(
      (o) => o.contractType === recommendedContract,
    );
    expectedValuePct = matchingOpp?.expectedValuePct ?? 0;

    confidence = 35;

    if (wantBull) {
      if (emaExpandingUp) {
        confidence += 26;
        reasons.push(`EMA(9)>EMA(21) expanding upward`);
      } else if (macroReport.rsi14 <= 32) {
        confidence += 24;
        reasons.push(`RSI(14) oversold rebound (${macroReport.rsi14})`);
      } else {
        reasons.push(`No bullish EMA/RSI alignment`);
      }

      if (macroReport.rsi14 >= 44 && macroReport.rsi14 <= 66) {
        confidence += 16;
        reasons.push(`RSI healthy trend zone (${macroReport.rsi14})`);
      } else if (macroReport.rsi14 > 74 && macroReport.bollingerPctB > 90) {
        confidence -= 22;
        reasons.push(`Overbought exhaustion guard (RSI ${macroReport.rsi14}, BB ${macroReport.bollingerPctB}%)`);
      }

      if (microImpulse > 0 && lastTickMove >= 0) {
        confidence += 15;
        reasons.push(`3-tick upward price confirmation`);
      } else {
        reasons.push(`Waiting for upward micro tick confirmation`);
      }
    } else {
      if (emaExpandingDown) {
        confidence += 26;
        reasons.push(`EMA(9)<EMA(21) expanding downward`);
      } else if (macroReport.rsi14 >= 68) {
        confidence += 24;
        reasons.push(`RSI(14) overbought rejection (${macroReport.rsi14})`);
      } else {
        reasons.push(`No bearish EMA/RSI alignment`);
      }

      if (macroReport.rsi14 >= 34 && macroReport.rsi14 <= 56) {
        confidence += 16;
        reasons.push(`RSI healthy bear zone (${macroReport.rsi14})`);
      } else if (macroReport.rsi14 < 26 && macroReport.bollingerPctB < 10) {
        confidence -= 22;
        reasons.push(`Oversold exhaustion guard (RSI ${macroReport.rsi14}, BB ${macroReport.bollingerPctB}%)`);
      }

      if (microImpulse < 0 && lastTickMove <= 0) {
        confidence += 15;
        reasons.push(`3-tick downward price confirmation`);
      } else {
        reasons.push(`Waiting for downward micro tick confirmation`);
      }
    }

    if (expectedValuePct > 0) {
      confidence += 12;
      reasons.push(`Backtest EV positive (+${expectedValuePct}%)`);
    } else {
      reasons.push(`Backtest EV cautious (${expectedValuePct}%)`);
    }
  }

  // Volatility sanity guard
  if (macroReport.volatilityBps > 85) {
    confidence -= 15;
    reasons.push(`High spike volatility (${macroReport.volatilityBps} bps)`);
  }

  // Enforce AI / Custom Quantitative Indicator Constraints
  let customConstraintsOk = true;
  const customRule = strategy.customQuantRule;
  if (customRule) {
    if (customRule.rsiMin !== undefined && macroReport.rsi14 < customRule.rsiMin) {
      customConstraintsOk = false;
      confidence -= 18;
      reasons.unshift(`RSI(${macroReport.rsi14}) < min ${customRule.rsiMin}`);
    }
    if (customRule.rsiMax !== undefined && macroReport.rsi14 > customRule.rsiMax) {
      customConstraintsOk = false;
      confidence -= 18;
      reasons.unshift(`RSI(${macroReport.rsi14}) > max ${customRule.rsiMax}`);
    }
    if (customRule.bbMinPct !== undefined && macroReport.bollingerPctB < customRule.bbMinPct) {
      customConstraintsOk = false;
      confidence -= 14;
      reasons.unshift(`Bollinger %B (${macroReport.bollingerPctB}%) < min ${customRule.bbMinPct}%`);
    }
    if (customRule.bbMaxPct !== undefined && macroReport.bollingerPctB > customRule.bbMaxPct) {
      customConstraintsOk = false;
      confidence -= 14;
      reasons.unshift(`Bollinger %B (${macroReport.bollingerPctB}%) > max ${customRule.bbMaxPct}%`);
    }
    if (customRule.minSlopeRatio !== undefined) {
      const localRegime = computeLocalRegimeFilter(shortPrices, Math.min(20, shortPrices.length), customRule.minSlopeRatio);
      if (localRegime.slopeRatio < customRule.minSlopeRatio) {
        customConstraintsOk = false;
        confidence -= 16;
        reasons.unshift(`Slope ratio ${localRegime.slopeRatio} < min ${customRule.minSlopeRatio}`);
      }
    }
    if (
      customRule.antiClusterTicks !== undefined &&
      customRule.antiClusterTicks > 0 &&
      recommendedContract.startsWith('DIGIT')
    ) {
      const clusterHit = ticks
        .slice(-customRule.antiClusterTicks)
        .some((t) => t.lastDigit === recommendedBarrier);
      if (clusterHit && (recommendedContract === 'DIGITDIFF' || recommendedContract === 'DIGITMATCH')) {
        if (recommendedContract === 'DIGITDIFF') {
          customConstraintsOk = false;
          confidence -= 16;
          reasons.unshift(`Digit ${recommendedBarrier} appeared in last ${customRule.antiClusterTicks}t`);
        }
      }
    }
  }

  const effectiveMinConf = Math.max(
    cfg.minConfidence,
    customRule?.minConfidence ?? 0,
    customRule?.perfectConditionsOnly ? 80 : 0,
  );
  const effectiveMinEv = Math.max(
    cfg.minEvPct,
    customRule?.minEvPct ?? -999,
    customRule?.perfectConditionsOnly ? 2.0 : -999,
  );

  const clampedConfidence = Math.max(0, Math.min(99, Math.round(confidence)));

  const evOk = (!cfg.requireConfluence && !customRule?.perfectConditionsOnly) || expectedValuePct >= effectiveMinEv;
  const confOk = clampedConfidence >= effectiveMinConf;
  const cooldownOk = cooldownRemaining <= 0;

  if (!cooldownOk) {
    reasons.unshift(`Cooldown guard active (${cooldownRemaining} ticks left)`);
  }

  return {
    approved: confOk && evOk && cooldownOk && customConstraintsOk,
    confidence: clampedConfidence,
    expectedValuePct,
    regime: macroReport.regime,
    recommendedContract,
    recommendedBarrier,
    reasons: reasons.slice(0, 4),
    cooldownRemaining,
    evaluatedAt: Date.now(),
  };
}

export interface DtraderPerfectSetupOptions {
  minConfidence?: number;
  minEvPct?: number;
  minZScore?: number;
  minBufferTicks?: number;
  minMarkovSurvivalPct?: number;
}

export function evaluateDtraderPerfectSetup(
  ticks: TickPoint[],
  market: MarketSymbol,
  options: DtraderPerfectSetupOptions = {},
): DtraderPerfectSetup {
  const minConfidence = options.minConfidence ?? 88;
  const minEvPct = options.minEvPct ?? 2.5;
  const minZScore = options.minZScore ?? -1.75;
  const minBufferTicks = options.minBufferTicks ?? 300;
  const minMarkovSurvivalPct = options.minMarkovSurvivalPct ?? 91.5;

  const sampleDepth = Math.min(1000, ticks.length);
  const bufferOk = ticks.length >= minBufferTicks;
  const window1000 = ticks.slice(-1000);
  const window250 = ticks.slice(-250);
  const window60 = ticks.slice(-60);
  const window10 = ticks.slice(-10);

  const report = analyzeMarketTicks(window1000, market, 1000, 10);
  const markov = computeMarkovTransitionSurvival(window1000, 1000);
  const zEval = computeDualWindowDigitZScores(window1000, {
    longWindow: 1000,
    shortWindow: 60,
    recentWindow: 10,
    minZThreshold: minZScore,
  });

  const denom1000 = Math.max(1, window1000.length);
  const denom250 = Math.max(1, window250.length);
  const denom60 = Math.max(1, window60.length);

  interface Candidate {
    contractType: ContractTypeOption;
    barrier: number;
    winRatePct: number;
    breakEvenPct: number;
    expectedValuePct: number;
    zScore: number;
    recentHits: number;
    antiCluster10: number;
    markovSurvivalPct: number;
    horizonBreakdown: { h1000: number; h250: number; h60: number };
    triHorizonAligned: boolean;
    markovPassed: boolean;
    antiClusterPassed: boolean;
    confidence: number;
    score: number;
    reason: string;
  }

  const candidates: Candidate[] = [];

  // 1. Master 1000t Dual-Z + Markov Digit Differ across top coldest candidates
  const sortedDigits = [...zEval.scoresByDigit].sort((a, b) => a.score - b.score).slice(0, 3);
  for (const item of sortedDigits) {
    const d = item.digit;
    const h1000 = Number(((window1000.filter((t) => t.lastDigit !== d).length / denom1000) * 100).toFixed(1));
    const h250 = Number(((window250.filter((t) => t.lastDigit !== d).length / denom250) * 100).toFixed(1));
    const h60 = Number(((window60.filter((t) => t.lastDigit !== d).length / denom60) * 100).toFixed(1));
    const antiCluster10 = window10.filter((t) => t.lastDigit === d).length;
    const markovSurv = markov.differSurvivalPctByDigit[d] ?? h1000;
    const breakEvenPct = 91.3;

    // Conservative empirical rate blends 1000t & 250t horizons
    const winRatePct = Number((Math.min(h1000, (h1000 * 0.55 + h250 * 0.45))).toFixed(1));
    const ev = Number(((winRatePct / 100) * 1.095 * 100 - 100).toFixed(2));
    const triHorizonAligned =
      h1000 >= breakEvenPct + 1.0 &&
      h250 >= breakEvenPct + 1.0 &&
      h60 >= breakEvenPct + 0.3;
    const antiClusterPassed = antiCluster10 === 0;
    const markovPassed = markovSurv >= minMarkovSurvivalPct;

    const zStrength = Math.max(0, Math.min(34, Math.round((-item.score / Math.max(1.2, Math.abs(minZScore))) * 24)));
    let conf =
      42 +
      zStrength +
      (triHorizonAligned ? 14 : -14) +
      (markovPassed ? 12 : -12) +
      (antiClusterPassed ? 12 : -22) +
      (ev >= minEvPct ? 8 : -6);
    if (!bufferOk) conf = Math.min(conf, 48);
    if (report.volatilityBps > 85) conf -= 14;
    conf = Math.max(10, Math.min(99, Math.round(conf)));

    candidates.push({
      contractType: 'DIGITDIFF',
      barrier: d,
      winRatePct,
      breakEvenPct,
      expectedValuePct: ev,
      zScore: Number(item.score.toFixed(3)),
      recentHits: antiCluster10,
      antiCluster10,
      markovSurvivalPct: markovSurv,
      horizonBreakdown: { h1000, h250, h60 },
      triHorizonAligned,
      markovPassed,
      antiClusterPassed,
      confidence: conf,
      score: Number(
        (
          ev * 4.2 +
          conf * 0.85 +
          (triHorizonAligned ? 14 : -18) +
          (markovPassed ? 10 : -14) +
          (antiClusterPassed ? 14 : -26)
        ).toFixed(2),
      ),
      reason: `Master 1000t Digit Differ [${d}] · Z=${item.score.toFixed(2)} · Markov ${markovSurv}% · 10t hits ${antiCluster10}`,
    });
  }

  // 2. Digit Over / Under Zones (Over 1, Over 2, Under 7, Under 8) across 1000t/250t/60t
  for (const spec of [
    { contractType: 'DIGITOVER' as const, barrier: 1, mult: 1.175, maxRecentMisses: 0 },
    { contractType: 'DIGITOVER' as const, barrier: 2, mult: 1.343, maxRecentMisses: 1 },
    { contractType: 'DIGITUNDER' as const, barrier: 7, mult: 1.343, maxRecentMisses: 1 },
    { contractType: 'DIGITUNDER' as const, barrier: 8, mult: 1.175, maxRecentMisses: 0 },
  ]) {
    const isOver = spec.contractType === 'DIGITOVER';
    const matchFn = (digit: number) => (isOver ? digit > spec.barrier : digit < spec.barrier);
    const wins1000 = window1000.filter((t) => matchFn(t.lastDigit)).length;
    const h1000 = Number(((wins1000 / denom1000) * 100).toFixed(1));
    const h250 = Number(((window250.filter((t) => matchFn(t.lastDigit)).length / denom250) * 100).toFixed(1));
    const h60 = Number(((window60.filter((t) => matchFn(t.lastDigit)).length / denom60) * 100).toFixed(1));
    const recentMisses = ticks.slice(-5).filter((t) => !matchFn(t.lastDigit)).length;
    const missIn10 = window10.filter((t) => !matchFn(t.lastDigit)).length;
    const breakEvenPct = Number(((1 / spec.mult) * 100).toFixed(1));
    const markovSurv = isOver
      ? markov.overSurvivalPct(spec.barrier)
      : markov.underSurvivalPct(spec.barrier);

    const winRatePct = Number(((h1000 * 0.55 + h250 * 0.45)).toFixed(1));
    const ev = Number(((winRatePct / 100) * spec.mult * 100 - 100).toFixed(2));
    const triHorizonAligned =
      h1000 >= breakEvenPct + 1.2 &&
      h250 >= breakEvenPct + 1.2 &&
      h60 >= breakEvenPct + 0.8;
    const markovPassed = markovSurv >= breakEvenPct + 1.0;
    const antiClusterPassed = recentMisses <= spec.maxRecentMisses && h60 >= breakEvenPct + 1.2;

    let conf =
      38 +
      Math.max(-18, Math.min(28, Math.round((winRatePct - breakEvenPct) * 5.2))) +
      (triHorizonAligned ? 16 : -14) +
      (markovPassed ? 10 : -10) +
      (antiClusterPassed ? 12 : -14);
    if (!bufferOk) conf = Math.min(conf, 48);
    if (report.volatilityBps > 85) conf -= 14;
    conf = Math.max(10, Math.min(99, Math.round(conf)));

    const pTheory = isOver ? (9 - spec.barrier) / 10 : spec.barrier / 10;
    candidates.push({
      contractType: spec.contractType,
      barrier: spec.barrier,
      winRatePct,
      breakEvenPct,
      expectedValuePct: ev,
      zScore: Number(computeBinomialZScoreWasm(wins1000, denom1000, pTheory).toFixed(2)),
      recentHits: missIn10,
      antiCluster10: missIn10,
      markovSurvivalPct: markovSurv,
      horizonBreakdown: { h1000, h250, h60 },
      triHorizonAligned,
      markovPassed,
      antiClusterPassed,
      confidence: conf,
      score: Number(
        (
          ev * 4.2 +
          conf * 0.85 +
          (triHorizonAligned ? 14 : -16) +
          (markovPassed ? 10 : -12) +
          (antiClusterPassed ? 10 : -18)
        ).toFixed(2),
      ),
      reason: `${isOver ? 'Over' : 'Under'} ${spec.barrier} · 1000t ${h1000}% / 250t ${h250}% / 60t ${h60}% · Markov ${markovSurv}%`,
    });
  }

  // 3. Extreme Parity Reversal (Even/Odd after >= 4x opposite streak + 1000t/250t confirmation)
  {
    const favorEven = report.evenPct >= report.oddPct;
    const oppStreak = favorEven ? report.currentOddStreak : report.currentEvenStreak;
    const countParity = (arr: TickPoint[]) =>
      arr.length === 0
        ? 50
        : Number(
            (
              (arr.filter((t) => (favorEven ? t.lastDigit % 2 === 0 : t.lastDigit % 2 !== 0)).length /
                arr.length) *
              100
            ).toFixed(1),
          );
    const h1000 = countParity(window1000);
    const h250 = countParity(window250);
    const h60 = countParity(window60);
    const winRatePct = Number(((h1000 * 0.5 + h250 * 0.5)).toFixed(1));
    const breakEvenPct = 51.3;
    const ev = Number(((winRatePct / 100) * 1.95 * 100 - 100).toFixed(2));
    const markovSurv = favorEven
      ? markov.evenAfterLastPct
      : Number((100 - markov.evenAfterLastPct).toFixed(2));

    const triHorizonAligned =
      h1000 >= breakEvenPct + 1.0 &&
      h250 >= breakEvenPct + 1.0 &&
      h60 >= breakEvenPct;
    const markovPassed = markovSurv >= breakEvenPct + 1.0;
    const antiClusterPassed = oppStreak >= 4;

    let conf =
      36 +
      (antiClusterPassed ? 24 : -14) +
      (triHorizonAligned ? 16 : -10) +
      (markovPassed ? 10 : -8) +
      Math.max(0, Math.min(20, Math.round((winRatePct - 50) * 3.5)));
    if (!bufferOk) conf = Math.min(conf, 48);
    if (report.volatilityBps > 85) conf -= 12;
    conf = Math.max(10, Math.min(99, Math.round(conf)));

    candidates.push({
      contractType: favorEven ? 'DIGITEVEN' : 'DIGITODD',
      barrier: 0,
      winRatePct,
      breakEvenPct,
      expectedValuePct: ev,
      zScore: Number(
        computeBinomialZScoreWasm(
          window1000.filter((t) => (favorEven ? t.lastDigit % 2 === 0 : t.lastDigit % 2 !== 0)).length,
          denom1000,
          0.5,
        ).toFixed(2),
      ),
      recentHits: oppStreak,
      antiCluster10: oppStreak,
      markovSurvivalPct: markovSurv,
      horizonBreakdown: { h1000, h250, h60 },
      triHorizonAligned,
      markovPassed,
      antiClusterPassed,
      confidence: conf,
      score: Number(
        (
          ev * 3.8 +
          conf * 0.8 +
          (triHorizonAligned ? 12 : -14) +
          (antiClusterPassed ? 14 : -18)
        ).toFixed(2),
      ),
      reason: `${favorEven ? 'Even' : 'Odd'} ${winRatePct}% (${oppStreak}x opp streak · Markov ${markovSurv}%)`,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  const winEdgeOk = best.winRatePct >= best.breakEvenPct + 1.5;
  const evOk = best.expectedValuePct >= minEvPct;
  const zOrConfirmOk =
    best.contractType === 'DIGITDIFF'
      ? best.zScore <= minZScore
      : best.contractType === 'DIGITOVER' || best.contractType === 'DIGITUNDER'
        ? best.zScore >= 1.25 || best.winRatePct >= best.breakEvenPct + 2.0
        : best.antiClusterPassed;
  const volOk = report.volatilityBps <= 85;
  const confOk = best.confidence >= minConfidence;

  const checklist: PerfectGateChecklistItem[] = [
    {
      label: `1000t Depth (>=${minBufferTicks}t)`,
      passed: bufferOk,
      value: `${sampleDepth}t / 1000t`,
    },
    {
      label: 'Tri-Horizon (1k/250/60)',
      passed: best.triHorizonAligned,
      value: `${best.horizonBreakdown.h1000}/${best.horizonBreakdown.h250}/${best.horizonBreakdown.h60}%`,
    },
    {
      label: 'Markov Survival',
      passed: best.markovPassed,
      value: `${best.markovSurvivalPct.toFixed(1)}%`,
    },
    {
      label: best.contractType === 'DIGITDIFF' ? '10t Anti-Cluster' : 'Recent Miss / Streak Guard',
      passed: best.antiClusterPassed,
      value:
        best.contractType === 'DIGITDIFF'
          ? `${best.antiCluster10}/10 hits`
          : best.contractType === 'DIGITEVEN' || best.contractType === 'DIGITODD'
            ? `${best.recentHits}x streak`
            : `${best.antiCluster10}/10 misses`,
    },
    {
      label: best.contractType === 'DIGITDIFF' ? `Dual-Z (<=${minZScore})` : 'Statistical Skew',
      passed: zOrConfirmOk,
      value: `Z=${best.zScore.toFixed(2)}`,
    },
    {
      label: `Win Margin & EV (>=+${minEvPct}%)`,
      passed: winEdgeOk && evOk,
      value: `${best.winRatePct}% (${best.expectedValuePct >= 0 ? '+' : ''}${best.expectedValuePct}%)`,
    },
    {
      label: `Master Conf (>=${minConfidence}%) & Vol`,
      passed: confOk && volOk,
      value: `${best.confidence}% · ${report.volatilityBps}bps`,
    },
  ];

  const allGatesPassed = checklist.every((c) => c.passed);

  return {
    allGatesPassed,
    symbol: market.symbol,
    contractType: best.contractType,
    barrier: best.barrier,
    winRatePct: best.winRatePct,
    breakEvenPct: best.breakEvenPct,
    expectedValuePct: best.expectedValuePct,
    zScore: best.zScore,
    recentHits: best.recentHits,
    markovSurvivalPct: best.markovSurvivalPct,
    antiCluster10: best.antiCluster10,
    horizonBreakdown: best.horizonBreakdown,
    volatilityBps: report.volatilityBps,
    sampleDepth,
    confidence: best.confidence,
    score: best.score,
    checklist,
    reasons: [
      best.reason,
      ...checklist.filter((c) => !c.passed).map((c) => `Waiting: ${c.label} (${c.value})`),
    ].slice(0, 4),
  };
}


