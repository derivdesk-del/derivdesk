import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { AiBotBuilderModal } from './components/BotBuilder/AiBotBuilderModal.tsx';
import { BlocksSidebar } from './components/BotBuilder/BlocksSidebar.tsx';
import { QuickStrategyModal } from './components/BotBuilder/QuickStrategyModal.tsx';
import { RightTelemetryPanel } from './components/BotBuilder/RightTelemetryPanel.tsx';
import { StrategyCanvas } from './components/BotBuilder/StrategyCanvas.tsx';
import { DerivLoginModal } from './components/DerivLoginModal.tsx';
import { GeminiChatDrawer } from './components/GeminiChatDrawer.tsx';
import { NavTabs } from './components/NavTabs.tsx';
import { StatusFooter } from './components/StatusFooter.tsx';
import { ToastViewport } from './components/ToastViewport.tsx';
import { TopBar } from './components/TopBar.tsx';
import { AiAutoAnalysisView } from './components/Views/AiAutoAnalysisView.tsx';
import { AnalysisToolView } from './components/Views/AnalysisToolView.tsx';
import { BulkTraderView } from './components/Views/BulkTraderView.tsx';
import { DashboardView } from './components/Views/DashboardView.tsx';
import { DerivServicesView } from './components/Views/DerivServicesView.tsx';
import { DtraderCirclesView } from './components/Views/DtraderCirclesView.tsx';
import { FreebotsView } from './components/Views/FreebotsView.tsx';
import { HedgingBeastView } from './components/Views/HedgingBeastView.tsx';
import { ThreeQuantFieldView } from './components/Views/ThreeQuantFieldView.tsx';
import { TradingViewPanel } from './components/Views/TradingViewPanel.tsx';
import { useBotEngine } from './hooks/useBotEngine.ts';
import { useDerivMarket } from './hooks/useDerivMarket.ts';
import { useToasts } from './hooks/useToasts.ts';
import {
  derivFetch,
  extractDerivOAuthAccountsFromUrl,
  parseJsonResponse,
  setDerivSessionId,
  syncDerivSession,
} from './lib/derivClient.ts';
import {
  DERIV_MARKETS,
  type BotStrategyConfig,
  type ContractTypeOption,
  type DerivAuthSession,
  type MainTabId,
  type PurchaseConditionMode,
  type RightTabId,
  type TradeCategory,
  type TradeSubType,
} from './shared/types.ts';

const INITIAL_DERIV_SESSION: DerivAuthSession = {
  authenticated: false,
  appId: '34RXuPGgdUNCTWhsYjRcD',
  activeAccountId: null,
  activeAccountType: null,
  balance: null,
  currency: 'USD',
  email: null,
  fullname: null,
  accounts: [],
};

export default function App() {
  const [activeTab, setActiveTab] = useState<MainTabId>('bot-builder');
  const [rightTab, setRightTab] = useState<RightTabId>('summary');
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [focusedBlock, setFocusedBlock] = useState<string | null>(null);
  const [quickStrategyOpen, setQuickStrategyOpen] = useState(false);
  const [aiBuilderOpen, setAiBuilderOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);

  const [derivSession, setDerivSession] =
    useState<DerivAuthSession>(INITIAL_DERIV_SESSION);
  const sessionVersionRef = useRef(0);
  const { toasts, notify, dismissToast, clearToasts } = useToasts();

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);

  // Fetch existing server-side Deriv session on mount & complete OAuth redirect if ?acct1=...&token1=... present
  useEffect(() => {
    let active = true;
    const loadSession = async () => {
      const startVersion = sessionVersionRef.current;
      try {
        const oauthAccounts = extractDerivOAuthAccountsFromUrl(window.location.search);
        if (oauthAccounts.length > 0) {
          const cbRes = await derivFetch('/api/deriv/oauth-callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accounts: oauthAccounts }),
          });
          window.history.replaceState({}, '', window.location.pathname);
          if (cbRes.ok && active) {
            const cbPayload = await parseJsonResponse<DerivAuthSession>(cbRes);
            const cbSession = syncDerivSession(cbPayload);
            sessionVersionRef.current += 1;
            setDerivSession(cbSession);
            notify({
              variant: 'success',
              title: 'Deriv OAuth Connected',
              message: `Signed in across ${cbSession.accounts.length} Deriv account${cbSession.accounts.length > 1 ? 's' : ''}.`,
              meta: `Active: ${cbSession.activeAccountId || 'Deriv'} · ${(cbSession.balance ?? 0).toFixed(2)} ${cbSession.currency}`,
              durationMs: 6000,
            });
            return;
          }
        }

        const res = await derivFetch('/api/deriv/session');
        if (res.ok && active && startVersion === sessionVersionRef.current) {
          const data = syncDerivSession(await parseJsonResponse<DerivAuthSession>(res));
          setDerivSession(data);
        }
      } catch {
        // Keep current session on transient network failure
      }
    };
    loadSession();
    const poll = window.setInterval(loadSession, 15000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [notify]);

  const [subscribedSymbol, setSubscribedSymbol] = useState<string>('R_25');
  const { markets, ticks, latestTick, previousTick, feedStatus, computeDigitStats } =
    useDerivMarket(subscribedSymbol);

  const handleSyncRemoteBalance = useCallback((nextBalance: number) => {
    setDerivSession((prev) => ({
      ...prev,
      balance: nextBalance,
      accounts: prev.accounts.map((a) =>
        a.accountId === prev.activeAccountId ? { ...a, balance: nextBalance } : a,
      ),
    }));
  }, []);

  const handleRequireLogin = useCallback(() => {
    setLoginModalOpen(true);
  }, []);

  const {
    strategy,
    updateStrategy,
    undoStrategy,
    redoStrategy,
    canUndo,
    canRedo,
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
    executeManualTrade,
    sellContract,
  } = useBotEngine(
    ticks,
    latestTick,
    derivSession,
    handleSyncRemoteBalance,
    handleRequireLogin,
    markets,
    notify,
  );

  const activeSymbol = strategy.tradeParams.symbol;

  useEffect(() => {
    setSubscribedSymbol(activeSymbol);
  }, [activeSymbol]);

  const activeSymbolMeta =
    markets.find((m) => m.symbol === activeSymbol) ??
    DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
    markets[0] ??
    DERIV_MARKETS[1];

  const handleSelectMarket = useCallback(
    (sym: string) => {
      const meta =
        markets.find((m) => m.symbol === sym) ??
        DERIV_MARKETS.find((m) => m.symbol === sym);
      updateStrategy((prev) => {
        let nextCategory: TradeCategory = prev.tradeParams.tradeCategory;
        let nextTradeType: TradeSubType = prev.tradeParams.tradeType;
        let nextContract: ContractTypeOption = prev.tradeParams.contractType;
        let nextDuration = prev.purchaseConditions.durationTicks;
        let nextUnit = prev.purchaseConditions.durationUnit ?? 't';

        if (meta) {
          if (nextCategory === 'Digits' && meta.supportsDigits === false) {
            if (meta.supportsRiseFall !== false) {
              nextCategory = 'Up/Down';
              nextTradeType = 'Rise/Fall';
              nextContract = 'CALL';
              nextDuration = meta.defaultDuration ?? 15;
              nextUnit = meta.defaultDurationUnit ?? 'm';
            } else {
              nextCategory = 'Multipliers';
              nextTradeType = 'Multipliers';
              nextContract = 'MULTUP';
            }
          } else if (nextCategory === 'Up/Down' && meta.supportsRiseFall === false) {
            nextCategory = 'Multipliers';
            nextTradeType = 'Multipliers';
            nextContract = 'MULTUP';
          } else if (nextCategory === 'Multipliers' && meta.supportsMultipliers === false) {
            nextCategory = meta.supportsDigits ? 'Digits' : 'Up/Down';
            nextTradeType = nextCategory === 'Digits' ? 'Matches/Differs' : 'Rise/Fall';
            nextContract = nextCategory === 'Digits' ? 'DIGITDIFF' : 'CALL';
            nextDuration = meta.defaultDuration ?? 15;
            nextUnit = meta.defaultDurationUnit ?? 'm';
          } else if (nextCategory === 'Up/Down') {
            nextDuration = meta.defaultDuration ?? nextDuration;
            nextUnit = meta.defaultDurationUnit ?? nextUnit;
          }
        }

        return {
          ...prev,
          tradeParams: {
            ...prev.tradeParams,
            marketGroup: meta?.marketGroup ?? prev.tradeParams.marketGroup,
            subGroup: meta?.subGroup ?? prev.tradeParams.subGroup,
            symbol: sym,
            tradeCategory: nextCategory,
            tradeType: nextTradeType,
            contractType: nextContract,
          },
          purchaseConditions: {
            ...prev.purchaseConditions,
            durationTicks: nextDuration,
            durationUnit: nextUnit,
          },
        };
      });
    },
    [markets, updateStrategy],
  );

  const handleFocusBlock = useCallback((blockId: string) => {
    setFocusedBlock(blockId);
    const el = document.getElementById(blockId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setFocusedBlock(null), 1600);
  }, []);

  const handleSidebarAction = useCallback(
    (action: string) => {
      if (action.startsWith('mode:')) {
        const mode = action.replace('mode:', '') as PurchaseConditionMode;
        updateStrategy((prev) => ({
          ...prev,
          purchaseConditions: {
            ...prev.purchaseConditions,
            mode,
          },
        }));
        handleFocusBlock('block-purchase');
      } else if (action === 'add:variable') {
        updateStrategy((prev) => ({
          ...prev,
          variables: [
            ...prev.variables,
            {
              id: `v-${Date.now()}`,
              name: `signal_limit_${prev.variables.length + 1}`,
              value: 5,
            },
          ],
        }));
        handleFocusBlock('block-run-once');
      } else if (action === 'preset:martingale') {
        updateStrategy((prev) => ({
          ...prev,
          restartConditions: {
            ...prev.restartConditions,
            useMartingale: true,
            martingaleMultiplier: 2.1,
          },
        }));
        handleFocusBlock('block-restart');
      } else if (action === 'preset:flat') {
        updateStrategy((prev) => ({
          ...prev,
          restartConditions: {
            ...prev.restartConditions,
            useMartingale: false,
          },
        }));
        handleFocusBlock('block-restart');
      } else if (action === 'toggle:fastTrades') {
        updateStrategy((prev) => ({
          ...prev,
          tradeParams: {
            ...prev.tradeParams,
            fastTrades: !prev.tradeParams.fastTrades,
          },
        }));
        handleFocusBlock('block-trade-params');
      } else if (action === 'upload:xml') {
        const input = document.getElementById('bot-xml-file-input') as HTMLInputElement | null;
        input?.click();
      }
    },
    [handleFocusBlock, updateStrategy],
  );

  const handleApplyStrategy = useCallback(
    (next: BotStrategyConfig, runImmediately: boolean) => {
      updateStrategy(next);
      setActiveTab('bot-builder');
      if (runImmediately && !isRunning) {
        window.setTimeout(() => toggleRun(), 50);
      }
    },
    [isRunning, toggleRun, updateStrategy],
  );

  const handleOpenReports = useCallback(() => {
    setActiveTab('bot-builder');
    setRightPanelCollapsed(false);
    setRightTab('transactions');
  }, []);

  const handleResetDemoBalance = useCallback(async () => {
    if (!derivSession.authenticated) {
      setLoginModalOpen(true);
      return;
    }
    try {
      const res = await derivFetch('/api/deriv/reset-demo', { method: 'POST' });
      if (res.ok) {
        const next = syncDerivSession(await parseJsonResponse<DerivAuthSession>(res));
        setDerivSession(next);
      }
    } catch {
      // Ignore transient error
    }
  }, [derivSession.authenticated]);

  const handleLoginSuccess = useCallback((session: DerivAuthSession) => {
    sessionVersionRef.current += 1;
    setDerivSession(syncDerivSession(session));
  }, []);

  const handleLogout = useCallback(async () => {
    sessionVersionRef.current += 1;
    try {
      const res = await derivFetch('/api/deriv/logout', { method: 'POST' });
      setDerivSessionId(null);
      if (res.ok) {
        const next = syncDerivSession(await parseJsonResponse<DerivAuthSession>(res));
        setDerivSession(next);
      } else {
        setDerivSession(INITIAL_DERIV_SESSION);
      }
    } catch {
      setDerivSessionId(null);
      setDerivSession(INITIAL_DERIV_SESSION);
    }
  }, []);

  const handleSwitchAccount = useCallback(async (accountId: string) => {
    sessionVersionRef.current += 1;
    try {
      const res = await derivFetch('/api/deriv/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId }),
      });
      if (res.ok) {
        const next = syncDerivSession(await parseJsonResponse<DerivAuthSession>(res));
        setDerivSession(next);
      }
    } catch {
      // Ignore
    }
  }, []);

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden bg-slate-50 dark:bg-[#090D16] text-slate-900 dark:text-slate-100">
      <TopBar
        latestTick={latestTick}
        previousTick={previousTick}
        activeSymbolName={activeSymbolMeta.name}
        balance={balance}
        currency={derivSession.currency}
        isRunning={isRunning}
        statusMessage={statusMessage}
        derivSession={derivSession}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((o) => !o)}
        onToggleRun={toggleRun}
        onOpenReports={handleOpenReports}
        onResetDemoBalance={handleResetDemoBalance}
        onOpenLogin={() => setLoginModalOpen(true)}
        onLogout={handleLogout}
        onSwitchAccount={handleSwitchAccount}
      />

      <NavTabs activeTab={activeTab} onSelectTab={setActiveTab} />

      <main className="flex-1 min-h-0 flex overflow-hidden relative">
        {activeTab === 'bot-builder' && (
          <>
            <BlocksSidebar
              strategy={strategy}
              onFocusBlock={handleFocusBlock}
              onQuickAction={handleSidebarAction}
              onOpenQuickStrategy={() => setQuickStrategyOpen(true)}
              onOpenAiBuilder={() => setAiBuilderOpen(true)}
            />

            <StrategyCanvas
              strategy={strategy}
              markets={markets}
              ticks={ticks}
              canUndo={canUndo}
              canRedo={canRedo}
              focusedBlock={focusedBlock}
              isRunning={isRunning}
              onUpdateStrategy={updateStrategy}
              onUndo={undoStrategy}
              onRedo={redoStrategy}
              onOpenQuickStrategy={() => setQuickStrategyOpen(true)}
              onToggleRun={toggleRun}
            />

            <button
              type="button"
              onClick={() => setRightPanelCollapsed((c) => !c)}
              title={rightPanelCollapsed ? 'Expand telemetry panel' : 'Collapse telemetry panel'}
              aria-label={
                rightPanelCollapsed ? 'Expand telemetry panel' : 'Collapse telemetry panel'
              }
              className="w-4 shrink-0 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 border-l border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-500 cursor-pointer"
            >
              {rightPanelCollapsed ? (
                <ChevronLeft className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>

            {!rightPanelCollapsed && (
              <RightTelemetryPanel
                activeTab={rightTab}
                onSelectTab={setRightTab}
                stats={stats}
                transactions={transactions}
                journal={journal}
                isRunning={isRunning}
                latestTick={latestTick}
                latestVerdict={latestVerdict}
                authenticated={derivSession.authenticated}
                currency={derivSession.currency}
                lastError={lastError}
                onOpenLogin={() => setLoginModalOpen(true)}
                onSellContract={sellContract}
                onReset={resetResults}
              />
            )}
          </>
        )}

        {activeTab === 'dashboard' && (
          <DashboardView
            balance={balance}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            stats={stats}
            activeSymbol={activeSymbol}
            markets={markets}
            latestTick={latestTick}
            transactions={transactions}
            onSelectMarket={handleSelectMarket}
            onNavigateTab={setActiveTab}
            onOpenLogin={() => setLoginModalOpen(true)}
          />
        )}

        {activeTab === 'bulk-trader' && (
          <BulkTraderView
            activeSymbol={activeSymbol}
            markets={markets}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            latestTick={latestTick}
            transactions={transactions}
            onRequireLogin={handleRequireLogin}
            onSelectMarket={handleSelectMarket}
            onNotify={notify}
            onPlaceTrade={executeManualTrade}
          />
        )}

        {activeTab === 'freebots' && (
          <FreebotsView onLoadStrategy={handleApplyStrategy} />
        )}

        {activeTab === 'dtrader-circles' && (
          <DtraderCirclesView
            activeSymbol={activeSymbol}
            markets={markets}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            ticks={ticks}
            latestTick={latestTick}
            transactions={transactions}
            computeDigitStats={computeDigitStats}
            onSelectMarket={handleSelectMarket}
            onRequireLogin={handleRequireLogin}
            onNotify={notify}
            onPlaceTrade={executeManualTrade}
          />
        )}

        {activeTab === 'hedging-beast' && (
          <HedgingBeastView
            activeSymbol={activeSymbol}
            markets={markets}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            ticks={ticks}
            latestTick={latestTick}
            transactions={transactions}
            onSelectMarket={handleSelectMarket}
            onRequireLogin={handleRequireLogin}
            onNotify={notify}
            onPlaceTrade={executeManualTrade}
          />
        )}

        {activeTab === 'ai-analysis' && (
          <AiAutoAnalysisView
            activeSymbol={activeSymbol}
            markets={markets}
            ticks={ticks}
            currentStrategy={strategy}
            balance={balance}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            transactions={transactions}
            appId={derivSession.appId}
            onRequireLogin={handleRequireLogin}
            onNotify={notify}
            onPlaceTrade={executeManualTrade}
            onSelectMarket={handleSelectMarket}
            onApplyRecommended={(next, runNow) =>
              handleApplyStrategy(next, Boolean(runNow))
            }
          />
        )}

        {activeTab === 'trading-view' && (
          <TradingViewPanel
            activeSymbol={activeSymbol}
            markets={markets}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            ticks={ticks}
            latestTick={latestTick}
            transactions={transactions}
            onSelectMarket={handleSelectMarket}
            onRequireLogin={handleRequireLogin}
            onNotify={notify}
            onPlaceTrade={executeManualTrade}
          />
        )}

        {activeTab === 'analysis-tool' && (
          <AnalysisToolView
            activeSymbol={activeSymbol}
            markets={markets}
            ticks={ticks}
            computeDigitStats={computeDigitStats}
            currentStrategy={strategy}
            authenticated={derivSession.authenticated}
            currency={derivSession.currency}
            transactions={transactions}
            onRequireLogin={handleRequireLogin}
            onSelectMarket={handleSelectMarket}
            onApplyStrategy={handleApplyStrategy}
            onNotify={notify}
            onPlaceTrade={executeManualTrade}
          />
        )}

        {activeTab === 'quant-3d' && (
          <ThreeQuantFieldView
            activeSymbol={activeSymbol}
            markets={markets}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            ticks={ticks}
            latestTick={latestTick}
            computeDigitStats={computeDigitStats}
            onSelectMarket={handleSelectMarket}
            onRequireLogin={handleRequireLogin}
            onPlaceTrade={executeManualTrade}
          />
        )}

        {activeTab === 'deriv-services' && (
          <DerivServicesView
            activeSymbol={activeSymbol}
            markets={markets}
            currency={derivSession.currency}
            authenticated={derivSession.authenticated}
            onSelectMarket={handleSelectMarket}
            onOpenLogin={() => setLoginModalOpen(true)}
            onSellContract={sellContract}
          />
        )}
      </main>

      <GeminiChatDrawer
        open={chatOpen}
        activeSymbol={activeSymbol}
        onClose={() => setChatOpen(false)}
      />

      <StatusFooter
        feedStatus={feedStatus}
        activeSymbol={activeSymbol}
        isDark={isDark}
        onToggleTheme={() => setIsDark((d) => !d)}
      />

      <ToastViewport
        toasts={toasts}
        onDismiss={dismissToast}
        onClearAll={clearToasts}
      />

      <QuickStrategyModal
        open={quickStrategyOpen}
        markets={markets}
        currentStrategy={strategy}
        onClose={() => setQuickStrategyOpen(false)}
        onApply={handleApplyStrategy}
      />

      <AiBotBuilderModal
        open={aiBuilderOpen}
        markets={markets}
        currentStrategy={strategy}
        onClose={() => setAiBuilderOpen(false)}
        onApply={(next, runNow) => handleApplyStrategy(next, Boolean(runNow))}
      />

      <DerivLoginModal
        open={loginModalOpen}
        appId={derivSession.appId}
        onClose={() => setLoginModalOpen(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  );
}
