import { useMemo, useState } from 'react';
import { Bot, Download, Play, Search, ShieldAlert, Sliders } from 'lucide-react';
import { exportStrategyToDerivXml } from '../../lib/derivXml.ts';
import {
  DEFAULT_BOT_STRATEGY,
  DEFAULT_PRETRADE_ANALYSIS,
  type BotStrategyConfig,
  type MarketGroup,
} from '../../shared/types.ts';

interface FreebotsViewProps {
  onLoadStrategy: (strategy: BotStrategyConfig, runNow: boolean) => void;
}

interface FreebotTemplateItem {
  strategy: BotStrategyConfig;
  engineLabel: string;
  riskTier: 'Low' | 'Balanced' | 'High Capital';
  xmlAssetUrl?: string;
  xmlDownloadName?: string;
}

const VALID_DREAM_V2_PRO_TEMPLATE: BotStrategyConfig = {
  ...DEFAULT_BOT_STRATEGY,
  id: 'freebot-valid-dream-v2-pro',
  name: 'VALID DREAM v2 PRO (Losing Digit Recovery)',
  description:
    'Dual-window binomial Z-score (400t/50t <= -1.6) Digit Differ sniper on R_25 with 5-tick anti-cluster filter, losing-digit recovery lock, staged 36x -> 13x recovery, and dynamic stop-loss budget capping.',
  tradeParams: {
    ...DEFAULT_BOT_STRATEGY.tradeParams,
    marketGroup: 'Derived',
    subGroup: 'Continuous Indices',
    symbol: 'R_25',
    tradeCategory: 'Digits',
    tradeType: 'Matches/Differs',
    contractType: 'DIGITDIFF',
    candleInterval: '1 minute',
    restartBuySellOnError: false,
    restartLastTradeOnError: true,
  },
  variables: [
    { id: 'vd-1', name: 'stake', value: 10 },
    { id: 'vd-2', name: 'min_z_threshold', value: -1.6 },
    { id: 'vd-3', name: 'min_history', value: 200 },
    { id: 'vd-4', name: 'long_window', value: 400 },
    { id: 'vd-5', name: 'short_window', value: 50 },
    { id: 'vd-6', name: 'recent_window', value: 5 },
    { id: 'vd-7', name: 'trade_gap', value: 10 },
    { id: 'vd-8', name: 'loss_cooldown', value: 10 },
    { id: 'vd-9', name: 'max_wait', value: 120 },
    { id: 'vd-10', name: 'max_loss_streak', value: 3 },
    { id: 'vd-11', name: 'stage_2_multiplier', value: 36 },
    { id: 'vd-12', name: 'stage_3_multiplier', value: 13 },
  ],
  purchaseConditions: {
    mode: 'dual_zscore_digit',
    durationTicks: 1,
    durationUnit: 't',
    predictionDigit: 4,
    thresholdPct: 10,
    streakLength: 3,
    dualZScoreThreshold: -1.6,
    longWindow: 400,
    shortWindow: 50,
    recentWindow: 5,
    hotLimit: 0,
    minHistoryTicks: 200,
    tradeGapTicks: 10,
    maxWaitTicks: 120,
  },
  preTradeAnalysis: {
    ...DEFAULT_PRETRADE_ANALYSIS,
    enabled: true,
    minConfidence: 65,
    minEvPct: 0,
    autoSelectBestContract: true,
    requireConfluence: false,
    lossCooldownTicks: 10,
    maxConsecutiveLosses: 3,
    trailingProfitLockPct: 0,
  },
  restartConditions: {
    tradeAgain: true,
    useMartingale: true,
    martingaleMultiplier: 36,
    stage2Multiplier: 36,
    stage3Multiplier: 13,
    lockLosingDigitOnLoss: true,
    capStakeToRemainingStopLoss: true,
    maxStake: 50000,
    takeProfit: 200,
    stopLoss: 5000,
    delayMs: 500,
  },
};

const PROFITABLE_QUANT_REGIME_TEMPLATE: BotStrategyConfig = {
  ...DEFAULT_BOT_STRATEGY,
  id: 'freebot-profitable-quant-regime',
  name: 'Profitable Quant Regime (1.5% · 2-Step Cap)',
  description:
    'Fractional 1.5% balance sizing with 2-step capped 2.1x recovery (hard reset after 2 losses), +6% / -4% daily session locks, 45s post-loss cooldown, and 85% min confidence EMA trend gate.',
  tradeParams: {
    ...DEFAULT_BOT_STRATEGY.tradeParams,
    marketGroup: 'Derived',
    subGroup: 'Continuous Indices',
    symbol: 'R_25',
    tradeCategory: 'Up/Down',
    tradeType: 'Rise/Fall',
    contractType: 'CALL',
    candleInterval: '1 tick',
    restartBuySellOnError: false,
    restartLastTradeOnError: true,
  },
  variables: [
    { id: 'pq-1', name: 'stake', value: 1.5 },
    { id: 'pq-2', name: 'base_risk_pct', value: 1.5 },
    { id: 'pq-3', name: 'max_recovery_steps', value: 2 },
    { id: 'pq-4', name: 'daily_profit_target_pct', value: 6 },
    { id: 'pq-5', name: 'daily_max_loss_pct', value: 4 },
  ],
  purchaseConditions: {
    mode: 'ema_bullish',
    durationTicks: 5,
    durationUnit: 't',
    predictionDigit: 4,
    thresholdPct: 10,
    streakLength: 3,
  },
  preTradeAnalysis: {
    ...DEFAULT_PRETRADE_ANALYSIS,
    enabled: true,
    minConfidence: 85,
    minEvPct: 0.5,
    autoSelectBestContract: true,
    requireConfluence: true,
    lossCooldownTicks: 5,
    maxConsecutiveLosses: 0,
    trailingProfitLockPct: 50,
  },
  restartConditions: {
    tradeAgain: true,
    useMartingale: true,
    martingaleMultiplier: 2.1,
    maxRecoverySteps: 2,
    useFractionalBalanceRisk: true,
    baseRiskPct: 1.5,
    useDailyPctLocks: true,
    dailyProfitTargetPct: 6,
    dailyMaxLossPct: 4,
    lossCooldownSeconds: 45,
    maxStake: 250,
    takeProfit: 60,
    stopLoss: 40,
    delayMs: 1500,
  },
};

const FREEBOT_TEMPLATES: FreebotTemplateItem[] = [
  {
    strategy: PROFITABLE_QUANT_REGIME_TEMPLATE,
    engineLabel: '1.5% Risk · 2-Step Cap · +6%/-4%',
    riskTier: 'Low',
  },
  {
    strategy: VALID_DREAM_V2_PRO_TEMPLATE,
    engineLabel: 'Dual-Z (-1.6) + Digit Lock',
    riskTier: 'High Capital',
    xmlAssetUrl: '/assets/aistudio/VALID_DREAM_v2_PRO_LOSING_DIGIT_2b98de3b.xml',
    xmlDownloadName: 'VALID_DREAM_v2_PRO_LOSING_DIGIT.xml',
  },
  {
    strategy: DEFAULT_BOT_STRATEGY,
    engineLabel: 'Quant EV Gate',
    riskTier: 'Balanced',
  },
  {
    strategy: {
      ...DEFAULT_BOT_STRATEGY,
      id: 'freebot-eurusd-ema',
      name: 'EUR/USD EMA(9/21) Trend Rider',
      description:
        'Monitors Major Forex pair EUR/USD and enters 15-minute Rise (Call) positions when EMA(9) crosses above EMA(21) without Martingale.',
      tradeParams: {
        ...DEFAULT_BOT_STRATEGY.tradeParams,
        marketGroup: 'Forex',
        subGroup: 'Major Pairs',
        symbol: 'frxEURUSD',
        tradeCategory: 'Up/Down',
        tradeType: 'Rise/Fall',
        contractType: 'CALL',
      },
      variables: [{ id: 'v-5', name: 'stake', value: 10 }],
      purchaseConditions: {
        mode: 'ema_bullish',
        durationTicks: 15,
        durationUnit: 'm',
        predictionDigit: 0,
        thresholdPct: 10,
        streakLength: 3,
      },
      restartConditions: {
        ...DEFAULT_BOT_STRATEGY.restartConditions,
        useMartingale: false,
        martingaleMultiplier: 1.0,
        takeProfit: 50,
        stopLoss: 50,
      },
    },
    engineLabel: 'EMA Crossover · Flat',
    riskTier: 'Low',
  },
  {
    strategy: {
      ...DEFAULT_BOT_STRATEGY,
      id: 'freebot-gold-rsi',
      name: 'Gold/USD RSI(14) Oversold Rebound',
      description:
        'Captures mean-reversion rallies on Spot Gold (XAU/USD) by entering 5-minute Calls when RSI(14) drops below 34.',
      tradeParams: {
        ...DEFAULT_BOT_STRATEGY.tradeParams,
        marketGroup: 'Commodities',
        subGroup: 'Metals',
        symbol: 'frxXAUUSD',
        tradeCategory: 'Up/Down',
        tradeType: 'Rise/Fall',
        contractType: 'CALL',
      },
      variables: [{ id: 'v-5', name: 'stake', value: 10 }],
      purchaseConditions: {
        mode: 'rsi_oversold',
        durationTicks: 5,
        durationUnit: 'm',
        predictionDigit: 0,
        thresholdPct: 10,
        streakLength: 3,
      },
      restartConditions: {
        ...DEFAULT_BOT_STRATEGY.restartConditions,
        useMartingale: false,
        martingaleMultiplier: 1.0,
        takeProfit: 60,
        stopLoss: 60,
      },
    },
    engineLabel: 'RSI Mean Reversion',
    riskTier: 'Low',
  },
  {
    strategy: {
      ...DEFAULT_BOT_STRATEGY,
      id: 'freebot-btc-multiplier',
      name: 'BTC/USD x100 EMA Multiplier',
      description:
        'Opens 24/7 Cryptocurrency Multiplier UP positions on Bitcoin when EMA(9) leads EMA(21) higher.',
      tradeParams: {
        ...DEFAULT_BOT_STRATEGY.tradeParams,
        marketGroup: 'Cryptocurrencies',
        subGroup: 'Non-Stable Coins',
        symbol: 'cryBTCUSD',
        tradeCategory: 'Multipliers',
        tradeType: 'Multipliers',
        contractType: 'MULTUP',
      },
      variables: [{ id: 'v-5', name: 'stake', value: 15 }],
      purchaseConditions: {
        mode: 'ema_bullish',
        durationTicks: 1,
        durationUnit: 't',
        multiplier: 100,
        predictionDigit: 0,
        thresholdPct: 10,
        streakLength: 3,
      },
      restartConditions: {
        ...DEFAULT_BOT_STRATEGY.restartConditions,
        useMartingale: false,
        martingaleMultiplier: 1.0,
        takeProfit: 75,
        stopLoss: 50,
      },
    },
    engineLabel: 'x100 Multiplier Trend',
    riskTier: 'Balanced',
  },
  {
    strategy: {
      ...DEFAULT_BOT_STRATEGY,
      id: 'freebot-even-odd-streak',
      name: 'Even/Odd 3-Streak Reversal',
      description:
        'Waits for 3 consecutive odd last-digits on Volatility 10 (1s) before entering Digit Even with conservative 2.0x recovery.',
      tradeParams: {
        ...DEFAULT_BOT_STRATEGY.tradeParams,
        marketGroup: 'Derived',
        subGroup: 'Continuous Indices',
        symbol: '1HZ10V',
        tradeCategory: 'Digits',
        tradeType: 'Even/Odd',
        contractType: 'DIGITEVEN',
      },
      variables: [
        { id: 'v-1', name: 'tick_counter', value: 0 },
        { id: 'v-2', name: 'streak_target', value: 3 },
        { id: 'v-5', name: 'stake', value: 5 },
      ],
      purchaseConditions: {
        mode: 'odd_streak_gte',
        durationTicks: 1,
        durationUnit: 't',
        predictionDigit: 2,
        thresholdPct: 10,
        streakLength: 3,
      },
      restartConditions: {
        ...DEFAULT_BOT_STRATEGY.restartConditions,
        useMartingale: true,
        martingaleMultiplier: 2.0,
        takeProfit: 35,
        stopLoss: 75,
      },
    },
    engineLabel: '3-Tick Parity Reversal',
    riskTier: 'Balanced',
  },
  {
    strategy: {
      ...DEFAULT_BOT_STRATEGY,
      id: 'freebot-over-2-ladder',
      name: 'Volatility 50 Over-2 Steady',
      description:
        'High win-probability Digit Over 2 strategy (70% theoretical hit rate) with mild 2.4x Martingale and tight $25 daily target.',
      tradeParams: {
        ...DEFAULT_BOT_STRATEGY.tradeParams,
        marketGroup: 'Derived',
        subGroup: 'Continuous Indices',
        symbol: 'R_50',
        tradeCategory: 'Digits',
        tradeType: 'Over/Under',
        contractType: 'DIGITOVER',
      },
      variables: [
        { id: 'v-1', name: 'barrier', value: 2 },
        { id: 'v-5', name: 'stake', value: 4 },
      ],
      purchaseConditions: {
        mode: 'always',
        durationTicks: 1,
        durationUnit: 't',
        predictionDigit: 2,
        thresholdPct: 10,
        streakLength: 3,
      },
      restartConditions: {
        ...DEFAULT_BOT_STRATEGY.restartConditions,
        useMartingale: true,
        martingaleMultiplier: 2.4,
        takeProfit: 25,
        stopLoss: 60,
      },
    },
    engineLabel: '70% Over-2 Zone',
    riskTier: 'Balanced',
  },
];

const MARKET_FILTERS: ('All' | MarketGroup)[] = [
  'All',
  'Derived',
  'Forex',
  'Commodities',
  'Stock Indices',
  'Cryptocurrencies',
];

function scaleStrategyToMicroStake(strategy: BotStrategyConfig): BotStrategyConfig {
  const baseStake = strategy.variables.find((v) => v.name === 'stake')?.value ?? 10;
  if (baseStake <= 1) return strategy;
  const factor = 1 / baseStake;
  return {
    ...strategy,
    name: `${strategy.name} [$1 Micro]`,
    variables: strategy.variables.map((v) =>
      v.name === 'stake' ? { ...v, value: 1 } : v,
    ),
    restartConditions: {
      ...strategy.restartConditions,
      takeProfit: Math.max(2, Number((strategy.restartConditions.takeProfit * factor).toFixed(2))),
      stopLoss: Math.max(5, Number((strategy.restartConditions.stopLoss * factor).toFixed(2))),
      maxStake: Math.max(5, Number((strategy.restartConditions.maxStake * factor).toFixed(2))),
    },
  };
}

export function FreebotsView({ onLoadStrategy }: FreebotsViewProps) {
  const [marketFilter, setMarketFilter] = useState<'All' | MarketGroup>('All');
  const [query, setQuery] = useState('');
  const [microScale, setMicroScale] = useState(false);

  const visibleTemplates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FREEBOT_TEMPLATES.filter((item) => {
      if (
        marketFilter !== 'All' &&
        item.strategy.tradeParams.marketGroup !== marketFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        item.strategy.name.toLowerCase().includes(q) ||
        item.strategy.description.toLowerCase().includes(q) ||
        item.strategy.tradeParams.symbol.toLowerCase().includes(q) ||
        item.engineLabel.toLowerCase().includes(q)
      );
    });
  }, [marketFilter, query]);

  const handleDownloadXml = (item: FreebotTemplateItem) => {
    if (item.xmlAssetUrl) {
      const a = document.createElement('a');
      a.href = item.xmlAssetUrl;
      a.download = item.xmlDownloadName || `${item.strategy.id}.xml`;
      a.click();
      return;
    }
    const xml = exportStrategyToDerivXml(item.strategy);
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.strategy.id}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="font-display font-bold text-2xl text-slate-900 dark:text-slate-100">
              Freebots &amp; Strategy Library
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Pre-calibrated DBot strategies with dual-window Z-score digit gating, staged recovery, Forex EMA trends, and Crypto multipliers.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0F172A] text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={microScale}
                onChange={(e) => setMicroScale(e.target.checked)}
                className="rounded border-slate-400 text-[#0E5A78]"
              />
              <span>Scale to $1 Micro Stake</span>
            </label>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search bots or symbols..."
                className="pl-8 pr-3 py-1.5 w-52 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0F172A] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
              />
            </div>
          </div>
        </div>

        {/* Market Filter Bar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 dark:border-slate-800 pb-3">
          {MARKET_FILTERS.map((grp) => {
            const active = marketFilter === grp;
            return (
              <button
                key={grp}
                type="button"
                onClick={() => setMarketFilter(grp)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#0E5A78] text-white'
                    : 'bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {grp}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleTemplates.map((item) => {
            const effective = microScale
              ? scaleStrategyToMicroStake(item.strategy)
              : item.strategy;
            const stake = effective.variables.find((v) => v.name === 'stake')?.value ?? 10;
            const hasStaged =
              effective.restartConditions.stage2Multiplier &&
              effective.restartConditions.stage2Multiplier > 1;
            const recoveryLabel = !effective.restartConditions.useMartingale
              ? 'Flat'
              : hasStaged
                ? `${effective.restartConditions.stage2Multiplier}x -> ${effective.restartConditions.stage3Multiplier ?? effective.restartConditions.stage2Multiplier}x`
                : `${effective.restartConditions.martingaleMultiplier}x`;

            return (
              <div
                key={item.strategy.id}
                className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-5 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Bot className="w-4 h-4 shrink-0 text-[#0E5A78] dark:text-[#00A8E8]" />
                      <span className="font-mono text-[11px] font-semibold text-slate-500 dark:text-slate-400 truncate">
                        {effective.tradeParams.symbol} · {effective.tradeParams.contractType}
                      </span>
                    </div>
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-semibold text-slate-600 dark:text-slate-300 shrink-0">
                      {effective.tradeParams.marketGroup}
                    </span>
                  </div>

                  <h2 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
                    {effective.name}
                  </h2>

                  <div className="mt-1 flex items-center gap-2 text-[11px] font-medium text-[#0F766E] dark:text-teal-300">
                    <span>{item.engineLabel}</span>
                    {effective.restartConditions.lockLosingDigitOnLoss && (
                      <span className="text-slate-400">·</span>
                    )}
                    {effective.restartConditions.lockLosingDigitOnLoss && (
                      <span>Streak Cap {effective.preTradeAnalysis?.maxConsecutiveLosses ?? 3}</span>
                    )}
                  </div>

                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {effective.description}
                  </p>

                  {item.riskTier === 'High Capital' && (
                    <div className="mt-2.5 flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/70 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
                      <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        Staged {effective.restartConditions.stage2Multiplier}x/{effective.restartConditions.stage3Multiplier}x step-up: $
                        {stake} → ${(stake * (effective.restartConditions.stage2Multiplier ?? 1)).toLocaleString()} → $
                        {(stake * (effective.restartConditions.stage2Multiplier ?? 1) * (effective.restartConditions.stage3Multiplier ?? 1)).toLocaleString()} (capped at SL ${effective.restartConditions.stopLoss}).
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-100 dark:border-slate-800 font-mono text-[11px] tabular-nums">
                    <div>
                      <span className="text-slate-400 block">Stake</span>
                      <span className="font-bold text-slate-800 dark:text-slate-200">
                        ${stake}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">TP / SL</span>
                      <span className="font-bold text-slate-800 dark:text-slate-200">
                        ${effective.restartConditions.takeProfit}/${effective.restartConditions.stopLoss}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Recovery</span>
                      <span className="font-bold text-slate-800 dark:text-slate-200">
                        {recoveryLabel}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      title={item.xmlAssetUrl ? 'Download original DBot XML' : 'Download Deriv XML'}
                      onClick={() => handleDownloadXml(item)}
                      className="p-2 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onLoadStrategy(effective, false)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200 cursor-pointer"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Edit Blocks</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onLoadStrategy(effective, true)}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-md bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-bold cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Load &amp; Run</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {visibleTemplates.length === 0 && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A] p-10 text-center text-xs text-slate-500 dark:text-slate-400">
            No strategy templates match the current filter.
          </div>
        )}
      </div>
    </div>
  );
}
