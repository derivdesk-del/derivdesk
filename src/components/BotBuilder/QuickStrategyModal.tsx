import { useState } from 'react';
import { X } from 'lucide-react';
import {
  DERIV_MARKETS,
  type BotStrategyConfig,
  type ContractTypeOption,
  type DurationUnit,
  type MarketSymbol,
  type PurchaseConditionMode,
  type TradeCategory,
  type TradeSubType,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface QuickStrategyModalProps {
  open: boolean;
  markets?: MarketSymbol[];
  currentStrategy: BotStrategyConfig;
  onClose: () => void;
  onApply: (next: BotStrategyConfig, runImmediately: boolean) => void;
}

const PRESETS = [
  {
    id: 'martingale-differs',
    label: 'Digit Differ Martingale',
    tradeCategory: 'Digits' as TradeCategory,
    tradeType: 'Matches/Differs' as TradeSubType,
    contractType: 'DIGITDIFF' as ContractTypeOption,
    mode: 'always' as PurchaseConditionMode,
    useMartingale: true,
    multiplier: 2.1,
    duration: 1,
    durationUnit: 't' as DurationUnit,
  },
  {
    id: 'even-odd-reversal',
    label: 'Even/Odd Streak Reversal',
    tradeCategory: 'Digits' as TradeCategory,
    tradeType: 'Even/Odd' as TradeSubType,
    contractType: 'DIGITEVEN' as ContractTypeOption,
    mode: 'odd_streak_gte' as PurchaseConditionMode,
    useMartingale: true,
    multiplier: 2.0,
    duration: 1,
    durationUnit: 't' as DurationUnit,
  },
  {
    id: 'ema-trend-rider',
    label: 'EMA(9/21) Trend Rider',
    tradeCategory: 'Up/Down' as TradeCategory,
    tradeType: 'Rise/Fall' as TradeSubType,
    contractType: 'CALL' as ContractTypeOption,
    mode: 'ema_bullish' as PurchaseConditionMode,
    useMartingale: false,
    multiplier: 1.5,
    duration: 5,
    durationUnit: 't' as DurationUnit,
  },
  {
    id: 'rsi-oversold-rebound',
    label: 'RSI(14) Oversold Rebound',
    tradeCategory: 'Up/Down' as TradeCategory,
    tradeType: 'Rise/Fall' as TradeSubType,
    contractType: 'CALL' as ContractTypeOption,
    mode: 'rsi_oversold' as PurchaseConditionMode,
    useMartingale: false,
    multiplier: 1.5,
    duration: 5,
    durationUnit: 't' as DurationUnit,
  },
];

export function QuickStrategyModal({
  open,
  markets = DERIV_MARKETS,
  currentStrategy,
  onClose,
  onApply,
}: QuickStrategyModalProps) {
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [symbol, setSymbol] = useState(currentStrategy.tradeParams.symbol);
  const [stake, setStake] = useState(
    currentStrategy.variables.find((v) => v.name === 'stake')?.value ?? 10,
  );
  const [takeProfit, setTakeProfit] = useState(
    currentStrategy.restartConditions.takeProfit,
  );
  const [stopLoss, setStopLoss] = useState(currentStrategy.restartConditions.stopLoss);
  const [predictionDigit, setPredictionDigit] = useState(
    currentStrategy.purchaseConditions.predictionDigit,
  );

  if (!open) return null;

  const selectedPreset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];

  const buildStrategy = (): BotStrategyConfig => {
    const marketMeta =
      markets.find((m) => m.symbol === symbol) ??
      DERIV_MARKETS.find((m) => m.symbol === symbol) ??
      markets[0] ??
      DERIV_MARKETS[1];

    let tradeCategory = selectedPreset.tradeCategory;
    let tradeType = selectedPreset.tradeType;
    let contractType = selectedPreset.contractType;
    let mode = selectedPreset.mode;
    let durationTicks = selectedPreset.duration;
    let durationUnit = selectedPreset.durationUnit;

    if (tradeCategory === 'Digits' && !marketMeta.supportsDigits) {
      if (marketMeta.supportsRiseFall !== false) {
        tradeCategory = 'Up/Down';
        tradeType = 'Rise/Fall';
        contractType = 'CALL';
        mode = 'ema_bullish';
        durationTicks = marketMeta.defaultDuration ?? 15;
        durationUnit = marketMeta.defaultDurationUnit ?? 'm';
      } else {
        tradeCategory = 'Multipliers';
        tradeType = 'Multipliers';
        contractType = 'MULTUP';
        mode = 'ema_bullish';
      }
    } else if (tradeCategory === 'Up/Down' && marketMeta.supportsRiseFall === false) {
      tradeCategory = 'Multipliers';
      tradeType = 'Multipliers';
      contractType = 'MULTUP';
    } else if (tradeCategory === 'Up/Down') {
      durationTicks = marketMeta.defaultDuration ?? selectedPreset.duration;
      durationUnit = marketMeta.defaultDurationUnit ?? 't';
    }

    return {
      ...currentStrategy,
      id: `quick-${selectedPreset.id}-${Date.now()}`,
      name: `${selectedPreset.label} (${symbol})`,
      tradeParams: {
        ...currentStrategy.tradeParams,
        marketGroup: marketMeta.marketGroup,
        subGroup: marketMeta.subGroup,
        symbol,
        tradeCategory,
        tradeType,
        contractType,
      },
      variables: currentStrategy.variables.map((v) =>
        v.name === 'stake' ? { ...v, value: stake } : v,
      ),
      purchaseConditions: {
        ...currentStrategy.purchaseConditions,
        durationTicks,
        durationUnit,
        predictionDigit,
        mode,
      },
      restartConditions: {
        ...currentStrategy.restartConditions,
        useMartingale: selectedPreset.useMartingale,
        martingaleMultiplier: selectedPreset.multiplier,
        takeProfit,
        stopLoss,
      },
    };
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
            Quick strategy
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Strategy template
            </label>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPresetId(p.id)}
                  className={`px-3 py-2.5 rounded-md border text-left font-medium transition-colors cursor-pointer ${
                    presetId === p.id
                      ? 'border-[#00A8E8] bg-sky-50 dark:bg-sky-950/40 text-sky-900 dark:text-sky-100 font-semibold'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Asset / Market
              </label>
              <MarketSelector
                markets={markets}
                value={symbol}
                onChange={setSymbol}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Initial Stake (USD)
              </label>
              <input
                type="number"
                min={0.35}
                step={0.5}
                value={stake}
                onChange={(e) => setStake(Math.max(0.35, Number(e.target.value) || 1))}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Take Profit (USD)
              </label>
              <input
                type="number"
                min={1}
                value={takeProfit}
                onChange={(e) => setTakeProfit(Math.max(1, Number(e.target.value) || 50))}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Stop Loss (USD)
              </label>
              <input
                type="number"
                min={1}
                value={stopLoss}
                onChange={(e) => setStopLoss(Math.max(1, Number(e.target.value) || 100))}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {selectedPreset.tradeCategory === 'Digits' && (
            <div>
              <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Target / Barrier Digit (0–9)
              </label>
              <div className="flex items-center gap-1.5">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setPredictionDigit(d)}
                    className={`w-8 h-8 rounded font-mono font-bold transition-colors cursor-pointer ${
                      predictionDigit === d
                        ? 'bg-[#0E5A78] text-white'
                        : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              onApply(buildStrategy(), false);
              onClose();
            }}
            className="px-4 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-100 cursor-pointer"
          >
            Edit in Builder
          </button>
          <button
            type="button"
            onClick={() => {
              onApply(buildStrategy(), true);
              onClose();
            }}
            className="px-4 py-2 rounded-md bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-bold cursor-pointer"
          >
            Load &amp; Run
          </button>
        </div>
      </div>
    </div>
  );
}
