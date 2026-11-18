export type MainTabId =
  | 'dashboard'
  | 'bulk-trader'
  | 'bot-builder'
  | 'freebots'
  | 'dtrader-circles'
  | 'hedging-beast'
  | 'ai-analysis'
  | 'trading-view'
  | 'analysis-tool'
  | 'quant-3d'
  | 'deriv-services';

export type RightTabId = 'summary' | 'transactions' | 'journal';

export type MarketGroup =
  | 'Derived'
  | 'Forex'
  | 'Commodities'
  | 'Stock Indices'
  | 'Cryptocurrencies';

export type MarketSubGroup = string;

export type TradeCategory = 'Digits' | 'Up/Down' | 'Multipliers';
export type TradeSubType =
  | 'Matches/Differs'
  | 'Even/Odd'
  | 'Over/Under'
  | 'Rise/Fall'
  | 'Multipliers';

export type ContractTypeOption =
  | 'Both'
  | 'DIGITMATCH'
  | 'DIGITDIFF'
  | 'DIGITEVEN'
  | 'DIGITODD'
  | 'DIGITOVER'
  | 'DIGITUNDER'
  | 'CALL'
  | 'PUT'
  | 'MULTUP'
  | 'MULTDOWN';

export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';
export type CandleInterval = '1 tick' | '1 minute' | '5 minutes' | '15 minutes';

export type PurchaseConditionMode =
  | 'best_quant_edge'
  | 'dual_zscore_digit'
  | 'always'
  | 'digit_pct_lte'
  | 'digit_pct_gte'
  | 'even_streak_gte'
  | 'odd_streak_gte'
  | 'trend_up'
  | 'trend_down'
  | 'ema_bullish'
  | 'ema_bearish'
  | 'rsi_oversold'
  | 'rsi_overbought';

export interface PreTradeAnalysisConfig {
  enabled: boolean;
  minConfidence: number;
  minEvPct: number;
  autoSelectBestContract: boolean;
  requireConfluence: boolean;
  lossCooldownTicks: number;
  maxConsecutiveLosses: number;
  trailingProfitLockPct: number;
}

export interface PreTradeSignalVerdict {
  approved: boolean;
  confidence: number;
  expectedValuePct: number;
  regime: string;
  recommendedContract: ContractTypeOption;
  recommendedBarrier: number;
  reasons: string[];
  cooldownRemaining: number;
  evaluatedAt: number;
  bestZScore?: number;
  recentDigitHits?: number;
  lockedLosingDigit?: number | null;
  ticksSinceLastTrade?: number;
  activeGapTicks?: number;
  isFallbackTrigger?: boolean;
}

export interface MarketSymbol {
  symbol: string;
  name: string;
  marketGroup: MarketGroup;
  subGroup: MarketSubGroup;
  pipSize: number;
  basePrice: number;
  exchangeOpen?: boolean;
  supportsDigits?: boolean;
  supportsRiseFall?: boolean;
  supportsMultipliers?: boolean;
  defaultDuration?: number;
  defaultDurationUnit?: DurationUnit;
}

export const DERIV_MARKETS: MarketSymbol[] = [
  // Derived — Continuous Indices
  { symbol: 'R_10', name: 'Volatility 10 Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 3, basePrice: 6420.15, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'R_25', name: 'Volatility 25 Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 3, basePrice: 2861.102, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'R_50', name: 'Volatility 50 Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 4, basePrice: 184.5214, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'R_75', name: 'Volatility 75 Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 4, basePrice: 142310.4512, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'R_100', name: 'Volatility 100 Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 2, basePrice: 1284.72, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: '1HZ10V', name: 'Volatility 10 (1s) Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 2, basePrice: 9512.44, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: '1HZ25V', name: 'Volatility 25 (1s) Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 2, basePrice: 412845.12, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: '1HZ50V', name: 'Volatility 50 (1s) Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 2, basePrice: 245112.84, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: '1HZ75V', name: 'Volatility 75 (1s) Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 2, basePrice: 8240.55, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s) Index', marketGroup: 'Derived', subGroup: 'Continuous Indices', pipSize: 2, basePrice: 912.35, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  // Derived — Jump, Daily Reset, Step, Crash/Boom, Baskets
  { symbol: 'JD10', name: 'Jump 10 Index', marketGroup: 'Derived', subGroup: 'Jump Indices', pipSize: 2, basePrice: 105420.18, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'JD25', name: 'Jump 25 Index', marketGroup: 'Derived', subGroup: 'Jump Indices', pipSize: 2, basePrice: 112450.28, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'JD50', name: 'Jump 50 Index', marketGroup: 'Derived', subGroup: 'Jump Indices', pipSize: 2, basePrice: 94112.44, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'JD75', name: 'Jump 75 Index', marketGroup: 'Derived', subGroup: 'Jump Indices', pipSize: 2, basePrice: 68214.91, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'JD100', name: 'Jump 100 Index', marketGroup: 'Derived', subGroup: 'Jump Indices', pipSize: 2, basePrice: 74220.65, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'RDBULL', name: 'Bull Market Index', marketGroup: 'Derived', subGroup: 'Daily Reset Indices', pipSize: 4, basePrice: 1250.412, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'RDBEAR', name: 'Bear Market Index', marketGroup: 'Derived', subGroup: 'Daily Reset Indices', pipSize: 4, basePrice: 980.1542, exchangeOpen: true, supportsDigits: true, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'stpRNG', name: 'Step Index', marketGroup: 'Derived', subGroup: 'Step Indices', pipSize: 1, basePrice: 8500.5, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 5, defaultDurationUnit: 't' },
  { symbol: 'BOOM1000', name: 'Boom 1000 Index', marketGroup: 'Derived', subGroup: 'Crash/Boom Indices', pipSize: 4, basePrice: 14250.4512, exchangeOpen: true, supportsDigits: false, supportsRiseFall: false, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'CRASH1000', name: 'Crash 1000 Index', marketGroup: 'Derived', subGroup: 'Crash/Boom Indices', pipSize: 4, basePrice: 7420.1234, exchangeOpen: true, supportsDigits: false, supportsRiseFall: false, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'WLDUSD', name: 'USD Basket', marketGroup: 'Derived', subGroup: 'Forex Baskets', pipSize: 2, basePrice: 104.25, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 15, defaultDurationUnit: 'm' },
  // Forex
  { symbol: 'frxEURUSD', name: 'EUR/USD', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 5, basePrice: 1.08425, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'frxGBPUSD', name: 'GBP/USD', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 5, basePrice: 1.26842, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'frxUSDJPY', name: 'USD/JPY', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 3, basePrice: 154.215, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'frxAUDUSD', name: 'AUD/USD', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 5, basePrice: 0.65412, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'frxUSDCAD', name: 'USD/CAD', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 5, basePrice: 1.39125, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'frxEURJPY', name: 'EUR/JPY', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 3, basePrice: 167.214, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'frxGBPJPY', name: 'GBP/JPY', marketGroup: 'Forex', subGroup: 'Major Pairs', pipSize: 3, basePrice: 195.412, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 15, defaultDurationUnit: 'm' },
  // Commodities
  { symbol: 'frxXAUUSD', name: 'Gold/USD', marketGroup: 'Commodities', subGroup: 'Metals', pipSize: 2, basePrice: 2642.55, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: true, defaultDuration: 5, defaultDurationUnit: 'm' },
  { symbol: 'frxXAGUSD', name: 'Silver/USD', marketGroup: 'Commodities', subGroup: 'Metals', pipSize: 3, basePrice: 31.425, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 5, defaultDurationUnit: 'm' },
  // Cryptocurrencies
  { symbol: 'cryBTCUSD', name: 'BTC/USD', marketGroup: 'Cryptocurrencies', subGroup: 'Non-Stable Coins', pipSize: 2, basePrice: 91420.5, exchangeOpen: true, supportsDigits: false, supportsRiseFall: false, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  { symbol: 'cryETHUSD', name: 'ETH/USD', marketGroup: 'Cryptocurrencies', subGroup: 'Non-Stable Coins', pipSize: 2, basePrice: 3180.25, exchangeOpen: true, supportsDigits: false, supportsRiseFall: false, supportsMultipliers: true, defaultDuration: 1, defaultDurationUnit: 't' },
  // Stock Indices
  { symbol: 'OTC_SPC', name: 'US 500', marketGroup: 'Stock Indices', subGroup: 'Americas', pipSize: 2, basePrice: 5920.4, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'OTC_NDX', name: 'US Tech 100', marketGroup: 'Stock Indices', subGroup: 'Americas', pipSize: 2, basePrice: 20840.25, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'OTC_DJI', name: 'Wall Street 30', marketGroup: 'Stock Indices', subGroup: 'Americas', pipSize: 2, basePrice: 43820.1, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'OTC_GDAXI', name: 'Germany 40', marketGroup: 'Stock Indices', subGroup: 'Europe', pipSize: 2, basePrice: 19240.8, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 15, defaultDurationUnit: 'm' },
  { symbol: 'OTC_N225', name: 'Japan 225', marketGroup: 'Stock Indices', subGroup: 'Asia/Oceania', pipSize: 2, basePrice: 38640.5, exchangeOpen: true, supportsDigits: false, supportsRiseFall: true, supportsMultipliers: false, defaultDuration: 15, defaultDurationUnit: 'm' },
];

export type PolyglotLanguage =
  | 'typescript'
  | 'python'
  | 'rust'
  | 'cpp'
  | 'go'
  | 'pinescript'
  | 'mql5'
  | 'sql'
  | 'xml';

export interface CustomQuantRule {
  minConfidence?: number;
  minEvPct?: number;
  minSlopeRatio?: number;
  rsiMin?: number;
  rsiMax?: number;
  bbMinPct?: number;
  bbMaxPct?: number;
  dualZThreshold?: number;
  antiClusterTicks?: number;
  perfectConditionsOnly?: boolean;
}

export interface PerfectGateChecklistItem {
  label: string;
  passed: boolean;
  value: string;
}

export interface DtraderHorizonBreakdown {
  h1000: number;
  h250: number;
  h60: number;
}

export interface DtraderPerfectSetup {
  allGatesPassed: boolean;
  symbol: string;
  contractType: ContractTypeOption;
  barrier: number;
  winRatePct: number;
  breakEvenPct: number;
  expectedValuePct: number;
  zScore: number;
  recentHits: number;
  markovSurvivalPct: number;
  antiCluster10: number;
  horizonBreakdown: DtraderHorizonBreakdown;
  volatilityBps: number;
  sampleDepth: number;
  confidence: number;
  score: number;
  checklist: PerfectGateChecklistItem[];
  reasons: string[];
}

export interface BotVariable {
  id: string;
  name: string;
  value: number;
}

export interface BotStrategyConfig {
  id: string;
  name: string;
  description: string;
  tradeParams: {
    marketGroup: MarketGroup;
    subGroup: MarketSubGroup;
    symbol: string;
    changeMarketOnRun: boolean;
    updateAnalysisOnCycle: boolean;
    fastTrades: boolean;
    tradeCategory: TradeCategory;
    tradeType: TradeSubType;
    contractType: ContractTypeOption;
    candleInterval: CandleInterval;
    restartBuySellOnError: boolean;
    restartLastTradeOnError: boolean;
  };
  variables: BotVariable[];
  purchaseConditions: {
    mode: PurchaseConditionMode;
    durationTicks: number;
    durationUnit?: DurationUnit;
    multiplier?: number;
    predictionDigit: number;
    thresholdPct: number;
    streakLength: number;
    dualZScoreThreshold?: number;
    longWindow?: number;
    shortWindow?: number;
    recentWindow?: number;
    hotLimit?: number;
    minHistoryTicks?: number;
    tradeGapTicks?: number;
    maxWaitTicks?: number;
  };
  customQuantRule?: CustomQuantRule;
  preTradeAnalysis?: PreTradeAnalysisConfig;
  sellConditions: {
    sellAtMarketOnProfit: boolean;
    profitTargetPct: number;
  };
  restartConditions: {
    tradeAgain: boolean;
    useMartingale: boolean;
    martingaleMultiplier: number;
    stage2Multiplier?: number;
    stage3Multiplier?: number;
    maxRecoverySteps?: number;
    useFractionalBalanceRisk?: boolean;
    baseRiskPct?: number;
    useDailyPctLocks?: boolean;
    dailyProfitTargetPct?: number;
    dailyMaxLossPct?: number;
    lossCooldownSeconds?: number;
    lockLosingDigitOnLoss?: boolean;
    capStakeToRemainingStopLoss?: boolean;
    maxStake: number;
    takeProfit: number;
    stopLoss: number;
    delayMs: number;
  };
}

export const DEFAULT_PRETRADE_ANALYSIS: PreTradeAnalysisConfig = {
  enabled: true,
  minConfidence: 65,
  minEvPct: 1.0,
  autoSelectBestContract: true,
  requireConfluence: true,
  lossCooldownTicks: 2,
  maxConsecutiveLosses: 4,
  trailingProfitLockPct: 50,
};

export const DEFAULT_BOT_STRATEGY: BotStrategyConfig = {
  id: 'default-v25-digits',
  name: 'V25 Digit Frequency Guard',
  description:
    'Tracks live digit distribution, EMA/RSI confluence, and EV backtest on Volatility 25 before entering high-probability trades.',
  tradeParams: {
    marketGroup: 'Derived',
    subGroup: 'Continuous Indices',
    symbol: 'R_25',
    changeMarketOnRun: false,
    updateAnalysisOnCycle: false,
    fastTrades: false,
    tradeCategory: 'Digits',
    tradeType: 'Matches/Differs',
    contractType: 'DIGITDIFF',
    candleInterval: '1 minute',
    restartBuySellOnError: false,
    restartLastTradeOnError: true,
  },
  variables: [
    { id: 'v-1', name: 'tick_counter', value: 0 },
    { id: 'v-2', name: 'report_every', value: 10 },
    { id: 'v-3', name: 'max_digit_pct', value: 10 },
    { id: 'v-4', name: 'min_history', value: 900 },
    { id: 'v-5', name: 'stake', value: 10 },
  ],
  purchaseConditions: {
    mode: 'best_quant_edge',
    durationTicks: 1,
    durationUnit: 't',
    multiplier: 100,
    predictionDigit: 4,
    thresholdPct: 10,
    streakLength: 3,
  },
  preTradeAnalysis: DEFAULT_PRETRADE_ANALYSIS,
  sellConditions: {
    sellAtMarketOnProfit: false,
    profitTargetPct: 50,
  },
  restartConditions: {
    tradeAgain: true,
    useMartingale: true,
    martingaleMultiplier: 2.1,
    maxStake: 160,
    takeProfit: 50,
    stopLoss: 100,
    delayMs: 1200,
  },
};

export interface TickPoint {
  symbol: string;
  epoch: number;
  quote: number;
  formattedQuote: string;
  lastDigit: number;
}

export interface TradeTransaction {
  id: string;
  refId: string;
  timestamp: number;
  symbol: string;
  marketName: string;
  contractType: ContractTypeOption;
  barrier?: number;
  entrySpot: string;
  exitSpot: string;
  stake: number;
  payout: number;
  profit: number;
  status: 'won' | 'lost' | 'open';
  source: 'bot' | 'manual' | 'bulk' | 'hedge' | 'scanner';
}

export interface JournalEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface BotStats {
  totalStake: number;
  totalPayout: number;
  runs: number;
  contractsLost: number;
  contractsWon: number;
  totalProfitLoss: number;
}

export interface FeedStatus {
  connected: boolean;
  source: 'deriv-ws' | 'synthetic-replay';
  accountMode: 'demo' | 'real';
  authorizedLoginId: string | null;
  lastError: string | null;
}

export interface DerivAccountInfo {
  accountId: string;
  accountType: 'demo' | 'real';
  currency: string;
  balance: number;
  status: string;
  protocol: 'v1-pat' | 'v3-ws';
}

export interface DerivAuthSession {
  authenticated: boolean;
  sessionId?: string | null;
  appId: string;
  activeAccountId: string | null;
  activeAccountType: 'demo' | 'real' | null;
  balance: number | null;
  currency: string;
  email: string | null;
  fullname: string | null;
  accounts: DerivAccountInfo[];
}

export interface AiAnalysisResult {
  symbol: string;
  regime: string;
  biasSummary: string;
  recommendedTradeType: TradeSubType;
  recommendedContract: ContractTypeOption;
  targetDigit: number;
  confidenceNote: string;
  riskWarning: string;
  suggestedStake: number;
  suggestedDurationTicks: number;
  suggestedDurationUnit?: DurationUnit;
}

export interface AiScannerSignal {
  symbol: string;
  action: 'AUTO_EXECUTE' | 'HOLD';
  confidence_score: number;
  contract_type: ContractTypeOption;
  barrier: number;
  duration: number;
  duration_unit: DurationUnit;
  multiplier?: number;
  rationale: string;
  sampleSize1000?: number;
  markovEdgePct?: number;
  modelUsed?: string;
}

export type ChatRolePreset = 'architect' | 'dtrader' | 'scanner' | 'fast';

export interface GeminiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelUsed: string;
  createdAt: number;
}

export interface CloudChatSession {
  id: string;
  ownerId: string;
  title: string;
  rolePreset: ChatRolePreset;
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  activeSymbol: string;
  updatedAt?: number;
}

export interface CloudStrategyRecord {
  id: string;
  ownerId: string;
  name: string;
  description?: string;
  symbol: string;
  contractType: string;
  stake: number;
  takeProfit: number;
  stopLoss: number;
  config: BotStrategyConfig;
  updatedAt?: number;
}

export interface ScannerSessionLogRecord {
  id: string;
  ownerId: string;
  symbol: string;
  contractType: string;
  barrier: number;
  sampleSize: number;
  winRatePct: number;
  evPct: number;
  confidence: number;
  netPnl: number;
  wins: number;
  losses: number;
  rationale: string;
  createdAt?: number;
}

export interface MarketScanOpportunity {
  symbol: string;
  name: string;
  marketGroup: MarketGroup;
  subGroup: MarketSubGroup;
  latestPrice: number;
  pipSize: number;
  regime: string;
  trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rsi14: number;
  volatilityBps: number;
  tradeCategory: TradeCategory;
  tradeType: TradeSubType;
  contractType: ContractTypeOption;
  barrier: number;
  duration: number;
  durationUnit: DurationUnit;
  multiplier?: number;
  conditionMode: PurchaseConditionMode;
  strategyLabel: string;
  rationale: string;
  winRatePct: number;
  breakEvenPct: number;
  expectedValuePct: number;
  profitFactor: number;
  simulatedNetUsd: number;
  confidence: number;
  approved: boolean;
  reasons: string[];
  score: number;
  sampleSize: number;
}

export interface MarketScanResponse {
  scannedAt: number;
  totalScanned: number;
  bestOpportunity: MarketScanOpportunity | null;
  results: MarketScanOpportunity[];
}

export type ServerWsMessage =
  | {
      type: 'feed:status';
      status: FeedStatus;
    }
  | {
      type: 'history';
      symbol: string;
      ticks: TickPoint[];
    }
  | {
      type: 'tick';
      tick: TickPoint;
    };

export type ClientWsMessage = {
  type: 'subscribe';
  symbol: string;
};

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface AppToastInput {
  variant: ToastVariant;
  title: string;
  message: string;
  meta?: string;
  durationMs?: number;
  persistent?: boolean;
  dedupeKey?: string;
}

export interface AppToast extends AppToastInput {
  id: string;
  createdAt: number;
}

export interface DerivCandle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivContractSpec {
  contract_type: string;
  contract_display: string;
  contract_category: string;
  contract_category_display: string;
  min_contract_duration: string;
  max_contract_duration: string;
  barriers: number;
  barrier_category?: string;
  sentiment?: string;
  multiplier_range?: number[];
}

export interface DerivPortfolioItem {
  contract_id: string;
  symbol: string;
  contract_type: string;
  shortcode: string;
  buy_price: number;
  payout: number;
  bid_price?: number;
  profit?: number;
  current_spot?: number;
  entry_spot?: number;
  date_start: number;
  expiry_time?: number;
  currency: string;
}

export interface DerivProfitTableItem {
  contract_id: string;
  transaction_id: string;
  shortcode: string;
  contract_type?: string;
  underlying_symbol?: string;
  buy_price: number;
  sell_price: number;
  payout: number;
  profit: number;
  purchase_time: number;
  sell_time: number;
  longcode: string;
}

export interface DerivStatementItem {
  transaction_id: string;
  contract_id?: string;
  action_type: string;
  amount: number;
  balance_after: number;
  transaction_time: number;
  shortcode?: string;
  longcode?: string;
}

export interface DerivAccountProfile {
  accountId: string | null;
  accountType: 'demo' | 'real' | null;
  currency: string;
  limits: {
    lifetime_limit?: number;
    num_of_days?: number;
    num_of_days_limit?: number;
    open_positions?: number;
    payout?: number;
    remainder?: number;
    withdrawal_for_x_days_monetary?: number;
    withdrawal_since_inception_monetary?: number;
    market_specific?: Record<string, unknown>;
  } | null;
  settings: {
    email?: string;
    country?: string;
    country_code?: string;
    first_name?: string;
    last_name?: string;
    preferred_language?: string;
    account_opening_reason?: string;
    has_secret_answer?: number;
  } | null;
  status: {
    status?: string[];
    risk_classification?: string;
    currency_config?: Record<string, unknown>;
  } | null;
}

export interface DerivTradingTimesMarket {
  name: string;
  submarkets: {
    name: string;
    symbols: {
      symbol: string;
      name: string;
      events?: { dates: string; descrip: string }[];
      times?: { open: string[]; close: string[]; settlement: string };
      trading_days?: string[];
    }[];
  }[];
}

export interface DerivProposalQuote {
  id: string;
  ask_price: number;
  payout: number;
  spot: number;
  spot_time: number;
  longcode: string;
  impliedReturnPct: number;
  breakEvenPct: number;
}

export interface DerivServerStatus {
  appId: string;
  allowRealTrading: boolean;
  serverTime: number;
  siteStatus: string;
  currenciesConfigCount: number;
  payoutCurrencies: string[];
  feedStatus: FeedStatus;
}

