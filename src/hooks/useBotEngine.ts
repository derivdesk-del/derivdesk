import { useCallback, useEffect, useRef, useState } from 'react';
import { derivFetch, parseJsonResponse } from '../lib/derivClient.ts';
import {
  computeEmaSeries,
  computeRsi,
  evaluatePreTradeGate,
} from '../lib/marketAnalysis.ts';
import {
  DEFAULT_BOT_STRATEGY,
  DEFAULT_PRETRADE_ANALYSIS,
  DERIV_MARKETS,
  type AppToastInput,
  type BotStats,
  type BotStrategyConfig,
  type ContractTypeOption,
  type DerivAuthSession,
  type DurationUnit,
  type JournalEntry,
  type MarketSymbol,
  type PreTradeSignalVerdict,
  type TickPoint,
  type TradeTransaction,
} from '../shared/types.ts';

export function getPayoutMultiplier(contractType: ContractTypeOption, barrier: number): number {
  switch (contractType) {
    case 'DIGITMATCH':
      return 8.85;
    case 'DIGITDIFF':
      return 1.095;
    case 'DIGITEVEN':
    case 'DIGITODD':
    case 'CALL':
    case 'PUT':
      return 1.95;
    case 'DIGITOVER': {
      const wins = Math.max(1, 9 - barrier);
      return Number(((10 / wins) * 0.94).toFixed(3));
    }
    case 'DIGITUNDER': {
      const wins = Math.max(1, barrier);
      return Number(((10 / wins) * 0.94).toFixed(3));
    }
    default:
      return 1.95;
  }
}

export function useBotEngine(
  ticks: TickPoint[],
  latestTick: TickPoint | null,
  derivSession: DerivAuthSession,
  onSyncRemoteBalance: (balance: number) => void,
  onRequireLogin: () => void,
  markets: MarketSymbol[] = DERIV_MARKETS,
  onNotify?: (toast: AppToastInput) => void,
) {
  const [strategy, setStrategyState] = useState<BotStrategyConfig>(DEFAULT_BOT_STRATEGY);
  const [undoStack, setUndoStack] = useState<BotStrategyConfig[]>([]);
  const [redoStack, setRedoStack] = useState<BotStrategyConfig[]>([]);

  const balance = derivSession.authenticated ? derivSession.balance : null;

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('Bot is not running');
  const [lastError, setLastError] = useState<string | null>(null);
  const [latestVerdict, setLatestVerdict] = useState<PreTradeSignalVerdict | null>(null);
  const [transactions, setTransactions] = useState<TradeTransaction[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [stats, setStats] = useState<BotStats>({
    totalStake: 0,
    totalPayout: 0,
    runs: 0,
    contractsLost: 0,
    contractsWon: 0,
    totalProfitLoss: 0,
  });

  const currentStakeRef = useRef<number>(10);
  const sessionPnlRef = useRef<number>(0);
  const peakSessionPnlRef = useRef<number>(0);
  const consecutiveLossesRef = useRef<number>(0);
  const cooldownTicksLeftRef = useRef<number>(0);
  const cooldownUntilRef = useRef<number>(0);
  const sessionInitialBalanceRef = useRef<number>(100);
  const lastProcessedEpochRef = useRef<number>(0);
  const lastTradeTimeRef = useRef<number>(0);
  const remoteTradePendingRef = useRef<boolean>(false);
  const lockedLosingDigitRef = useRef<number | null>(null);
  const lastTriggeredDigitRef = useRef<number | null>(null);
  const lastTradeBarrierRef = useRef<number>(4);
  const ticksSinceLastTradeRef = useRef<number>(0);
  const settledIdsRef = useRef<Set<string>>(new Set());
  const pollLockRef = useRef<boolean>(false);
  const transactionsRef = useRef<TradeTransaction[]>([]);

  useEffect(() => {
    transactionsRef.current = transactions;
  }, [transactions]);

  const appendJournal = useCallback(
    (level: JournalEntry['level'], message: string) => {
      setJournal((prev) => [
        {
          id: `j-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          level,
          message,
        },
        ...prev.slice(0, 199),
      ]);
    },
    [],
  );

  const updateStrategy = useCallback(
    (updater: BotStrategyConfig | ((prev: BotStrategyConfig) => BotStrategyConfig)) => {
      setStrategyState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        setUndoStack((u) => [...u.slice(-24), prev]);
        setRedoStack([]);
        return next;
      });
    },
    [],
  );

  const undoStrategy = useCallback(() => {
    setUndoStack((u) => {
      if (u.length === 0) return u;
      const previous = u[u.length - 1];
      setStrategyState((curr) => {
        setRedoStack((r) => [...r, curr]);
        return previous;
      });
      return u.slice(0, -1);
    });
  }, []);

  const redoStrategy = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const next = r[r.length - 1];
      setStrategyState((curr) => {
        setUndoStack((u) => [...u, curr]);
        return next;
      });
      return r.slice(0, -1);
    });
  }, []);

  const getBaseStake = useCallback(
    (cfg: BotStrategyConfig) => {
      if (
        cfg.restartConditions.useFractionalBalanceRisk &&
        (cfg.restartConditions.baseRiskPct ?? 0) > 0
      ) {
        const refBal =
          derivSession.authenticated && typeof derivSession.balance === 'number' && derivSession.balance > 0
            ? derivSession.balance
            : sessionInitialBalanceRef.current;
        const pct = Math.min(25, Math.max(0.1, Number(cfg.restartConditions.baseRiskPct) || 1.5));
        return Math.max(0.35, Number(((refBal * pct) / 100).toFixed(2)));
      }
      const stakeVar = cfg.variables.find((v) => v.name === 'stake');
      return Math.max(0.35, Number(stakeVar?.value ?? 10));
    },
    [derivSession.authenticated, derivSession.balance],
  );

  const applyPostTradeManagement = useCallback(
    (source: TradeTransaction['source'], won: boolean, profit: number) => {
      sessionPnlRef.current = Number((sessionPnlRef.current + profit).toFixed(2));
      if (sessionPnlRef.current > peakSessionPnlRef.current) {
        peakSessionPnlRef.current = sessionPnlRef.current;
      }
      if (source !== 'bot') return;

      const preCfg = {
        ...DEFAULT_PRETRADE_ANALYSIS,
        ...strategy.preTradeAnalysis,
      };
      const base = getBaseStake(strategy);
      const maxSteps = strategy.restartConditions.maxRecoverySteps ?? 0;

      if (won) {
        currentStakeRef.current = base;
        consecutiveLossesRef.current = 0;
        cooldownTicksLeftRef.current = 0;
        cooldownUntilRef.current = 0;
        lockedLosingDigitRef.current = null;
      } else {
        consecutiveLossesRef.current += 1;
        if (strategy.restartConditions.lockLosingDigitOnLoss) {
          lockedLosingDigitRef.current = lastTradeBarrierRef.current;
          appendJournal(
            'warning',
            `Losing-digit lock engaged: targeting digit ${lastTradeBarrierRef.current} for recovery stage ${consecutiveLossesRef.current}.`,
          );
        }
        if (
          preCfg.enabled &&
          preCfg.lossCooldownTicks > 0 &&
          strategy.purchaseConditions.mode !== 'dual_zscore_digit'
        ) {
          cooldownTicksLeftRef.current = preCfg.lossCooldownTicks;
        }
        if ((strategy.restartConditions.lossCooldownSeconds ?? 0) > 0) {
          const secs = Math.max(1, Number(strategy.restartConditions.lossCooldownSeconds));
          cooldownUntilRef.current = Date.now() + secs * 1000;
          appendJournal(
            'warning',
            `Post-loss cooldown engaged for ${secs}s before next entry evaluation.`,
          );
        }

        if (maxSteps > 0 && consecutiveLossesRef.current > maxSteps) {
          consecutiveLossesRef.current = 0;
          currentStakeRef.current = base;
          appendJournal(
            'warning',
            `Recovery step cap (${maxSteps}) reached — hard reset stake to $${base.toFixed(2)} to protect capital.`,
          );
        } else if (strategy.restartConditions.useMartingale) {
          const lossNum = consecutiveLossesRef.current;
          const mult =
            lossNum === 1 &&
            strategy.restartConditions.stage2Multiplier &&
            strategy.restartConditions.stage2Multiplier > 1
              ? strategy.restartConditions.stage2Multiplier
              : lossNum >= 2 &&
                  strategy.restartConditions.stage3Multiplier &&
                  strategy.restartConditions.stage3Multiplier > 1
                ? strategy.restartConditions.stage3Multiplier
                : strategy.restartConditions.martingaleMultiplier;

          const nextStake = Number((currentStakeRef.current * mult).toFixed(2));
          currentStakeRef.current = Math.min(nextStake, strategy.restartConditions.maxStake);
        }
      }

      if (strategy.restartConditions.capStakeToRemainingStopLoss) {
        const riskLeft = Math.abs(strategy.restartConditions.stopLoss) + sessionPnlRef.current;
        if (currentStakeRef.current > riskLeft) {
          currentStakeRef.current = Math.max(0, Math.round(riskLeft * 100) / 100);
        }
      }

      // 0. Daily Percentage Session Locks (when enabled)
      if (strategy.restartConditions.useDailyPctLocks) {
        const initBal = Math.max(10, sessionInitialBalanceRef.current);
        const tpPct = Math.max(0.5, Number(strategy.restartConditions.dailyProfitTargetPct) || 6);
        const slPct = Math.max(0.5, Number(strategy.restartConditions.dailyMaxLossPct) || 4);
        const pctProfitTarget = Number(((initBal * tpPct) / 100).toFixed(2));
        const pctMaxLoss = -Number(((initBal * slPct) / 100).toFixed(2));

        if (sessionPnlRef.current >= pctProfitTarget) {
          setIsRunning(false);
          setStatusMessage(`+${tpPct}% daily target locked`);
          appendJournal(
            'success',
            `Daily +${tpPct}% profit target locked ($${sessionPnlRef.current.toFixed(2)} >= +$${pctProfitTarget.toFixed(2)}). Bot stopped.`,
          );
          onNotify?.({
            variant: 'success',
            title: `Daily +${tpPct}% Target Reached`,
            message: `"${strategy.name}" locked daily profits automatically.`,
            meta: `Session P/L +${sessionPnlRef.current.toFixed(2)} ${derivSession.currency} >= +${pctProfitTarget.toFixed(2)}`,
            durationMs: 7500,
          });
          return;
        }
        if (sessionPnlRef.current <= pctMaxLoss) {
          setIsRunning(false);
          setStatusMessage(`-${slPct}% daily loss lock`);
          appendJournal(
            'error',
            `Daily -${slPct}% loss lock triggered ($${sessionPnlRef.current.toFixed(2)} <= $${pctMaxLoss.toFixed(2)}). Bot stopped.`,
          );
          onNotify?.({
            variant: 'error',
            title: `Daily -${slPct}% Max Loss Hit`,
            message: `"${strategy.name}" halted to enforce daily drawdown lock.`,
            meta: `Session P/L ${sessionPnlRef.current.toFixed(2)} ${derivSession.currency} <= ${pctMaxLoss.toFixed(2)}`,
            persistent: true,
          });
          return;
        }
      }

      // 1. Take Profit target reached
      if (sessionPnlRef.current >= strategy.restartConditions.takeProfit) {
        setIsRunning(false);
        setStatusMessage('Target profit reached');
        appendJournal(
          'success',
          `Take Profit reached ($${sessionPnlRef.current.toFixed(2)} >= $${strategy.restartConditions.takeProfit}). Bot stopped.`,
        );
        onNotify?.({
          variant: 'success',
          title: 'Take Profit Target Reached',
          message: `"${strategy.name}" stopped after hitting your profit target.`,
          meta: `Session P/L +${sessionPnlRef.current.toFixed(2)} ${derivSession.currency} >= +${strategy.restartConditions.takeProfit.toFixed(2)}`,
          durationMs: 7500,
        });
        return;
      }

      // 2. Trailing Profit Lock guard
      if (
        preCfg.enabled &&
        preCfg.trailingProfitLockPct > 0 &&
        peakSessionPnlRef.current >= strategy.restartConditions.takeProfit * 0.5
      ) {
        const profitFloor = Number(
          (peakSessionPnlRef.current * (preCfg.trailingProfitLockPct / 100)).toFixed(2),
        );
        if (sessionPnlRef.current <= profitFloor) {
          setIsRunning(false);
          setStatusMessage('Trailing profit locked');
          appendJournal(
            'success',
            `Trailing profit lock triggered ($${sessionPnlRef.current.toFixed(2)} protected from peak $${peakSessionPnlRef.current.toFixed(2)}). Bot stopped.`,
          );
          onNotify?.({
            variant: 'success',
            title: 'Trailing Profit Locked',
            message: `"${strategy.name}" stopped to lock gains from session peak.`,
            meta: `Locked ${sessionPnlRef.current >= 0 ? '+' : ''}${sessionPnlRef.current.toFixed(2)} ${derivSession.currency} (Peak +${peakSessionPnlRef.current.toFixed(2)})`,
            durationMs: 7500,
          });
          return;
        }
      }

      // 3. Max Consecutive Losses Circuit Breaker
      if (
        preCfg.enabled &&
        preCfg.maxConsecutiveLosses > 0 &&
        consecutiveLossesRef.current >= preCfg.maxConsecutiveLosses
      ) {
        setIsRunning(false);
        setStatusMessage('Drawdown guard paused bot');
        appendJournal(
          'warning',
          `Circuit breaker: paused after ${consecutiveLossesRef.current} consecutive losses to protect capital.`,
        );
        onNotify?.({
          variant: 'error',
          title: 'Loss Streak Threshold Hit',
          message: `Circuit breaker paused "${strategy.name}" after ${consecutiveLossesRef.current} consecutive losses.`,
          meta: `Streak ${consecutiveLossesRef.current}/${preCfg.maxConsecutiveLosses} · Session P/L ${sessionPnlRef.current >= 0 ? '+' : ''}${sessionPnlRef.current.toFixed(2)} ${derivSession.currency}`,
          persistent: true,
        });
        return;
      }

      // 4. Stop Loss triggered
      if (sessionPnlRef.current <= -Math.abs(strategy.restartConditions.stopLoss)) {
        setIsRunning(false);
        setStatusMessage('Stop loss reached');
        appendJournal(
          'error',
          `Stop Loss triggered ($${sessionPnlRef.current.toFixed(2)} <= -$${strategy.restartConditions.stopLoss}). Bot stopped.`,
        );
        onNotify?.({
          variant: 'error',
          title: 'Stop Loss Threshold Hit',
          message: `"${strategy.name}" stopped automatically after reaching stop loss.`,
          meta: `Session P/L ${sessionPnlRef.current.toFixed(2)} ${derivSession.currency} <= -${Math.abs(strategy.restartConditions.stopLoss).toFixed(2)}`,
          persistent: true,
        });
        return;
      }

      // 5. Remaining Stop-Loss budget below minimum Deriv stake ($0.35)
      if (
        strategy.restartConditions.capStakeToRemainingStopLoss &&
        currentStakeRef.current < 0.35
      ) {
        setIsRunning(false);
        setStatusMessage('Risk budget below min stake');
        appendJournal(
          'warning',
          `Remaining stop-loss risk budget ($${currentStakeRef.current.toFixed(2)}) is below $0.35 minimum stake. Bot stopped.`,
        );
        onNotify?.({
          variant: 'warning',
          title: 'Risk Budget Exhausted',
          message: `"${strategy.name}" stopped because remaining stop-loss budget fell below $0.35.`,
          meta: `Session P/L ${sessionPnlRef.current.toFixed(2)} ${derivSession.currency}`,
          durationMs: 7000,
        });
        return;
      }

      // 6. Early drawdown warning when >= 75% of Stop Loss has been consumed
      const absStopLoss = Math.abs(strategy.restartConditions.stopLoss);
      if (!won && absStopLoss > 0 && sessionPnlRef.current <= -(absStopLoss * 0.75)) {
        onNotify?.({
          variant: 'warning',
          title: 'Approaching Stop Loss Limit',
          message: `Session drawdown has reached ${Math.min(99, Math.round((Math.abs(sessionPnlRef.current) / absStopLoss) * 100))}% of your stop loss threshold.`,
          meta: `Session P/L ${sessionPnlRef.current.toFixed(2)} / -${absStopLoss.toFixed(2)} ${derivSession.currency}`,
          dedupeKey: 'bot-sl-approaching',
          durationMs: 7000,
        });
      }

      if (!strategy.restartConditions.tradeAgain) {
        setIsRunning(false);
        setStatusMessage('Single run complete');
      }
    },
    [appendJournal, derivSession.currency, getBaseStake, onNotify, strategy],
  );

  const openContract = useCallback(
    (params: {
      symbol: string;
      contractType: ContractTypeOption;
      barrier: number;
      stake: number;
      durationTicks: number;
      durationUnit?: DurationUnit;
      multiplier?: number;
      limitOrder?: { takeProfit?: number; stopLoss?: number };
      source: TradeTransaction['source'];
    }) => {
      if (!derivSession.authenticated) {
        appendJournal(
          'warning',
          'Sign in with your Deriv API token to execute trades on your Deriv account.',
        );
        setIsRunning(false);
        setStatusMessage('Sign in required');
        onRequireLogin();
        return false;
      }

      const currentBal = derivSession.balance ?? 0;
      if (params.stake > currentBal) {
        const msg = `Insufficient Deriv balance (${currentBal.toFixed(2)} ${derivSession.currency}) for ${params.stake.toFixed(2)} stake.`;
        appendJournal('error', msg);
        setLastError(msg);
        setIsRunning(false);
        setStatusMessage('Stopped: Insufficient balance');
        onNotify?.({
          variant: 'error',
          title: 'Insufficient Balance',
          message: msg,
          meta: `${params.symbol} · Required ${params.stake.toFixed(2)} ${derivSession.currency}`,
          durationMs: 8000,
        });
        return false;
      }
      setLastError(null);

      const resolvedType: ContractTypeOption =
        params.contractType === 'Both' ? 'DIGITDIFF' : params.contractType;
      const marketName =
        markets.find((m) => m.symbol === params.symbol)?.name ?? params.symbol;
      const id = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      if (params.source === 'bot') {
        remoteTradePendingRef.current = true;
      }
      const tempRef = `pending-${Math.floor(100000 + Math.random() * 899999)}`;
      setTransactions((prev) => [
        {
          id,
          refId: tempRef,
          timestamp: Date.now(),
          symbol: params.symbol,
          marketName,
          contractType: resolvedType,
          barrier: params.barrier,
          entrySpot: latestTick?.formattedQuote ?? '—',
          exitSpot: '—',
          stake: params.stake,
          payout: 0,
          profit: -params.stake,
          status: 'open',
          source: params.source,
        },
        ...prev,
      ]);
      const durLabel =
        resolvedType === 'MULTUP' || resolvedType === 'MULTDOWN'
          ? `x${params.multiplier || 100}`
          : `${params.durationTicks}${params.durationUnit || 't'}`;
      appendJournal(
        'info',
        `Sending ${resolvedType} (${params.symbol} · ${durLabel}) to Deriv (${derivSession.activeAccountId}) | Stake ${params.stake.toFixed(2)} ${derivSession.currency}`,
      );
      if (params.source === 'bot') {
        const barrierSuffix = resolvedType.startsWith('DIGIT')
          ? ` [${params.barrier}]`
          : '';
        onNotify?.({
          variant: 'info',
          title: 'Bot Executed Trade',
          message: `${resolvedType}${barrierSuffix} placed on ${marketName}.`,
          meta: `${params.symbol} · ${durLabel} · Stake ${params.stake.toFixed(2)} ${derivSession.currency}`,
          durationMs: 3800,
        });
      }

      derivFetch('/api/deriv/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: params.symbol,
          contractType: resolvedType,
          barrier: params.barrier,
          stake: params.stake,
          durationTicks: params.durationTicks,
          durationUnit: params.durationUnit || 't',
          multiplier: params.multiplier,
          limitOrder: params.limitOrder,
        }),
      })
        .then(async (res) => {
          const data = await parseJsonResponse<{
            error?: string;
            contractId?: string;
            entrySpot?: string;
            exitSpot?: string;
            payout?: number;
            profit?: number;
            won?: boolean;
            status?: 'won' | 'lost' | 'open';
            balance?: number;
          }>(res, 'Deriv trade rejected');
          if (!res.ok) {
            throw new Error(data.error || 'Deriv trade rejected');
          }
          return data as {
            contractId: string;
            entrySpot: string;
            exitSpot: string;
            payout: number;
            profit: number;
            won: boolean;
            status: 'won' | 'lost' | 'open';
            balance: number;
          };
        })
        .then((outcome) => {
          onSyncRemoteBalance(outcome.balance);
          if (outcome.status === 'open') {
            setTransactions((prev) =>
              prev.map((tx) =>
                tx.id === id
                  ? {
                      ...tx,
                      refId: outcome.contractId,
                      entrySpot: outcome.entrySpot,
                      exitSpot: 'OPEN',
                      status: 'open',
                    }
                  : tx,
              ),
            );
            appendJournal(
              'info',
              `OPEN #${outcome.contractId} (${resolvedType} · ${params.symbol}) active on Deriv.`,
            );
            if (params.source === 'bot') {
              setIsRunning(false);
              setStatusMessage('Open contract active');
              onNotify?.({
                variant: 'info',
                title: 'Bot Contract Opened',
                message: `Contract #${outcome.contractId} is active on ${marketName}.`,
                meta: `${params.symbol} · ${resolvedType} · Entry ${outcome.entrySpot}`,
                durationMs: 4500,
              });
            }
            return;
          }

          settledIdsRef.current.add(outcome.contractId);
          setStats((s) => ({
            totalStake: Number((s.totalStake + params.stake).toFixed(2)),
            totalPayout: Number((s.totalPayout + outcome.payout).toFixed(2)),
            runs: s.runs + 1,
            contractsWon: s.contractsWon + (outcome.won ? 1 : 0),
            contractsLost: s.contractsLost + (outcome.won ? 0 : 1),
            totalProfitLoss: Number((s.totalProfitLoss + outcome.profit).toFixed(2)),
          }));
          setTransactions((prev) =>
            prev.map((tx) =>
              tx.id === id
                ? {
                    ...tx,
                    refId: outcome.contractId,
                    entrySpot: outcome.entrySpot,
                    exitSpot: outcome.exitSpot,
                    payout: outcome.payout,
                    profit: outcome.profit,
                    status: outcome.won ? 'won' : 'lost',
                  }
                : tx,
            ),
          );
          appendJournal(
            outcome.won ? 'success' : 'warning',
            `${outcome.won ? 'WON' : 'LOST'} #${outcome.contractId} (${resolvedType}) | P/L ${outcome.profit >= 0 ? '+' : ''}${outcome.profit.toFixed(2)} ${derivSession.currency}`,
          );
          const pnlText = `${outcome.profit >= 0 ? '+' : ''}${outcome.profit.toFixed(2)} ${derivSession.currency}`;
          const sourcePrefix =
            params.source === 'bot'
              ? 'Bot'
              : params.source === 'scanner'
                ? 'Scanner'
                : params.source === 'bulk'
                  ? 'Bulk'
                  : params.source === 'hedge'
                    ? 'Hedge'
                    : 'Trade';
          onNotify?.({
            variant: outcome.won ? 'success' : 'warning',
            title: outcome.won ? `${sourcePrefix} Trade Won` : `${sourcePrefix} Trade Lost`,
            message: `${resolvedType} on ${marketName} settled (${pnlText}).`,
            meta: `#${outcome.contractId} · ${params.symbol} · Stake ${params.stake.toFixed(2)} ${derivSession.currency}`,
            durationMs: outcome.won ? 4000 : 5500,
          });
          applyPostTradeManagement(params.source, outcome.won, outcome.profit);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : 'Deriv trade failed';
          setTransactions((prev) => prev.filter((tx) => tx.id !== id));
          setLastError(message);
          appendJournal('error', message);
          onNotify?.({
            variant: 'error',
            title: 'Trade Rejected',
            message,
            meta: `${params.symbol} · ${resolvedType} · Stake ${params.stake.toFixed(2)} ${derivSession.currency}`,
            durationMs: 7500,
          });
          if (params.source === 'bot') {
            setIsRunning(false);
            setStatusMessage(
              message.length > 36 ? `${message.slice(0, 33)}...` : message,
            );
          }
        })
        .finally(() => {
          if (params.source === 'bot') {
            remoteTradePendingRef.current = false;
          }
        });

      return true;
    },
    [
      appendJournal,
      applyPostTradeManagement,
      derivSession.activeAccountId,
      derivSession.authenticated,
      derivSession.balance,
      derivSession.currency,
      latestTick,
      markets,
      onNotify,
      onRequireLogin,
      onSyncRemoteBalance,
    ],
  );

  const sellContract = useCallback(
    async (contractId: string) => {
      try {
        const res = await derivFetch('/api/deriv/sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contractId }),
        });
        const data = await parseJsonResponse<{
          error?: string;
          soldFor?: number;
          balance?: number;
        }>(res, 'Could not close contract');
        if (!res.ok) {
          throw new Error(data.error || 'Could not close contract');
        }
        const soldFor = Number(data.soldFor ?? 0);
        const targetTx = transactionsRef.current.find(
          (t) => t.refId === contractId && t.status === 'open',
        );
        settledIdsRef.current.add(contractId);
        onSyncRemoteBalance(Number(data.balance ?? derivSession.balance ?? 0));
        if (targetTx) {
          const profit = Number((soldFor - targetTx.stake).toFixed(2));
          const won = profit > 0;
          setStats((s) => ({
            totalStake: Number((s.totalStake + targetTx.stake).toFixed(2)),
            totalPayout: Number((s.totalPayout + soldFor).toFixed(2)),
            runs: s.runs + 1,
            contractsWon: s.contractsWon + (won ? 1 : 0),
            contractsLost: s.contractsLost + (won ? 0 : 1),
            totalProfitLoss: Number((s.totalProfitLoss + profit).toFixed(2)),
          }));
        }
        setTransactions((prev) =>
          prev.map((tx) => {
            if (tx.refId !== contractId || tx.status !== 'open') return tx;
            const profit = Number((soldFor - tx.stake).toFixed(2));
            const won = profit > 0;
            return {
              ...tx,
              exitSpot: 'SOLD',
              payout: soldFor,
              profit,
              status: won ? 'won' : 'lost',
            };
          }),
        );
        appendJournal('info', `Closed contract #${contractId} at market.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Sell failed';
        setLastError(msg);
        appendJournal('error', msg);
      }
    },
    [appendJournal, derivSession.balance, onSyncRemoteBalance],
  );

  // Automatic settlement poller for open longer-duration or Multiplier contracts
  useEffect(() => {
    if (!derivSession.authenticated) return;
    const hasOpenRealContracts = transactions.some(
      (t) => t.status === 'open' && /^\d+$/.test(t.refId) && !settledIdsRef.current.has(t.refId),
    );
    if (!hasOpenRealContracts) return;

    const timer = window.setInterval(async () => {
      if (pollLockRef.current) return;
      const openList = transactionsRef.current.filter(
        (t) => t.status === 'open' && /^\d+$/.test(t.refId) && !settledIdsRef.current.has(t.refId),
      );
      if (openList.length === 0) return;

      pollLockRef.current = true;
      try {
        for (const tx of openList.slice(0, 6)) {
          const res = await derivFetch(`/api/deriv/contract/${encodeURIComponent(tx.refId)}`);
          if (!res.ok) continue;
          const data = await parseJsonResponse<{
            contractId: string;
            isSold: boolean;
            won: boolean;
            entrySpot: string;
            exitSpot: string;
            payout: number;
            profit: number;
            balance: number;
          }>(res);
          if (!data.isSold || settledIdsRef.current.has(tx.refId)) continue;

          settledIdsRef.current.add(tx.refId);
          onSyncRemoteBalance(Number(data.balance ?? derivSession.balance ?? 0));

          setTransactions((prev) =>
            prev.map((item) =>
              item.refId === tx.refId && item.status === 'open'
                ? {
                    ...item,
                    entrySpot: data.entrySpot !== '—' ? data.entrySpot : item.entrySpot,
                    exitSpot: data.exitSpot,
                    payout: data.payout,
                    profit: data.profit,
                    status: data.won ? 'won' : 'lost',
                  }
                : item,
            ),
          );

          setStats((s) => ({
            totalStake: Number((s.totalStake + tx.stake).toFixed(2)),
            totalPayout: Number((s.totalPayout + data.payout).toFixed(2)),
            runs: s.runs + 1,
            contractsWon: s.contractsWon + (data.won ? 1 : 0),
            contractsLost: s.contractsLost + (data.won ? 0 : 1),
            totalProfitLoss: Number((s.totalProfitLoss + data.profit).toFixed(2)),
          }));

          appendJournal(
            data.won ? 'success' : 'warning',
            `${data.won ? 'WON' : 'LOST'} #${tx.refId} (${tx.contractType}) | P/L ${data.profit >= 0 ? '+' : ''}${data.profit.toFixed(2)} ${derivSession.currency}`,
          );
          onNotify?.({
            variant: data.won ? 'success' : 'warning',
            title: data.won ? 'Open Contract Won' : 'Open Contract Closed',
            message: `${tx.contractType} on ${tx.marketName} settled (${data.profit >= 0 ? '+' : ''}${data.profit.toFixed(2)} ${derivSession.currency}).`,
            meta: `#${tx.refId} · ${tx.symbol}`,
            durationMs: 5000,
          });
          applyPostTradeManagement(tx.source, data.won, data.profit);
        }
      } catch {
        // Ignore transient poll errors
      } finally {
        pollLockRef.current = false;
      }
    }, 4500);

    return () => window.clearInterval(timer);
  }, [
    appendJournal,
    applyPostTradeManagement,
    derivSession.authenticated,
    derivSession.balance,
    derivSession.currency,
    onNotify,
    onSyncRemoteBalance,
    transactions,
  ]);

  // Automated bot tick evaluation loop with Best Pre-Trade Analysis Gate
  useEffect(() => {
    if (!latestTick) return;
    if (latestTick.epoch === lastProcessedEpochRef.current && ticks.length > 1) {
      return;
    }
    lastProcessedEpochRef.current = latestTick.epoch;

    const activeMarketMeta =
      markets.find((m) => m.symbol === strategy.tradeParams.symbol) ??
      DERIV_MARKETS.find((m) => m.symbol === strategy.tradeParams.symbol) ??
      markets[0] ??
      DERIV_MARKETS[1];

    const preCfg = {
      ...DEFAULT_PRETRADE_ANALYSIS,
      ...strategy.preTradeAnalysis,
    };

    if (cooldownTicksLeftRef.current > 0) {
      cooldownTicksLeftRef.current -= 1;
    }

    if (isRunning && !remoteTradePendingRef.current) {
      ticksSinceLastTradeRef.current += 1;
    }

    // Always compute live pre-trade quant verdict so telemetry panel stays updated
    const verdict = evaluatePreTradeGate(
      ticks,
      activeMarketMeta,
      strategy,
      currentStakeRef.current,
      cooldownTicksLeftRef.current,
      {
        lossStreak: consecutiveLossesRef.current,
        lockedLosingDigit: lockedLosingDigitRef.current,
        lastTriggeredDigit: lastTriggeredDigitRef.current,
        ticksSinceLastTrade: ticksSinceLastTradeRef.current,
      },
    );
    setLatestVerdict(verdict);

    if (!isRunning) return;
    if (!derivSession.authenticated) {
      setIsRunning(false);
      setStatusMessage('Sign in required');
      return;
    }

    if (remoteTradePendingRef.current) {
      setStatusMessage('Contract in progress...');
      return;
    }

    const now = Date.now();
    if (cooldownUntilRef.current > now) {
      const secsLeft = Math.ceil((cooldownUntilRef.current - now) / 1000);
      setStatusMessage(`Loss cooldown: ${secsLeft}s`);
      return;
    }

    const minDelay = strategy.tradeParams.fastTrades ? 400 : strategy.restartConditions.delayMs;
    if (
      strategy.purchaseConditions.mode !== 'dual_zscore_digit' &&
      now - lastTradeTimeRef.current < minDelay
    ) {
      return;
    }

    const {
      mode,
      predictionDigit,
      thresholdPct,
      streakLength,
      durationTicks,
      durationUnit,
      multiplier,
    } = strategy.purchaseConditions;
    let shouldEnter = false;
    const sample = ticks.slice(-100);

    if (mode === 'best_quant_edge') {
      shouldEnter = verdict.approved;
      if (!shouldEnter) {
        setStatusMessage(
          verdict.cooldownRemaining > 0
            ? `Cooldown: ${verdict.cooldownRemaining}t`
            : `Analyzing: ${verdict.confidence}% conf (EV ${verdict.expectedValuePct}%)`,
        );
      }
    } else if (mode === 'dual_zscore_digit') {
      shouldEnter = verdict.approved;
      if (!shouldEnter) {
        const zStr =
          verdict.bestZScore !== undefined ? `Z=${verdict.bestZScore.toFixed(2)}` : 'Scanning';
        setStatusMessage(
          verdict.lockedLosingDigit !== null && verdict.lockedLosingDigit !== undefined
            ? `Recovery Digit ${verdict.lockedLosingDigit} (${ticksSinceLastTradeRef.current}/${verdict.activeGapTicks ?? 10}t)`
            : `${zStr} · Digit ${verdict.recommendedBarrier} (${ticksSinceLastTradeRef.current}/${verdict.activeGapTicks ?? 10}t)`,
        );
      }
    } else if (mode === 'always') {
      shouldEnter = true;
    } else if (mode === 'digit_pct_lte' || mode === 'digit_pct_gte') {
      const count = sample.filter((t) => t.lastDigit === predictionDigit).length;
      const pct = sample.length > 0 ? (count / sample.length) * 100 : 10;
      shouldEnter = mode === 'digit_pct_lte' ? pct <= thresholdPct : pct >= thresholdPct;
      if (!shouldEnter) {
        setStatusMessage(`Scanning digit ${predictionDigit} (${pct.toFixed(1)}%)`);
      }
    } else if (mode === 'even_streak_gte' || mode === 'odd_streak_gte') {
      const tail = ticks.slice(-streakLength);
      if (tail.length === streakLength) {
        shouldEnter =
          mode === 'even_streak_gte'
            ? tail.every((t) => t.lastDigit % 2 === 0)
            : tail.every((t) => t.lastDigit % 2 !== 0);
      }
      if (!shouldEnter) {
        setStatusMessage(`Waiting for ${streakLength}x parity streak`);
      }
    } else if (mode === 'trend_up' || mode === 'trend_down') {
      const tail = ticks.slice(-4);
      if (tail.length >= 4) {
        const diff = tail[tail.length - 1].quote - tail[0].quote;
        shouldEnter = mode === 'trend_up' ? diff > 0 : diff < 0;
      }
      if (!shouldEnter) {
        setStatusMessage('Waiting for directional momentum');
      }
    } else if (mode === 'ema_bullish' || mode === 'ema_bearish') {
      const prices = ticks.slice(-40).map((t) => t.quote);
      if (prices.length >= 22) {
        const ema9 = computeEmaSeries(prices, 9);
        const ema21 = computeEmaSeries(prices, 21);
        const e9 = ema9[ema9.length - 1];
        const e21 = ema21[ema21.length - 1];
        shouldEnter = mode === 'ema_bullish' ? e9 > e21 : e9 < e21;
      }
      if (!shouldEnter) {
        setStatusMessage(
          mode === 'ema_bullish' ? 'Waiting for EMA(9)>EMA(21)' : 'Waiting for EMA(9)<EMA(21)',
        );
      }
    } else if (mode === 'rsi_oversold' || mode === 'rsi_overbought') {
      const prices = ticks.slice(-30).map((t) => t.quote);
      if (prices.length >= 16) {
        const rsi = computeRsi(prices, 14);
        shouldEnter = mode === 'rsi_oversold' ? rsi <= 34 : rsi >= 66;
        if (!shouldEnter) {
          setStatusMessage(`Scanning RSI(14) = ${rsi}`);
        }
      }
    }

    // Apply mandatory Pre-Trade Analysis Gate if enabled on non-quant modes too
    if (
      shouldEnter &&
      preCfg.enabled &&
      mode !== 'best_quant_edge' &&
      mode !== 'dual_zscore_digit'
    ) {
      if (!verdict.approved) {
        shouldEnter = false;
        setStatusMessage(
          verdict.cooldownRemaining > 0
            ? `Cooldown: ${verdict.cooldownRemaining}t`
            : `Pre-trade gate: ${verdict.confidence}% < ${preCfg.minConfidence}%`,
        );
      }
    }

    if (shouldEnter) {
      lastTradeTimeRef.current = now;
      ticksSinceLastTradeRef.current = 0;
      setStatusMessage('Bot is running');

      const useQuantSelection =
        mode === 'dual_zscore_digit' ||
        ((mode === 'best_quant_edge' || preCfg.enabled) &&
          (preCfg.autoSelectBestContract || strategy.tradeParams.contractType === 'Both'));

      const chosenContract =
        mode === 'dual_zscore_digit'
          ? strategy.tradeParams.contractType === 'Both'
            ? verdict.recommendedContract
            : strategy.tradeParams.contractType
          : useQuantSelection
            ? verdict.recommendedContract
            : strategy.tradeParams.contractType === 'Both'
              ? 'DIGITDIFF'
              : strategy.tradeParams.contractType;
      const chosenBarrier = useQuantSelection
        ? verdict.recommendedBarrier
        : predictionDigit;

      lastTriggeredDigitRef.current = chosenBarrier;
      lastTradeBarrierRef.current = chosenBarrier;

      if (mode === 'dual_zscore_digit') {
        appendJournal(
          'info',
          `Dual-Z Gate Triggered (Z=${(verdict.bestZScore ?? 0).toFixed(2)} · Hits=${verdict.recentDigitHits ?? 0}) → ${chosenContract} [${chosenBarrier}] | Stake $${currentStakeRef.current.toFixed(2)}`,
        );
      } else if (mode === 'best_quant_edge' || preCfg.enabled) {
        appendJournal(
          'info',
          `Pre-Trade Edge Approved (${verdict.confidence}% conf · EV ${verdict.expectedValuePct >= 0 ? '+' : ''}${verdict.expectedValuePct}%) → ${chosenContract}${chosenContract.startsWith('DIGIT') ? ` [${chosenBarrier}]` : ''}: ${verdict.reasons[0] || verdict.regime}`,
        );
      }

      openContract({
        symbol: strategy.tradeParams.symbol,
        contractType: chosenContract,
        barrier: chosenBarrier,
        stake: currentStakeRef.current,
        durationTicks,
        durationUnit: durationUnit || 't',
        multiplier: multiplier || 100,
        source: 'bot',
      });
    }
  }, [latestTick, ticks, markets, isRunning, derivSession.authenticated, strategy, openContract, appendJournal]);

  const toggleRun = useCallback(() => {
    if (isRunning) {
      setIsRunning(false);
      setStatusMessage('Bot stopped by user');
      appendJournal('info', 'Bot execution paused.');
      return;
    }
    if (!derivSession.authenticated) {
      appendJournal('warning', 'Please log in with your Deriv API token before running the bot.');
      onRequireLogin();
      return;
    }

    sessionInitialBalanceRef.current = Math.max(10, derivSession.balance ?? 100);
    currentStakeRef.current = getBaseStake(strategy);
    sessionPnlRef.current = 0;
    peakSessionPnlRef.current = 0;
    consecutiveLossesRef.current = 0;
    cooldownTicksLeftRef.current = 0;
    cooldownUntilRef.current = 0;
    lockedLosingDigitRef.current = null;
    lastTriggeredDigitRef.current = null;
    lastTradeBarrierRef.current = strategy.purchaseConditions.predictionDigit ?? 4;
    ticksSinceLastTradeRef.current = 0;
    lastTradeTimeRef.current = 0;
    lastProcessedEpochRef.current = 0;
    setLastError(null);
    setIsRunning(true);
    setStatusMessage('Bot is running');
    appendJournal(
      'info',
      `Started "${strategy.name}" on ${strategy.tradeParams.symbol} (${derivSession.activeAccountId}) | Base Stake $${currentStakeRef.current.toFixed(2)} | Gate: ${strategy.preTradeAnalysis?.enabled !== false ? 'ON' : 'OFF'}`,
    );
  }, [
    appendJournal,
    derivSession.activeAccountId,
    derivSession.authenticated,
    derivSession.balance,
    getBaseStake,
    isRunning,
    onRequireLogin,
    strategy,
  ]);

  const resetResults = useCallback(() => {
    setTransactions([]);
    setJournal([]);
    setLastError(null);
    setStats({
      totalStake: 0,
      totalPayout: 0,
      runs: 0,
      contractsLost: 0,
      contractsWon: 0,
      totalProfitLoss: 0,
    });
    sessionInitialBalanceRef.current = Math.max(10, derivSession.balance ?? 100);
    sessionPnlRef.current = 0;
    peakSessionPnlRef.current = 0;
    consecutiveLossesRef.current = 0;
    cooldownTicksLeftRef.current = 0;
    cooldownUntilRef.current = 0;
    lockedLosingDigitRef.current = null;
    lastTriggeredDigitRef.current = null;
    ticksSinceLastTradeRef.current = 0;
    currentStakeRef.current = getBaseStake(strategy);
    appendJournal('info', 'Session statistics and ledger cleared.');
  }, [appendJournal, derivSession.balance, getBaseStake, strategy]);

  return {
    strategy,
    updateStrategy,
    undoStrategy,
    redoStrategy,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    balance,
    isRunning,
    statusMessage,
    lastError,
    latestVerdict,
    transactions,
    journal,
    stats,
    toggleRun,
    resetResults,
    executeManualTrade: openContract,
    sellContract,
  };
}
