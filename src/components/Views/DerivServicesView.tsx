import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  Clock,
  DollarSign,
  FileSpreadsheet,
  Globe,
  Loader2,
  LogIn,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { derivFetch, parseJsonResponse } from '../../lib/derivClient.ts';
import {
  DERIV_MARKETS,
  type DerivAccountProfile,
  type DerivContractSpec,
  type DerivPortfolioItem,
  type DerivProfitTableItem,
  type DerivServerStatus,
  type DerivStatementItem,
  type DerivTradingTimesMarket,
  type MarketSymbol,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface DerivServicesViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  currency?: string;
  authenticated: boolean;
  onSelectMarket: (symbol: string) => void;
  onOpenLogin: () => void;
  onSellContract: (contractId: string) => Promise<void> | void;
}

type ServiceTabId = 'portfolio' | 'profit-table' | 'statement' | 'contracts-times' | 'limits-rates';

const SERVICE_TABS: { id: ServiceTabId; label: string; icon: typeof Briefcase }[] = [
  { id: 'portfolio', label: 'Open Portfolio', icon: Briefcase },
  { id: 'profit-table', label: 'Profit Table', icon: FileSpreadsheet },
  { id: 'statement', label: 'Statement Ledger', icon: ReceiptText },
  { id: 'contracts-times', label: 'Contracts & Market Hours', icon: Clock },
  { id: 'limits-rates', label: 'Account Limits, Status & FX', icon: Globe },
];

export function DerivServicesView({
  activeSymbol,
  markets = DERIV_MARKETS,
  currency = 'USD',
  authenticated,
  onSelectMarket,
  onOpenLogin,
  onSellContract,
}: DerivServicesViewProps) {
  const [subTab, setSubTab] = useState<ServiceTabId>(
    authenticated ? 'portfolio' : 'contracts-times',
  );

  // Portfolio state
  const [portfolio, setPortfolio] = useState<DerivPortfolioItem[]>([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [sellingId, setSellingId] = useState<string | null>(null);

  // Profit table state
  const [profitRows, setProfitRows] = useState<DerivProfitTableItem[]>([]);
  const [profitLoading, setProfitLoading] = useState(false);
  const [profitError, setProfitError] = useState<string | null>(null);

  // Statement state
  const [statementRows, setStatementRows] = useState<DerivStatementItem[]>([]);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState<string | null>(null);

  // Contracts & trading times state
  const [contractSpecs, setContractSpecs] = useState<DerivContractSpec[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState<string | null>(null);
  const [tradingMarkets, setTradingMarkets] = useState<DerivTradingTimesMarket[]>([]);
  const [timesLoading, setTimesLoading] = useState(false);
  const [timesSearch, setTimesSearch] = useState('');

  // Status, limits & FX state
  const [serverStatus, setServerStatus] = useState<DerivServerStatus | null>(null);
  const [accountProfile, setAccountProfile] = useState<DerivAccountProfile | null>(null);
  const [fxBase, setFxBase] = useState<string>(currency || 'USD');
  const [fxRates, setFxRates] = useState<Record<string, number>>({});
  const [fxDate, setFxDate] = useState<number>(0);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const loadPortfolio = useCallback(async () => {
    if (!authenticated) return;
    setPortfolioLoading(true);
    setPortfolioError(null);
    try {
      const res = await derivFetch('/api/deriv/portfolio');
      const data = await parseJsonResponse<{ contracts?: DerivPortfolioItem[]; error?: string }>(
        res,
        'Unable to load portfolio',
      );
      if (!res.ok) throw new Error(data.error || 'Unable to load portfolio');
      setPortfolio(data.contracts ?? []);
    } catch (err) {
      setPortfolioError(err instanceof Error ? err.message : 'Failed to load portfolio');
    } finally {
      setPortfolioLoading(false);
    }
  }, [authenticated]);

  const loadProfitTable = useCallback(async () => {
    if (!authenticated) return;
    setProfitLoading(true);
    setProfitError(null);
    try {
      const res = await derivFetch('/api/deriv/profit-table?limit=30');
      const data = await parseJsonResponse<{
        transactions?: DerivProfitTableItem[];
        error?: string;
      }>(res, 'Unable to load profit table');
      if (!res.ok) throw new Error(data.error || 'Unable to load profit table');
      setProfitRows(data.transactions ?? []);
    } catch (err) {
      setProfitError(err instanceof Error ? err.message : 'Failed to load profit table');
    } finally {
      setProfitLoading(false);
    }
  }, [authenticated]);

  const loadStatement = useCallback(async () => {
    if (!authenticated) return;
    setStatementLoading(true);
    setStatementError(null);
    try {
      const res = await derivFetch('/api/deriv/statement?limit=30');
      const data = await parseJsonResponse<{
        transactions?: DerivStatementItem[];
        error?: string;
      }>(res, 'Unable to load account statement');
      if (!res.ok) throw new Error(data.error || 'Unable to load account statement');
      setStatementRows(data.transactions ?? []);
    } catch (err) {
      setStatementError(err instanceof Error ? err.message : 'Failed to load statement');
    } finally {
      setStatementLoading(false);
    }
  }, [authenticated]);

  const loadContractsAndTimes = useCallback(async () => {
    setContractsLoading(true);
    setContractsError(null);
    setTimesLoading(true);
    try {
      const [cRes, tRes] = await Promise.all([
        derivFetch(
          `/api/deriv/contracts-for?symbol=${encodeURIComponent(activeSymbol)}&currency=${encodeURIComponent(currency)}`,
        ),
        derivFetch('/api/deriv/trading-times?date=today'),
      ]);
      const cData = await parseJsonResponse<{ available?: DerivContractSpec[]; error?: string }>(
        cRes,
        'Contracts list unavailable',
      );
      if (!cRes.ok) {
        setContractsError(cData.error || 'Contracts list unavailable');
        setContractSpecs([]);
      } else {
        setContractSpecs(cData.available ?? []);
      }

      if (tRes.ok) {
        const tData = await parseJsonResponse<{ markets?: DerivTradingTimesMarket[] }>(tRes);
        setTradingMarkets(tData.markets ?? []);
      }
    } catch (err) {
      setContractsError(err instanceof Error ? err.message : 'Failed to load contracts');
    } finally {
      setContractsLoading(false);
      setTimesLoading(false);
    }
  }, [activeSymbol, currency]);

  const loadLimitsAndRates = useCallback(async () => {
    setRatesLoading(true);
    setProfileError(null);
    try {
      const requests: Promise<Response>[] = [
        derivFetch('/api/deriv/status'),
        derivFetch(`/api/deriv/rates?base=${encodeURIComponent(fxBase)}`),
      ];
      if (authenticated) {
        requests.push(derivFetch('/api/deriv/account-profile'));
      }
      const [sRes, rRes, pRes] = await Promise.all(requests);
      if (sRes.ok) {
        setServerStatus(await parseJsonResponse<DerivServerStatus>(sRes));
      }
      if (rRes.ok) {
        const rData = await parseJsonResponse<{
          rates?: Record<string, number>;
          date?: number;
        }>(rRes);
        setFxRates(rData.rates ?? {});
        setFxDate(Number(rData.date ?? 0));
      }
      if (pRes) {
        if (pRes.ok) {
          setAccountProfile(await parseJsonResponse<DerivAccountProfile>(pRes));
        } else {
          const errBody = await parseJsonResponse<{ error?: string }>(
            pRes,
            'Could not load account profile',
          );
          setProfileError(errBody.error || 'Could not load account profile');
        }
      } else {
        setAccountProfile(null);
      }
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Failed to load Deriv status & rates');
    } finally {
      setRatesLoading(false);
    }
  }, [authenticated, fxBase]);

  useEffect(() => {
    if (subTab === 'portfolio') loadPortfolio();
    else if (subTab === 'profit-table') loadProfitTable();
    else if (subTab === 'statement') loadStatement();
    else if (subTab === 'contracts-times') loadContractsAndTimes();
    else if (subTab === 'limits-rates') loadLimitsAndRates();
  }, [
    loadContractsAndTimes,
    loadLimitsAndRates,
    loadPortfolio,
    loadProfitTable,
    loadStatement,
    subTab,
  ]);

  const handleSell = async (contractId: string) => {
    setSellingId(contractId);
    try {
      await onSellContract(contractId);
      await loadPortfolio();
    } finally {
      setSellingId(null);
    }
  };

  const profitTotals = useMemo(() => {
    const net = profitRows.reduce((acc, r) => acc + r.profit, 0);
    const wins = profitRows.filter((r) => r.profit > 0).length;
    return {
      net: Number(net.toFixed(2)),
      wins,
      count: profitRows.length,
    };
  }, [profitRows]);

  const flattenedTimes = useMemo(() => {
    const q = timesSearch.trim().toLowerCase();
    const rows: {
      market: string;
      submarket: string;
      symbol: string;
      name: string;
      open: string;
      close: string;
      settlement: string;
      days: string;
    }[] = [];
    for (const m of tradingMarkets) {
      for (const sm of m.submarkets ?? []) {
        for (const sym of sm.symbols ?? []) {
          if (
            q &&
            !sym.symbol.toLowerCase().includes(q) &&
            !sym.name.toLowerCase().includes(q) &&
            !m.name.toLowerCase().includes(q)
          ) {
            continue;
          }
          rows.push({
            market: m.name,
            submarket: sm.name,
            symbol: sym.symbol,
            name: sym.name,
            open: sym.times?.open?.join(', ') || '24/7',
            close: sym.times?.close?.join(', ') || '24/7',
            settlement: sym.times?.settlement || '—',
            days: sym.trading_days?.join(', ') || 'Daily',
          });
        }
      }
    }
    return rows.slice(0, 80);
  }, [timesSearch, tradingMarkets]);

  const sortedRates = useMemo(
    () => Object.entries(fxRates).sort(([a], [b]) => a.localeCompare(b)),
    [fxRates],
  );

  const renderAuthGate = (title: string, description: string) => (
    <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-8 text-center space-y-3">
      <ShieldCheck className="w-8 h-8 text-[#0E5A78] dark:text-[#00A8E8] mx-auto" />
      <h3 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
        {description}
      </p>
      <button
        type="button"
        onClick={onOpenLogin}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-bold cursor-pointer"
      >
        <LogIn className="w-3.5 h-3.5" />
        <span>Sign in to Deriv Account</span>
      </button>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto studio-scroll p-6 bg-slate-50 dark:bg-[#090D16]">
      <div className="max-w-7xl mx-auto space-y-5">
        {/* Header & Sub-Navigation */}
        <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display font-bold text-xl text-slate-900 dark:text-slate-100">
              Deriv Services &amp; Account Hub
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Direct live integration with Deriv portfolio, closed profit table, cashflow statement, contract specs, market hours, account limits, and FX rates.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-900">
            {SERVICE_TABS.map((t) => {
              const Icon = t.icon;
              const active = subTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSubTab(t.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 1. Open Portfolio */}
        {subTab === 'portfolio' &&
          (!authenticated ? (
            renderAuthGate(
              'Connect Deriv to View Live Open Portfolio',
              'View active contracts running on your Deriv Demo or Real account and sell open Multipliers or longer-dated options at market.',
            )
          ) : (
            <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
                  <span className="font-display font-bold text-sm">
                    Open Deriv Contracts ({portfolio.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={loadPortfolio}
                  disabled={portfolioLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${portfolioLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {portfolioError && (
                <div className="px-5 py-2.5 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
                  {portfolioError}
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Contract ID</th>
                      <th className="px-4 py-2.5 font-semibold">Symbol / Type</th>
                      <th className="px-4 py-2.5 font-semibold">Shortcode</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Buy Price</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Payout</th>
                      <th className="px-4 py-2.5 font-semibold">Opened</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {portfolioLoading && portfolio.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                          Loading Deriv open portfolio...
                        </td>
                      </tr>
                    ) : portfolio.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
                          No active contracts open on this Deriv account.
                        </td>
                      </tr>
                    ) : (
                      portfolio.map((c) => (
                        <tr key={c.contract_id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-2.5 font-mono font-semibold">#{c.contract_id}</td>
                          <td className="px-4 py-2.5">
                            <span className="font-bold text-slate-900 dark:text-slate-100">
                              {c.symbol}
                            </span>{' '}
                            <span className="font-mono text-[#0E5A78] dark:text-[#00A8E8]">
                              {c.contract_type}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500 max-w-[260px] truncate">
                            {c.shortcode}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {c.buy_price.toFixed(2)} {c.currency}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-teal-600 dark:text-teal-400">
                            {c.payout > 0 ? `${c.payout.toFixed(2)} ${c.currency}` : 'Variable'}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500">
                            {c.date_start ? new Date(c.date_start * 1000).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              type="button"
                              disabled={sellingId === c.contract_id}
                              onClick={() => handleSell(c.contract_id)}
                              className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-[11px] font-bold cursor-pointer"
                            >
                              {sellingId === c.contract_id ? 'Closing...' : 'Sell at Market'}
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

        {/* 2. Closed Profit Table */}
        {subTab === 'profit-table' &&
          (!authenticated ? (
            renderAuthGate(
              'Connect Deriv to View Closed Profit Table',
              'Inspect historical closed trades, buy/sell execution prices, payouts, and realized net P/L fetched directly from your Deriv ledger.',
            )
          ) : (
            <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
                  <span className="font-display font-bold text-sm">
                    Deriv Closed Profit Table (Last {profitTotals.count})
                  </span>
                  <span
                    className={`font-mono text-xs font-bold tabular-nums ${
                      profitTotals.net >= 0
                        ? 'text-teal-600 dark:text-teal-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }`}
                  >
                    Net: {profitTotals.net >= 0 ? '+' : ''}
                    {profitTotals.net.toFixed(2)} {currency} ({profitTotals.wins}/{profitTotals.count} wins)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={loadProfitTable}
                  disabled={profitLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${profitLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {profitError && (
                <div className="px-5 py-2.5 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
                  {profitError}
                </div>
              )}

              <div className="max-h-[520px] overflow-auto studio-scroll">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Contract</th>
                      <th className="px-4 py-2.5 font-semibold">Description</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Buy</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Sell</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Net Profit</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Closed At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {profitLoading && profitRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                          Fetching profit table from Deriv...
                        </td>
                      </tr>
                    ) : profitRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-10 text-center text-slate-500">
                          No closed contracts found in recent Deriv history.
                        </td>
                      </tr>
                    ) : (
                      profitRows.map((row) => (
                        <tr
                          key={`${row.transaction_id}-${row.contract_id}`}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/40"
                        >
                          <td className="px-4 py-2.5 font-mono">
                            <div className="font-bold text-slate-900 dark:text-slate-100">
                              #{row.contract_id}
                            </div>
                            <div className="text-[11px] text-[#0E5A78] dark:text-[#00A8E8]">
                              {row.underlying_symbol || ''} {row.contract_type || ''}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 max-w-md">
                            <div className="truncate font-mono text-[11px]">{row.shortcode}</div>
                            <div className="text-[11px] text-slate-400 truncate">{row.longcode}</div>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {row.buy_price.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {row.sell_price.toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono font-bold tabular-nums ${
                              row.profit >= 0
                                ? 'text-teal-600 dark:text-teal-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {row.profit >= 0 ? '+' : ''}
                            {row.profit.toFixed(2)} {currency}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-[11px] text-slate-500 whitespace-nowrap">
                            {row.sell_time ? new Date(row.sell_time * 1000).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

        {/* 3. Account Statement */}
        {subTab === 'statement' &&
          (!authenticated ? (
            renderAuthGate(
              'Connect Deriv to View Cashflow Statement',
              'Audit deposits, contract purchases, settlements, and running account balance history directly from Deriv.',
            )
          ) : (
            <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ReceiptText className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
                  <span className="font-display font-bold text-sm">
                    Deriv Account Statement ({statementRows.length})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={loadStatement}
                  disabled={statementLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${statementLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {statementError && (
                <div className="px-5 py-2.5 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
                  {statementError}
                </div>
              )}

              <div className="max-h-[520px] overflow-auto studio-scroll">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Ref / Action</th>
                      <th className="px-4 py-2.5 font-semibold">Details</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Amount</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Balance After</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {statementLoading && statementRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-10 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                          Loading Deriv cashflow statement...
                        </td>
                      </tr>
                    ) : statementRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-10 text-center text-slate-500">
                          No statement entries returned.
                        </td>
                      </tr>
                    ) : (
                      statementRows.map((row) => (
                        <tr
                          key={row.transaction_id}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/40"
                        >
                          <td className="px-4 py-2.5 font-mono">
                            <span className="uppercase font-bold text-[#0E5A78] dark:text-[#00A8E8]">
                              {row.action_type}
                            </span>
                            <div className="text-[11px] text-slate-400">#{row.transaction_id}</div>
                          </td>
                          <td className="px-4 py-2.5 max-w-md">
                            <div className="font-mono text-[11px] text-slate-700 dark:text-slate-200 truncate">
                              {row.shortcode || (row.contract_id ? `Contract #${row.contract_id}` : '—')}
                            </div>
                            <div className="text-[11px] text-slate-400 truncate">
                              {row.longcode || ''}
                            </div>
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right font-mono font-bold tabular-nums ${
                              row.amount >= 0
                                ? 'text-teal-600 dark:text-teal-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {row.amount >= 0 ? '+' : ''}
                            {row.amount.toFixed(2)} {currency}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                            {row.balance_after.toFixed(2)} {currency}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-[11px] text-slate-500 whitespace-nowrap">
                            {row.transaction_time
                              ? new Date(row.transaction_time * 1000).toLocaleString()
                              : '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

        {/* 4. Contracts & Trading Times */}
        {subTab === 'contracts-times' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-5 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="font-display font-bold text-sm">
                  Contracts For Symbol ({contractSpecs.length})
                </div>
                <MarketSelector
                  markets={markets}
                  value={activeSymbol}
                  onChange={onSelectMarket}
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-semibold max-w-[200px]"
                />
              </div>

              {contractsError && (
                <div className="px-4 py-2 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 text-xs">
                  {contractsError}
                </div>
              )}

              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[480px] overflow-y-auto studio-scroll">
                {contractsLoading ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading Deriv contract specifications...
                  </div>
                ) : contractSpecs.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-500">
                    No contract rules returned for {activeSymbol}.
                  </div>
                ) : (
                  contractSpecs.map((spec, idx) => (
                    <div
                      key={`${spec.contract_type}-${spec.contract_category}-${idx}`}
                      className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {spec.contract_display || spec.contract_type}{' '}
                          <span className="font-mono text-[11px] text-[#0E5A78] dark:text-[#00A8E8]">
                            ({spec.contract_type})
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {spec.contract_category_display} · Duration {spec.min_contract_duration} –{' '}
                          {spec.max_contract_duration}
                        </div>
                      </div>
                      <div className="text-right font-mono text-[11px] text-slate-500 shrink-0">
                        {spec.multiplier_range?.length
                          ? `x${spec.multiplier_range.join(', x')}`
                          : spec.sentiment || spec.barrier_category || 'Options'}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="lg:col-span-7 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
                  <span className="font-display font-bold text-sm">
                    Global Market Trading Hours ({flattenedTimes.length})
                  </span>
                </div>
                <input
                  type="text"
                  value={timesSearch}
                  onChange={(e) => setTimesSearch(e.target.value)}
                  placeholder="Filter symbol or market..."
                  className="w-48 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1 text-xs"
                />
              </div>

              <div className="max-h-[480px] overflow-auto studio-scroll">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 text-[11px] text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Instrument</th>
                      <th className="px-3 py-2 font-semibold">Market</th>
                      <th className="px-3 py-2 font-semibold">Open (GMT)</th>
                      <th className="px-3 py-2 font-semibold">Close (GMT)</th>
                      <th className="px-4 py-2 font-semibold">Days</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {timesLoading ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                          Loading Deriv trading times...
                        </td>
                      </tr>
                    ) : (
                      flattenedTimes.map((row) => (
                        <tr
                          key={`${row.market}-${row.symbol}`}
                          className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                          onClick={() => onSelectMarket(row.symbol)}
                        >
                          <td className="px-4 py-2">
                            <div className="font-semibold text-slate-900 dark:text-slate-100">
                              {row.name}
                            </div>
                            <div className="font-mono text-[10px] text-slate-400">{row.symbol}</div>
                          </td>
                          <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                            {row.market}
                          </td>
                          <td className="px-3 py-2 font-mono text-[11px]">{row.open}</td>
                          <td className="px-3 py-2 font-mono text-[11px]">{row.close}</td>
                          <td className="px-4 py-2 text-[11px] text-slate-500">{row.days}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 5. Account Limits, Server Status & Live FX Rates */}
        {subTab === 'limits-rates' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-6 space-y-5">
              {/* Platform Status */}
              <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
                    <h2 className="font-display font-bold text-sm">Deriv Platform &amp; App Config</h2>
                  </div>
                  <button
                    type="button"
                    onClick={loadLimitsAndRates}
                    disabled={ratesLoading}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${ratesLoading ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>

                {serverStatus ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Deriv Site Status</div>
                      <div className="font-mono font-bold uppercase text-teal-600 dark:text-teal-400">
                        {serverStatus.siteStatus}
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Deriv App ID</div>
                      <div className="font-mono font-bold truncate" title={serverStatus.appId}>
                        {serverStatus.appId}
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Real Execution Guard</div>
                      <div className="font-mono font-bold">
                        {serverStatus.allowRealTrading ? 'ENABLED' : 'DEMO SAFE'}
                      </div>
                    </div>
                    <div className="col-span-2 sm:col-span-3 p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500 mb-1">
                        Supported Payout Currencies
                      </div>
                      <div className="font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-200">
                        {serverStatus.payoutCurrencies.join(' · ')}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">Loading Deriv server health...</div>
                )}
              </div>

              {/* Authenticated Account Limits & Settings */}
              {!authenticated ? (
                renderAuthGate(
                  'Account Limits & Verification Status',
                  'Sign in to inspect your Deriv daily turnover limits, max open positions, payout ceilings, and profile verification status.',
                )
              ) : (
                <div className="rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 p-4 space-y-3 text-xs">
                  <div className="flex items-center justify-between">
                    <h2 className="font-display font-bold text-sm">
                      Account Limits &amp; Profile ({accountProfile?.accountId || '—'})
                    </h2>
                    <span className="font-mono text-[11px] uppercase text-[#0E5A78] dark:text-[#00A8E8] font-bold">
                      {accountProfile?.accountType || 'account'} · {accountProfile?.currency || currency}
                    </span>
                  </div>
                  {profileError && (
                    <div className="p-2.5 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
                      {profileError}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Max Open Positions</div>
                      <div className="font-mono font-bold text-sm">
                        {accountProfile?.limits?.open_positions ?? 'Unlimited'}
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Max Payout Limit</div>
                      <div className="font-mono font-bold text-sm">
                        {accountProfile?.limits?.payout != null
                          ? `${accountProfile.limits.payout} ${currency}`
                          : 'Standard'}
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Country / Language</div>
                      <div className="font-semibold">
                        {accountProfile?.settings?.country ||
                          accountProfile?.settings?.country_code ||
                          '—'}{' '}
                        ({accountProfile?.settings?.preferred_language || 'EN'})
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <div className="text-[11px] text-slate-500">Risk / Status</div>
                      <div className="font-mono font-semibold truncate">
                        {accountProfile?.status?.risk_classification || 'standard'}
                        {accountProfile?.status?.status?.length
                          ? ` (${accountProfile.status.status.slice(0, 2).join(', ')})`
                          : ''}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Live FX & Crypto Exchange Rates */}
            <div className="lg:col-span-6 rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                  <span className="font-display font-bold text-sm">
                    Deriv Live FX &amp; Crypto Rates
                  </span>
                  {fxDate > 0 && (
                    <span className="text-[10px] font-mono text-slate-400">
                      {new Date(fxDate * 1000).toLocaleTimeString()}
                    </span>
                  )}
                </div>
                <select
                  value={fxBase}
                  onChange={(e) => setFxBase(e.target.value)}
                  className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 font-mono text-xs font-bold"
                >
                  {['USD', 'EUR', 'GBP', 'AUD', 'BTC', 'ETH', 'USDT'].map((c) => (
                    <option key={c} value={c}>
                      Base: {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[420px] overflow-y-auto studio-scroll">
                {sortedRates.length === 0 ? (
                  <div className="col-span-3 py-10 text-center text-xs text-slate-500">
                    {ratesLoading ? 'Fetching Deriv exchange rates...' : 'No rates available.'}
                  </div>
                ) : (
                  sortedRates.map(([sym, val]) => (
                    <div
                      key={sym}
                      className="p-2.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs"
                    >
                      <span className="font-mono font-bold text-slate-700 dark:text-slate-200">
                        {fxBase}/{sym}
                      </span>
                      <span className="font-mono tabular-nums text-[#0E5A78] dark:text-[#00A8E8] font-semibold">
                        {val >= 100 ? val.toFixed(2) : val >= 1 ? val.toFixed(4) : val.toFixed(6)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
