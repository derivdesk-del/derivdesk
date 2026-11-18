import { useMemo, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { parseJsonResponse } from '../../lib/derivClient.ts';
import {
  generatePolyglotStrategyCode,
  POLYGLOT_LANGUAGES,
} from '../../lib/polyglotCodegen.ts';
import {
  DEFAULT_PRETRADE_ANALYSIS,
  DERIV_MARKETS,
  type BotStrategyConfig,
  type ContractTypeOption,
  type PolyglotLanguage,
  type PurchaseConditionMode,
  type TradeCategory,
  type TradeSubType,
} from '../../shared/types.ts';

interface AiBotBuilderModalProps {
  open: boolean;
  markets?: typeof DERIV_MARKETS;
  currentStrategy: BotStrategyConfig;
  onClose: () => void;
  onApply: (next: BotStrategyConfig, runImmediately?: boolean) => void;
}

interface GeneratedAiPayload {
  name: string;
  description: string;
  symbol: string;
  tradeCategory: TradeCategory;
  tradeType: TradeSubType;
  contractType: ContractTypeOption;
  stake: number;
  durationTicks: number;
  durationUnit?: 't' | 's' | 'm' | 'h' | 'd';
  multiplier?: number;
  predictionDigit: number;
  conditionMode: PurchaseConditionMode;
  thresholdPct?: number;
  streakLength?: number;
  dualZScoreThreshold?: number;
  minConfidence?: number;
  minEvPct?: number;
  minSlopeRatio?: number;
  rsiMin?: number;
  rsiMax?: number;
  bbMinPct?: number;
  bbMaxPct?: number;
  antiClusterTicks?: number;
  perfectConditionsOnly?: boolean;
  useMartingale: boolean;
  martingaleMultiplier: number;
  maxRecoverySteps?: number;
  useFractionalBalanceRisk?: boolean;
  baseRiskPct?: number;
  useDailyPctLocks?: boolean;
  dailyProfitTargetPct?: number;
  dailyMaxLossPct?: number;
  lossCooldownSeconds?: number;
  lockLosingDigitOnLoss?: boolean;
  takeProfit: number;
  stopLoss: number;
  reasoning: string;
}

const EXAMPLE_PROMPTS = [
  'Build a Dual-Z Binomial Digit Differ sniper on R_25 that only enters in perfect conditions (Z <= -1.6, 85% min confidence, +2.0% EV), 1.5% fractional balance risk, 2-step capped 2.1x recovery, 45s loss cooldown, +6% TP / -4% SL.',
  'Trade EUR/USD 15m Rise/Fall only when EMA(9)>EMA(21), RSI(14) between 45 and 64, Bollinger %B under 80%, slope ratio >= 0.7, $10 stake, $50 TP.',
  'Build a BTC/USD (cryBTCUSD) x100 Multiplier UP trend bot with strict momentum confluence (min confidence 84%, EV >= +2.0%), flat $15 stake, $60 TP.',
  'Design an Over 2 Digit Sniper on 1HZ50V that avoids clusters, caps recovery to 2 steps, and locks profit daily.',
];

export function AiBotBuilderModal({
  open,
  markets = DERIV_MARKETS,
  currentStrategy,
  onClose,
  onApply,
}: AiBotBuilderModalProps) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedAiPayload | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'code'>('summary');
  const [selectedLang, setSelectedLang] = useState<PolyglotLanguage>('typescript');
  const [copied, setCopied] = useState(false);

  const previewConfig: BotStrategyConfig | null = useMemo(() => {
    if (!generated) return null;
    const validMarket =
      markets.find((m) => m.symbol === generated.symbol) ??
      DERIV_MARKETS.find((m) => m.symbol === generated.symbol) ??
      markets[0] ??
      DERIV_MARKETS[1];
    const resolvedCategory: TradeCategory =
      generated.tradeCategory === 'Multipliers'
        ? 'Multipliers'
        : generated.tradeCategory === 'Up/Down'
          ? 'Up/Down'
          : 'Digits';

    const minConf = Math.min(95, Math.max(50, Number(generated.minConfidence) || 82));
    const minEv = Number.isFinite(Number(generated.minEvPct))
      ? Number(generated.minEvPct)
      : 1.8;

    return {
      ...currentStrategy,
      id: `ai-${Date.now()}`,
      name: generated.name || 'AI Quant Strategy',
      description: generated.description || prompt,
      tradeParams: {
        ...currentStrategy.tradeParams,
        marketGroup: validMarket.marketGroup,
        subGroup: validMarket.subGroup,
        symbol: validMarket.symbol,
        tradeCategory: resolvedCategory,
        tradeType: generated.tradeType || (resolvedCategory === 'Digits' ? 'Matches/Differs' : resolvedCategory === 'Multipliers' ? 'Multipliers' : 'Rise/Fall'),
        contractType: generated.contractType || 'DIGITDIFF',
      },
      variables: currentStrategy.variables.map((v) =>
        v.name === 'stake'
          ? { ...v, value: Math.max(0.35, Number(generated.stake) || 5) }
          : v,
      ),
      purchaseConditions: {
        ...currentStrategy.purchaseConditions,
        mode: generated.conditionMode || 'best_quant_edge',
        durationTicks: Math.max(1, Number(generated.durationTicks) || validMarket.defaultDuration || 1),
        durationUnit: generated.durationUnit || validMarket.defaultDurationUnit || 't',
        multiplier: generated.multiplier || 100,
        predictionDigit: Math.min(9, Math.max(0, Number(generated.predictionDigit) || 4)),
        thresholdPct: Number(generated.thresholdPct) || 10,
        streakLength: Number(generated.streakLength) || 3,
        dualZScoreThreshold:
          generated.dualZScoreThreshold !== undefined
            ? Number(generated.dualZScoreThreshold)
            : currentStrategy.purchaseConditions.dualZScoreThreshold ?? -1.6,
      },
      customQuantRule: {
        minConfidence: minConf,
        minEvPct: minEv,
        minSlopeRatio:
          generated.minSlopeRatio !== undefined && Number(generated.minSlopeRatio) > 0
            ? Number(generated.minSlopeRatio)
            : undefined,
        rsiMin:
          generated.rsiMin !== undefined && Number(generated.rsiMin) > 0
            ? Number(generated.rsiMin)
            : undefined,
        rsiMax:
          generated.rsiMax !== undefined && Number(generated.rsiMax) > 0
            ? Number(generated.rsiMax)
            : undefined,
        bbMinPct:
          generated.bbMinPct !== undefined && Number(generated.bbMinPct) >= 0
            ? Number(generated.bbMinPct)
            : undefined,
        bbMaxPct:
          generated.bbMaxPct !== undefined && Number(generated.bbMaxPct) > 0
            ? Number(generated.bbMaxPct)
            : undefined,
        dualZThreshold:
          generated.dualZScoreThreshold !== undefined
            ? Number(generated.dualZScoreThreshold)
            : undefined,
        antiClusterTicks:
          generated.antiClusterTicks !== undefined && Number(generated.antiClusterTicks) > 0
            ? Number(generated.antiClusterTicks)
            : undefined,
        perfectConditionsOnly: Boolean(generated.perfectConditionsOnly ?? true),
      },
      preTradeAnalysis: {
        ...DEFAULT_PRETRADE_ANALYSIS,
        ...currentStrategy.preTradeAnalysis,
        enabled: true,
        minConfidence: minConf,
        minEvPct: minEv,
        requireConfluence: true,
        autoSelectBestContract:
          generated.conditionMode === 'best_quant_edge' || generated.contractType === 'Both',
      },
      restartConditions: {
        ...currentStrategy.restartConditions,
        useMartingale: Boolean(generated.useMartingale),
        martingaleMultiplier: Math.max(1, Number(generated.martingaleMultiplier) || 2.1),
        maxRecoverySteps:
          generated.maxRecoverySteps !== undefined
            ? Math.max(0, Number(generated.maxRecoverySteps))
            : currentStrategy.restartConditions.maxRecoverySteps ?? 2,
        useFractionalBalanceRisk: Boolean(generated.useFractionalBalanceRisk),
        baseRiskPct:
          generated.baseRiskPct !== undefined
            ? Math.max(0.2, Number(generated.baseRiskPct))
            : currentStrategy.restartConditions.baseRiskPct ?? 1.5,
        useDailyPctLocks: Boolean(generated.useDailyPctLocks),
        dailyProfitTargetPct:
          generated.dailyProfitTargetPct !== undefined
            ? Math.max(0.5, Number(generated.dailyProfitTargetPct))
            : currentStrategy.restartConditions.dailyProfitTargetPct ?? 6,
        dailyMaxLossPct:
          generated.dailyMaxLossPct !== undefined
            ? Math.max(0.5, Number(generated.dailyMaxLossPct))
            : currentStrategy.restartConditions.dailyMaxLossPct ?? 4,
        lossCooldownSeconds:
          generated.lossCooldownSeconds !== undefined
            ? Math.max(0, Number(generated.lossCooldownSeconds))
            : currentStrategy.restartConditions.lossCooldownSeconds ?? 0,
        lockLosingDigitOnLoss: Boolean(generated.lockLosingDigitOnLoss),
        takeProfit: Math.max(1, Number(generated.takeProfit) || 50),
        stopLoss: Math.max(1, Number(generated.stopLoss) || 100),
      },
    };
  }, [currentStrategy, generated, markets, prompt]);

  const polyglotCode = useMemo(() => {
    if (!previewConfig) return '';
    return generatePolyglotStrategyCode(previewConfig, selectedLang);
  }, [previewConfig, selectedLang]);

  if (!open) return null;

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError(null);
    setGenerated(null);

    try {
      const res = await fetch('/api/ai/bot-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await parseJsonResponse<{
        strategy?: GeneratedAiPayload;
        error?: string;
      }>(res, 'Failed to generate bot strategy');
      if (!res.ok) {
        setError(data.error || 'Failed to generate bot strategy');
      } else {
        setGenerated(data.strategy as GeneratedAiPayload);
        setActiveTab('summary');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const applyGenerated = (runNow = false) => {
    if (!previewConfig) return;
    onApply(previewConfig, runNow);
    onClose();
  };

  const handleCopyCode = async () => {
    if (!polyglotCode) return;
    try {
      await navigator.clipboard.writeText(polyglotCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleDownloadCode = () => {
    if (!polyglotCode || !previewConfig) return;
    const meta = POLYGLOT_LANGUAGES.find((l) => l.id === selectedLang);
    const ext = meta?.extension ?? 'txt';
    const blob = new Blob([polyglotCode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${previewConfig.id}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h2 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
              AI Universal Quant Bot Builder &amp; Polyglot Compiler
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto studio-scroll p-5 space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Describe ANY strategy, indicator rules, recovery logic, or asset class
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., Build a high-win-rate R_25 Dual-Z Digit Differ sniper with 85% min confidence, RSI/Bollinger filter, 1.5% fractional stake, 2-step recovery, and 45s loss cooldown..."
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {EXAMPLE_PROMPTS.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPrompt(ex)}
                className="text-left px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer line-clamp-2"
              >
                {ex}
              </button>
            ))}
          </div>

          {error && (
            <div className="p-3 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

          {generated && previewConfig && (
            <div className="rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-white/70 dark:bg-slate-950/40">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                  <span className="font-bold text-slate-900 dark:text-slate-100">
                    {previewConfig.name}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {previewConfig.tradeParams.symbol} · {previewConfig.tradeParams.contractType} · {previewConfig.purchaseConditions.mode}
                  </span>
                </div>

                <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-0.5 rounded">
                  <button
                    type="button"
                    onClick={() => setActiveTab('summary')}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
                      activeTab === 'summary'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-500'
                    }`}
                  >
                    Quant Logic
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('code')}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
                      activeTab === 'code'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-500'
                    }`}
                  >
                    <Code2 className="w-3 h-3" />
                    <span>Polyglot Code (9 Langs)</span>
                  </button>
                </div>
              </div>

              {activeTab === 'summary' ? (
                <div className="p-4 space-y-3">
                  <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                    {generated.reasoning}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-200 dark:border-slate-800 font-mono text-[11px] tabular-nums">
                    <div>
                      <span className="text-slate-400 block font-sans text-[10px]">Base Sizing</span>
                      {previewConfig.restartConditions.useFractionalBalanceRisk
                        ? `${previewConfig.restartConditions.baseRiskPct}% Bal`
                        : `$${generated.stake} USD`}
                    </div>
                    <div>
                      <span className="text-slate-400 block font-sans text-[10px]">Confidence / EV</span>
                      &gt;={previewConfig.customQuantRule?.minConfidence}% · +{previewConfig.customQuantRule?.minEvPct}%
                    </div>
                    <div>
                      <span className="text-slate-400 block font-sans text-[10px]">Recovery</span>
                      {previewConfig.restartConditions.useMartingale
                        ? `${previewConfig.restartConditions.martingaleMultiplier}x (Max ${previewConfig.restartConditions.maxRecoverySteps} steps)`
                        : 'Flat Stake'}
                    </div>
                    <div>
                      <span className="text-slate-400 block font-sans text-[10px]">Session Locks</span>
                      +${generated.takeProfit} / -${generated.stopLoss}
                    </div>
                  </div>
                  {(previewConfig.customQuantRule?.rsiMin !== undefined ||
                    previewConfig.customQuantRule?.minSlopeRatio !== undefined ||
                    (previewConfig.restartConditions.lossCooldownSeconds ?? 0) > 0) && (
                    <div className="pt-2 border-t border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-600 dark:text-slate-300 flex flex-wrap gap-x-4 gap-y-1">
                      {previewConfig.customQuantRule?.perfectConditionsOnly && (
                        <span className="text-teal-700 dark:text-teal-400 font-semibold">
                          Mode: Perfect-Conditions-Only Gate
                        </span>
                      )}
                      {previewConfig.customQuantRule?.rsiMin !== undefined && (
                        <span>
                          RSI: {previewConfig.customQuantRule.rsiMin}–{previewConfig.customQuantRule.rsiMax ?? 70}
                        </span>
                      )}
                      {previewConfig.customQuantRule?.minSlopeRatio !== undefined && (
                        <span>Min Slope: {previewConfig.customQuantRule.minSlopeRatio} std</span>
                      )}
                      {(previewConfig.restartConditions.lossCooldownSeconds ?? 0) > 0 && (
                        <span>Cooldown: {previewConfig.restartConditions.lossCooldownSeconds}s</span>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {POLYGLOT_LANGUAGES.map((lang) => (
                        <button
                          key={lang.id}
                          type="button"
                          onClick={() => setSelectedLang(lang.id)}
                          className={`px-2 py-1 rounded text-[11px] font-mono font-semibold cursor-pointer ${
                            selectedLang === lang.id
                              ? 'bg-[#0E5A78] text-white'
                              : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {lang.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleCopyCode}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] font-semibold cursor-pointer"
                      >
                        {copied ? <Check className="w-3 h-3 text-teal-600" /> : <Copy className="w-3 h-3" />}
                        <span>{copied ? 'Copied' : 'Copy'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadCode}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] font-semibold cursor-pointer"
                      >
                        <Download className="w-3 h-3" />
                        <span>Download</span>
                      </button>
                    </div>
                  </div>
                  <pre className="max-h-64 overflow-auto studio-scroll rounded bg-slate-950 text-slate-100 p-3 font-mono text-[11px] leading-relaxed">
                    <code>{polyglotCode}</code>
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex flex-wrap items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading || !prompt.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer whitespace-nowrap"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>{loading ? 'Synthesizing...' : 'Generate Strategy Blocks'}</span>
          </button>

          {generated && (
            <>
              <button
                type="button"
                onClick={() => applyGenerated(false)}
                className="px-4 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 text-xs font-semibold cursor-pointer whitespace-nowrap"
              >
                Apply to Workspace
              </button>
              <button
                type="button"
                onClick={() => applyGenerated(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-bold cursor-pointer whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Apply &amp; Auto-Run</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
