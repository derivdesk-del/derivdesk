import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  CloudUpload,
  Code2,
  Copy,
  Download,
  FileCode2,
  FolderOpen,
  LineChart,
  List,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from 'recharts';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { exportStrategyToDerivXml, parseBotXmlToStrategy } from '../../lib/derivXml.ts';
import {
  deleteCloudStrategy,
  saveStrategyToCloud,
  subscribeUserStrategies,
} from '../../lib/firebase.ts';
import {
  generatePolyglotStrategyCode,
  POLYGLOT_LANGUAGES,
} from '../../lib/polyglotCodegen.ts';
import {
  DEFAULT_BOT_STRATEGY,
  DEFAULT_PRETRADE_ANALYSIS,
  DERIV_MARKETS,
  type BotStrategyConfig,
  type CandleInterval,
  type CloudStrategyRecord,
  type ContractTypeOption,
  type DurationUnit,
  type MarketGroup,
  type MarketSubGroup,
  type MarketSymbol,
  type PolyglotLanguage,
  type PurchaseConditionMode,
  type TickPoint,
  type TradeCategory,
  type TradeSubType,
} from '../../shared/types.ts';

interface StrategyCanvasProps {
  strategy: BotStrategyConfig;
  markets?: MarketSymbol[];
  ticks: TickPoint[];
  canUndo: boolean;
  canRedo: boolean;
  focusedBlock: string | null;
  isRunning?: boolean;
  onUpdateStrategy: (
    updater: BotStrategyConfig | ((prev: BotStrategyConfig) => BotStrategyConfig),
  ) => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenQuickStrategy: () => void;
  onToggleRun?: () => void;
}

const MARKET_GROUPS: MarketGroup[] = [
  'Derived',
  'Forex',
  'Commodities',
  'Stock Indices',
  'Cryptocurrencies',
];

const CONTRACT_OPTIONS_BY_TYPE: Record<TradeSubType, { value: ContractTypeOption; label: string }[]> = {
  'Matches/Differs': [
    { value: 'Both', label: 'Both (Auto Differ)' },
    { value: 'DIGITDIFF', label: 'Digit Differ' },
    { value: 'DIGITMATCH', label: 'Digit Match' },
  ],
  'Even/Odd': [
    { value: 'DIGITEVEN', label: 'Digit Even' },
    { value: 'DIGITODD', label: 'Digit Odd' },
  ],
  'Over/Under': [
    { value: 'DIGITOVER', label: 'Digit Over' },
    { value: 'DIGITUNDER', label: 'Digit Under' },
  ],
  'Rise/Fall': [
    { value: 'CALL', label: 'Rise (Call)' },
    { value: 'PUT', label: 'Fall (Put)' },
  ],
  Multipliers: [
    { value: 'MULTUP', label: 'Multiplier Up' },
    { value: 'MULTDOWN', label: 'Multiplier Down' },
  ],
};

export function StrategyCanvas({
  strategy,
  markets = DERIV_MARKETS,
  ticks,
  canUndo,
  canRedo,
  focusedBlock,
  isRunning = false,
  onUpdateStrategy,
  onUndo,
  onRedo,
  onOpenQuickStrategy,
  onToggleRun,
}: StrategyCanvasProps) {
  const { user, signInWithGoogle } = useAuth();
  const [zoom, setZoom] = useState(1);
  const [showMiniChart, setShowMiniChart] = useState(false);
  const [polyglotOpen, setPolyglotOpen] = useState(false);
  const [polyglotLang, setPolyglotLang] = useState<PolyglotLanguage>('typescript');
  const [polyglotCopied, setPolyglotCopied] = useState(false);
  const [cloudDrawerOpen, setCloudDrawerOpen] = useState(false);
  const [cloudStrategies, setCloudStrategies] = useState<CloudStrategyRecord[]>([]);
  const [cloudSaving, setCloudSaving] = useState(false);
  const [importBanner, setImportBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [uploadedXmlMeta, setUploadedXmlMeta] = useState<{
    fileName: string;
    xmlText: string;
    quantFiltered: boolean;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) {
      setCloudStrategies([]);
      return;
    }
    const unsub = subscribeUserStrategies(user.uid, (items) => {
      setCloudStrategies(items);
    });
    return () => unsub();
  }, [user]);

  const handleSaveStrategyCloud = async () => {
    if (!user) {
      await signInWithGoogle();
      return;
    }
    setCloudSaving(true);
    try {
      await saveStrategyToCloud(user.uid, strategy);
      setImportBanner({
        type: 'ok',
        text: `Saved "${strategy.name}" to your Cloud Strategy Vault.`,
      });
    } catch (err) {
      setImportBanner({
        type: 'err',
        text: err instanceof Error ? err.message : 'Cloud strategy save failed.',
      });
    } finally {
      setCloudSaving(false);
    }
  };

  const subGroups = Array.from(
    new Set(
      markets
        .filter((m) => m.marketGroup === strategy.tradeParams.marketGroup)
        .map((m) => m.subGroup),
    ),
  );
  const filteredMarkets = markets.filter(
    (m) =>
      m.marketGroup === strategy.tradeParams.marketGroup &&
      m.subGroup === strategy.tradeParams.subGroup,
  );
  const marketChoices = filteredMarkets.length > 0 ? filteredMarkets : markets;
  const currentMarketMeta =
    markets.find((m) => m.symbol === strategy.tradeParams.symbol) ?? markets[0];

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(strategy, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${strategy.id || 'derivdesk-bot'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportXml = () => {
    const xml = exportStrategyToDerivXml(strategy);
    const blob = new Blob([xml], {
      type: 'application/xml;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${strategy.id || 'derivdesk-bot'}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadBotFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      const isXml =
        file.name.toLowerCase().endsWith('.xml') || content.trim().startsWith('<');
      try {
        if (isXml) {
          const outcome = parseBotXmlToStrategy(
            content,
            file.name,
            markets,
            strategy,
            false,
          );
          onUpdateStrategy(outcome.strategy);
          setUploadedXmlMeta({
            fileName: file.name,
            xmlText: content,
            quantFiltered: false,
          });
          setImportBanner({ type: 'ok', text: outcome.summary });
        } else {
          const parsed = JSON.parse(content) as BotStrategyConfig;
          if (parsed && parsed.tradeParams && parsed.variables) {
            onUpdateStrategy({
              ...parsed,
              preTradeAnalysis: parsed.preTradeAnalysis ?? DEFAULT_PRETRADE_ANALYSIS,
            });
            setUploadedXmlMeta(null);
            setImportBanner({
              type: 'ok',
              text: `Imported "${file.name}" (${parsed.tradeParams.symbol} · ${parsed.tradeParams.contractType})`,
            });
          } else {
            throw new Error('Invalid JSON bot file');
          }
        }
      } catch (err) {
        setUploadedXmlMeta(null);
        setImportBanner({
          type: 'err',
          text: err instanceof Error ? err.message : 'Could not parse uploaded bot file.',
        });
      }
    };
    reader.readAsText(file);
  };

  const switchXmlExecutionMode = (useQuantFilter: boolean) => {
    if (!uploadedXmlMeta) return;
    try {
      const outcome = parseBotXmlToStrategy(
        uploadedXmlMeta.xmlText,
        uploadedXmlMeta.fileName,
        markets,
        strategy,
        useQuantFilter,
      );
      onUpdateStrategy(outcome.strategy);
      setUploadedXmlMeta((prev) =>
        prev ? { ...prev, quantFiltered: useQuantFilter } : null,
      );
      setImportBanner({
        type: 'ok',
        text: `${outcome.summary} · Mode: ${useQuantFilter ? 'XML + Best Quant Edge Filter' : 'XML Direct Execution'}`,
      });
    } catch {
      // Keep current strategy
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadBotFile(file);
    }
    e.target.value = '';
  };

  const updateTradeParam = <K extends keyof BotStrategyConfig['tradeParams']>(
    key: K,
    value: BotStrategyConfig['tradeParams'][K],
  ) => {
    onUpdateStrategy((prev) => ({
      ...prev,
      tradeParams: {
        ...prev.tradeParams,
        [key]: value,
      },
    }));
  };

  const applyMarketSelection = (nextMeta: MarketSymbol) => {
    const nextCategory: TradeCategory = nextMeta.supportsDigits
      ? 'Digits'
      : nextMeta.supportsRiseFall !== false
        ? 'Up/Down'
        : 'Multipliers';
    const nextTradeType: TradeSubType =
      nextCategory === 'Digits'
        ? 'Matches/Differs'
        : nextCategory === 'Up/Down'
          ? 'Rise/Fall'
          : 'Multipliers';
    const nextContract: ContractTypeOption =
      nextCategory === 'Digits'
        ? 'DIGITDIFF'
        : nextCategory === 'Up/Down'
          ? 'CALL'
          : 'MULTUP';

    onUpdateStrategy((prev) => ({
      ...prev,
      tradeParams: {
        ...prev.tradeParams,
        marketGroup: nextMeta.marketGroup,
        subGroup: nextMeta.subGroup,
        symbol: nextMeta.symbol,
        tradeCategory: nextCategory,
        tradeType: nextTradeType,
        contractType: nextContract,
      },
      purchaseConditions: {
        ...prev.purchaseConditions,
        durationTicks: nextMeta.defaultDuration ?? 1,
        durationUnit: nextMeta.defaultDurationUnit ?? 't',
      },
    }));
  };

  const handleTradeCategoryChange = (cat: TradeCategory) => {
    if (cat === 'Digits') {
      onUpdateStrategy((prev) => ({
        ...prev,
        tradeParams: {
          ...prev.tradeParams,
          tradeCategory: 'Digits',
          tradeType: 'Matches/Differs',
          contractType: 'DIGITDIFF',
        },
        purchaseConditions: {
          ...prev.purchaseConditions,
          durationTicks: 1,
          durationUnit: 't',
        },
      }));
    } else if (cat === 'Up/Down') {
      onUpdateStrategy((prev) => ({
        ...prev,
        tradeParams: {
          ...prev.tradeParams,
          tradeCategory: 'Up/Down',
          tradeType: 'Rise/Fall',
          contractType: 'CALL',
        },
        purchaseConditions: {
          ...prev.purchaseConditions,
          durationTicks: currentMarketMeta?.defaultDuration ?? 1,
          durationUnit: currentMarketMeta?.defaultDurationUnit ?? 't',
        },
      }));
    } else {
      onUpdateStrategy((prev) => ({
        ...prev,
        tradeParams: {
          ...prev.tradeParams,
          tradeCategory: 'Multipliers',
          tradeType: 'Multipliers',
          contractType: 'MULTUP',
        },
      }));
    }
  };

  const handleTradeTypeChange = (tt: TradeSubType) => {
    const defaultContract = CONTRACT_OPTIONS_BY_TYPE[tt][0].value;
    onUpdateStrategy((prev) => ({
      ...prev,
      tradeParams: {
        ...prev.tradeParams,
        tradeCategory:
          tt === 'Rise/Fall' ? 'Up/Down' : tt === 'Multipliers' ? 'Multipliers' : 'Digits',
        tradeType: tt,
        contractType: defaultContract,
      },
    }));
  };

  const addVariable = () => {
    onUpdateStrategy((prev) => ({
      ...prev,
      variables: [
        ...prev.variables,
        {
          id: `v-${Date.now()}`,
          name: `custom_var_${prev.variables.length + 1}`,
          value: 1,
        },
      ],
    }));
  };

  const updateVariable = (id: string, patch: { name?: string; value?: number }) => {
    onUpdateStrategy((prev) => ({
      ...prev,
      variables: prev.variables.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    }));
  };

  const deleteVariable = (id: string) => {
    onUpdateStrategy((prev) => ({
      ...prev,
      variables: prev.variables.filter((v) => v.id !== id),
    }));
  };

  const chartSeries = ticks.slice(-60).map((t, idx) => ({
    idx,
    quote: t.quote,
    digit: t.lastDigit,
  }));

  const preCfg = {
    ...DEFAULT_PRETRADE_ANALYSIS,
    ...strategy.preTradeAnalysis,
  };

  const updatePreTrade = <K extends keyof typeof preCfg>(
    key: K,
    val: (typeof preCfg)[K],
  ) => {
    onUpdateStrategy((prev) => ({
      ...prev,
      preTradeAnalysis: {
        ...DEFAULT_PRETRADE_ANALYSIS,
        ...prev.preTradeAnalysis,
        [key]: val,
      },
    }));
  };

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) loadBotFile(file);
      }}
      className={`flex-1 min-w-0 relative bot-dotted-canvas overflow-auto studio-scroll ${
        dragOver ? 'ring-2 ring-inset ring-[#00A8E8]' : ''
      }`}
    >
      <input
        id="bot-xml-file-input"
        ref={fileInputRef}
        type="file"
        accept=".xml,.json,text/xml,application/xml,application/json"
        onChange={handleImportFile}
        className="hidden"
      />

      {/* Top Floating Canvas Toolbar */}
      <div className="sticky top-3 left-3 z-20 inline-flex items-center gap-0.5 ml-3 mt-3 px-2 py-1.5 rounded-lg bg-white dark:bg-[#1E293B] border border-slate-200 dark:border-slate-700 shadow-sm">
        <button
          type="button"
          title="Reset strategy to default"
          onClick={() => onUpdateStrategy(DEFAULT_BOT_STRATEGY)}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Upload Deriv XML or JSON bot file"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#0E5A78]/10 hover:bg-[#0E5A78]/20 text-[#0E5A78] dark:text-[#00A8E8] text-xs font-semibold cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
          <span>Upload XML</span>
        </button>
        <button
          type="button"
          title="Import bot file (.xml / .json)"
          onClick={() => fileInputRef.current?.click()}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Export as Deriv Blockly XML (.xml)"
          onClick={handleExportXml}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <FileCode2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Export strategy JSON"
          onClick={handleExportJson}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <Download className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Compile strategy to TypeScript, Python, Rust, C++, Go, Pine Script, MQL5, SQL & Deriv XML"
          onClick={() => setPolyglotOpen(true)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-teal-600/10 hover:bg-teal-600/20 text-teal-700 dark:text-teal-300 text-xs font-semibold cursor-pointer whitespace-nowrap"
        >
          <Code2 className="w-3.5 h-3.5" />
          <span>9-Lang Code</span>
        </button>
        <button
          type="button"
          title="Quick Strategy Configurator"
          onClick={onOpenQuickStrategy}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
        <button
          type="button"
          disabled={cloudSaving}
          title={user ? 'Save current bot strategy to Cloud Vault' : 'Sign in with Google to save strategy to Cloud'}
          onClick={() => void handleSaveStrategyCloud()}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sky-600/10 hover:bg-sky-600/20 text-sky-700 dark:text-sky-300 text-xs font-semibold cursor-pointer whitespace-nowrap"
        >
          <CloudUpload className="w-3.5 h-3.5" />
          <span>{cloudSaving ? 'Saving...' : 'Save Cloud'}</span>
        </button>
        <div className="relative">
          <button
            type="button"
            title="Open saved Cloud strategies"
            onClick={() => setCloudDrawerOpen((o) => !o)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold cursor-pointer whitespace-nowrap"
          >
            <Cloud className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
            <span>Vault ({cloudStrategies.length})</span>
          </button>
          {cloudDrawerOpen && (
            <div className="absolute left-0 top-9 w-72 rounded-lg bg-white dark:bg-[#1E293B] border border-slate-200 dark:border-slate-700 shadow-xl p-3 z-40 space-y-2 text-xs">
              <div className="flex items-center justify-between font-semibold text-slate-900 dark:text-slate-100">
                <span>Cloud Strategy Vault</span>
                <button
                  type="button"
                  onClick={() => setCloudDrawerOpen(false)}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {!user ? (
                <button
                  type="button"
                  onClick={() => void signInWithGoogle()}
                  className="w-full py-2 rounded bg-[#0E5A78] text-white font-semibold cursor-pointer"
                >
                  Sign in with Google to Sync
                </button>
              ) : cloudStrategies.length === 0 ? (
                <p className="text-[11px] text-slate-500">
                  No cloud strategies saved yet. Click &ldquo;Save Cloud&rdquo; to store this setup.
                </p>
              ) : (
                <div className="max-h-52 overflow-y-auto studio-scroll space-y-1.5">
                  {cloudStrategies.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 p-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onUpdateStrategy(item.config);
                          setCloudDrawerOpen(false);
                          setImportBanner({
                            type: 'ok',
                            text: `Loaded "${item.name}" from Cloud Vault.`,
                          });
                        }}
                        className="text-left min-w-0 flex-1 cursor-pointer"
                      >
                        <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {item.name}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">
                          {item.symbol} · {item.contractType} · ${item.stake}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteCloudStrategy(user.uid, item.id)}
                        title="Delete from Cloud"
                        className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

        <button
          type="button"
          title="Toggle live mini-chart overlay"
          onClick={() => setShowMiniChart((s) => !s)}
          className={`p-1.5 rounded transition-colors cursor-pointer ${
            showMiniChart
              ? 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300'
              : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200'
          }`}
        >
          <LineChart className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

        <button
          type="button"
          title="Undo"
          disabled={!canUndo}
          onClick={onUndo}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          title="Redo"
          disabled={!canRedo}
          onClick={onRedo}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
        >
          <Redo2 className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

        <button
          type="button"
          title="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.25, Number((z + 0.1).toFixed(2))))}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <span className="px-1 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          title="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.75, Number((z - 0.1).toFixed(2))))}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
      </div>

      {/* Optional Floating Mini Tick Chart */}
      {showMiniChart && (
        <div className="mx-4 mt-3 max-w-2xl rounded-lg bg-white/95 dark:bg-[#0F172A]/95 border border-slate-200 dark:border-slate-700 shadow-sm p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Live Tick Stream ({strategy.tradeParams.symbol})
            </span>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {ticks.length > 0 ? ticks[ticks.length - 1].formattedQuote : '—'}
            </span>
          </div>
          <div className="h-28 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartSeries}>
                <YAxis domain={['auto', 'auto']} hide />
                <Tooltip
                  contentStyle={{
                    fontSize: '11px',
                    borderRadius: '6px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="quote"
                  stroke="#0E5A78"
                  fill="#00A8E8"
                  fillOpacity={0.14}
                  strokeWidth={1.75}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* XML Import Feedback Banner */}
      {importBanner && (
        <div
          className={`mx-4 mt-3 max-w-3xl rounded-md px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3 border ${
            importBanner.type === 'ok'
              ? 'bg-teal-50 dark:bg-teal-950/40 border-teal-200 dark:border-teal-800 text-teal-900 dark:text-teal-200'
              : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
          }`}
        >
          <span className="font-medium">{importBanner.text}</span>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {importBanner.type === 'ok' && uploadedXmlMeta && (
              <div className="inline-flex items-center rounded border border-teal-300 dark:border-teal-700 overflow-hidden bg-white/80 dark:bg-slate-900/80">
                <button
                  type="button"
                  onClick={() => switchXmlExecutionMode(false)}
                  className={`px-2 py-1 text-[11px] font-semibold cursor-pointer ${
                    !uploadedXmlMeta.quantFiltered
                      ? 'bg-[#0E5A78] text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  XML Direct
                </button>
                <button
                  type="button"
                  onClick={() => switchXmlExecutionMode(true)}
                  className={`px-2 py-1 text-[11px] font-semibold cursor-pointer ${
                    uploadedXmlMeta.quantFiltered
                      ? 'bg-[#0F766E] text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  XML + Quant Filter
                </button>
              </div>
            )}
            {importBanner.type === 'ok' && onToggleRun && (
              <button
                type="button"
                onClick={onToggleRun}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-bold text-white cursor-pointer ${
                  isRunning
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-[#389E94] hover:bg-[#2F877E]'
                }`}
              >
                {isRunning ? (
                  <>
                    <Square className="w-3 h-3 fill-current" />
                    <span>Stop XML Bot</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 fill-current" />
                    <span>Run Uploaded XML</span>
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setImportBanner(null)}
              className="text-[11px] font-semibold underline shrink-0 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Visual Blockly-Style Strategy Workspace */}
      <div
        className="p-5 pb-16 origin-top-left transition-transform duration-150"
        style={{ transform: `scale(${zoom})` }}
      >
        <div className="max-w-[740px] space-y-2.5">
          {/* BLOCK 1: 1. Trade parameters */}
          <div
            id="block-trade-params"
            className={`rounded-md overflow-hidden shadow-sm border transition-shadow ${
              focusedBlock === 'block-trade-params'
                ? 'ring-2 ring-[#00A8E8] border-[#00A8E8]'
                : 'border-slate-300 dark:border-slate-700'
            }`}
          >
            <div className="bg-[#0E5A78] text-white px-3.5 py-2 flex items-center gap-2 text-xs font-semibold">
              <List className="w-4 h-4 text-sky-200 shrink-0" />
              <span>1. Trade parameters</span>
              <span className="ml-auto font-mono text-[11px] text-sky-100/80 truncate max-w-[240px]">
                {strategy.name}
              </span>
            </div>

            <div className="bg-[#DDE1E6] dark:bg-slate-800/95 p-3 space-y-2 text-xs text-slate-900 dark:text-slate-100">
              {/* Market row */}
              <div className="flex flex-wrap items-center gap-1.5 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600">
                <span className="font-medium mr-1">Market:</span>
                <select
                  value={strategy.tradeParams.marketGroup}
                  onChange={(e) => {
                    const nextGroup = e.target.value as MarketGroup;
                    const first =
                      markets.find((m) => m.marketGroup === nextGroup) ?? markets[0];
                    applyMarketSelection(first);
                  }}
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                >
                  {MARKET_GROUPS.map((grp) => (
                    <option key={grp} value={grp}>
                      {grp}
                    </option>
                  ))}
                </select>
                <span className="text-slate-500">&gt;</span>
                <select
                  value={strategy.tradeParams.subGroup}
                  onChange={(e) => {
                    const nextSub = e.target.value as MarketSubGroup;
                    const first =
                      markets.find(
                        (m) =>
                          m.marketGroup === strategy.tradeParams.marketGroup &&
                          m.subGroup === nextSub,
                      ) ?? markets[0];
                    applyMarketSelection(first);
                  }}
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                >
                  {subGroups.map((sg) => (
                    <option key={sg} value={sg}>
                      {sg}
                    </option>
                  ))}
                </select>
                <span className="text-slate-500">&gt;</span>
                <select
                  value={strategy.tradeParams.symbol}
                  onChange={(e) => {
                    const meta = markets.find((m) => m.symbol === e.target.value);
                    if (meta) applyMarketSelection(meta);
                  }}
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                >
                  {marketChoices.map((m) => (
                    <option key={m.symbol} value={m.symbol}>
                      {m.name} ({m.symbol}){m.exchangeOpen === false ? ' [Closed]' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2 px-2 py-1 cursor-pointer">
                <span>Change market on each run:</span>
                <input
                  type="checkbox"
                  checked={strategy.tradeParams.changeMarketOnRun}
                  onChange={(e) => updateTradeParam('changeMarketOnRun', e.target.checked)}
                  className="rounded border-slate-400 text-[#0E5A78] focus:ring-sky-500"
                />
              </label>

              <div className="flex flex-wrap items-center gap-4 px-2 py-0.5">
                <div className="flex items-center gap-2">
                  <span>When cycling, update analysis:</span>
                  <select
                    value={strategy.tradeParams.updateAnalysisOnCycle ? 'Yes' : 'No'}
                    onChange={(e) =>
                      updateTradeParam('updateAnalysisOnCycle', e.target.value === 'Yes')
                    }
                    className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium"
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span>Fast trades:</span>
                  <select
                    value={strategy.tradeParams.fastTrades ? 'Yes' : 'No'}
                    onChange={(e) =>
                      updateTradeParam('fastTrades', e.target.value === 'Yes')
                    }
                    className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium"
                  >
                    <option value="No">No</option>
                    <option value="Yes">Yes</option>
                  </select>
                </div>
              </div>

              {/* Trade Type */}
              <div className="flex flex-wrap items-center gap-1.5 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600">
                <span className="font-medium mr-1">Trade Type:</span>
                <select
                  value={strategy.tradeParams.tradeCategory}
                  onChange={(e) =>
                    handleTradeCategoryChange(e.target.value as TradeCategory)
                  }
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium"
                >
                  {currentMarketMeta?.supportsDigits !== false && (
                    <option value="Digits">Digits</option>
                  )}
                  {currentMarketMeta?.supportsRiseFall !== false && (
                    <option value="Up/Down">Up/Down</option>
                  )}
                  {currentMarketMeta?.supportsMultipliers !== false && (
                    <option value="Multipliers">Multipliers</option>
                  )}
                </select>
                <span className="text-slate-500">&gt;</span>
                <select
                  value={strategy.tradeParams.tradeType}
                  onChange={(e) =>
                    handleTradeTypeChange(e.target.value as TradeSubType)
                  }
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                >
                  {strategy.tradeParams.tradeCategory === 'Digits' ? (
                    <>
                      <option value="Matches/Differs">Matches/Differs</option>
                      <option value="Even/Odd">Even/Odd</option>
                      <option value="Over/Under">Over/Under</option>
                    </>
                  ) : strategy.tradeParams.tradeCategory === 'Up/Down' ? (
                    <option value="Rise/Fall">Rise/Fall</option>
                  ) : (
                    <option value="Multipliers">Multipliers</option>
                  )}
                </select>
              </div>

              {/* Contract Type */}
              <div className="flex flex-wrap items-center gap-2 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600 w-fit">
                <span className="font-medium">Contract Type:</span>
                <select
                  value={strategy.tradeParams.contractType}
                  onChange={(e) =>
                    updateTradeParam('contractType', e.target.value as ContractTypeOption)
                  }
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                >
                  {(CONTRACT_OPTIONS_BY_TYPE[strategy.tradeParams.tradeType] ?? []).map(
                    (opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ),
                  )}
                </select>
              </div>

              {/* Candle Interval */}
              <div className="flex items-center gap-2 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600 w-fit">
                <span className="font-medium">Default Candle Interval:</span>
                <select
                  value={strategy.tradeParams.candleInterval}
                  onChange={(e) =>
                    updateTradeParam('candleInterval', e.target.value as CandleInterval)
                  }
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium"
                >
                  <option value="1 tick">1 tick</option>
                  <option value="1 minute">1 minute</option>
                  <option value="5 minutes">5 minutes</option>
                  <option value="15 minutes">15 minutes</option>
                </select>
              </div>

              <label className="flex items-center gap-2 px-2 py-0.5 cursor-pointer">
                <span>Restart buy/sell on error (disable for better performance):</span>
                <input
                  type="checkbox"
                  checked={strategy.tradeParams.restartBuySellOnError}
                  onChange={(e) =>
                    updateTradeParam('restartBuySellOnError', e.target.checked)
                  }
                  className="rounded border-slate-400 text-[#0E5A78]"
                />
              </label>

              <label className="flex items-center gap-2 px-2 py-0.5 cursor-pointer">
                <span>Restart last trade on error (bot ignores the unsuccessful trade):</span>
                <input
                  type="checkbox"
                  checked={strategy.tradeParams.restartLastTradeOnError}
                  onChange={(e) =>
                    updateTradeParam('restartLastTradeOnError', e.target.checked)
                  }
                  className="rounded border-slate-400 text-[#0E5A78]"
                />
              </label>
            </div>
          </div>

          {/* BLOCK 2: Run once at start */}
          <div
            id="block-run-once"
            className={`rounded-md overflow-hidden shadow-sm border transition-shadow ${
              focusedBlock === 'block-run-once'
                ? 'ring-2 ring-[#00A8E8] border-[#00A8E8]'
                : 'border-slate-300 dark:border-slate-700'
            }`}
          >
            <div className="bg-[#0E5A78] text-white px-3.5 py-2 flex items-center justify-between text-xs font-semibold">
              <span>Run once at start:</span>
              <button
                type="button"
                onClick={addVariable}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/15 hover:bg-white/25 text-[11px] font-medium transition-colors cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Add variable</span>
              </button>
            </div>

            <div className="bg-[#DDE1E6] dark:bg-slate-800/95 p-3 space-y-1.5 text-xs text-slate-900 dark:text-slate-100">
              {strategy.variables.map((variable) => (
                <div
                  key={variable.id}
                  className="flex flex-wrap items-center gap-2 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600 w-fit"
                >
                  <span className="font-medium text-slate-600 dark:text-slate-300">set</span>
                  <input
                    type="text"
                    value={variable.name}
                    onChange={(e) => updateVariable(variable.id, { name: e.target.value })}
                    className="w-32 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-mono font-semibold focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  />
                  <span className="font-medium text-slate-600 dark:text-slate-300">to</span>
                  <input
                    type="number"
                    step="0.1"
                    value={variable.value}
                    onChange={(e) =>
                      updateVariable(variable.id, {
                        value: Number(e.target.value) || 0,
                      })
                    }
                    className="w-20 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-mono font-bold tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-sky-500/40"
                  />
                  {variable.name !== 'stake' && (
                    <button
                      type="button"
                      title="Remove variable"
                      onClick={() => deleteVariable(variable.id)}
                      className="text-slate-400 hover:text-rose-600 p-0.5 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* BLOCK 3: 2. Purchase conditions */}
          <div
            id="block-purchase"
            className={`rounded-md overflow-hidden shadow-sm border transition-shadow ${
              focusedBlock === 'block-purchase'
                ? 'ring-2 ring-[#00A8E8] border-[#00A8E8]'
                : 'border-slate-300 dark:border-slate-700'
            }`}
          >
            <div className="bg-[#0F766E] text-white px-3.5 py-2 flex items-center gap-2 text-xs font-semibold">
              <span>2. Purchase conditions</span>
            </div>

            <div className="bg-[#DDE1E6] dark:bg-slate-800/95 p-3 space-y-2 text-xs text-slate-900 dark:text-slate-100">
              <div className="flex flex-wrap items-center gap-2 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600">
                <span className="font-medium">Entry rule:</span>
                <select
                  value={strategy.purchaseConditions.mode}
                  onChange={(e) =>
                    onUpdateStrategy((prev) => ({
                      ...prev,
                      purchaseConditions: {
                        ...prev.purchaseConditions,
                        mode: e.target.value as PurchaseConditionMode,
                      },
                    }))
                  }
                  className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                >
                  <option value="best_quant_edge">
                    Best Pre-Trade Quant Edge (Multi-Factor + EV Filter)
                  </option>
                  <option value="dual_zscore_digit">
                    Dual-Window Binomial Z-Score (400t/50t + Losing-Digit Lock)
                  </option>
                  <option value="always">Immediate (Every cycle)</option>
                  <option value="ema_bullish">EMA(9) &gt; EMA(21) Bullish Crossover</option>
                  <option value="ema_bearish">EMA(9) &lt; EMA(21) Bearish Crossover</option>
                  <option value="rsi_oversold">RSI(14) &lt;= 34 Oversold Rebound</option>
                  <option value="rsi_overbought">RSI(14) &gt;= 66 Overbought Pullback</option>
                  <option value="digit_pct_lte">Target digit % &lt;= threshold</option>
                  <option value="digit_pct_gte">Target digit % &gt;= threshold</option>
                  <option value="even_streak_gte">Even streak &gt;= N ticks</option>
                  <option value="odd_streak_gte">Odd streak &gt;= N ticks</option>
                  <option value="trend_up">Spot price rising (4-tick momentum)</option>
                  <option value="trend_down">Spot price falling (4-tick momentum)</option>
                </select>

                {strategy.purchaseConditions.mode === 'dual_zscore_digit' && (
                  <div className="w-full flex flex-wrap items-center gap-3 pt-1.5 mt-1 border-t border-slate-300/60 dark:border-slate-600/70">
                    <div className="flex items-center gap-1">
                      <span>Z-Threshold &lt;=:</span>
                      <input
                        type="number"
                        step="0.1"
                        max={0}
                        min={-4}
                        value={strategy.purchaseConditions.dualZScoreThreshold ?? -1.6}
                        onChange={(e) =>
                          onUpdateStrategy((prev) => ({
                            ...prev,
                            purchaseConditions: {
                              ...prev.purchaseConditions,
                              dualZScoreThreshold: Number(e.target.value) || -1.6,
                            },
                          }))
                        }
                        className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Trade gap (t):</span>
                      <input
                        type="number"
                        min={0}
                        max={60}
                        value={strategy.purchaseConditions.tradeGapTicks ?? 10}
                        onChange={(e) =>
                          onUpdateStrategy((prev) => ({
                            ...prev,
                            purchaseConditions: {
                              ...prev.purchaseConditions,
                              tradeGapTicks: Math.max(0, Number(e.target.value) || 0),
                            },
                          }))
                        }
                        className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Max wait (t):</span>
                      <input
                        type="number"
                        min={10}
                        max={500}
                        value={strategy.purchaseConditions.maxWaitTicks ?? 120}
                        onChange={(e) =>
                          onUpdateStrategy((prev) => ({
                            ...prev,
                            purchaseConditions: {
                              ...prev.purchaseConditions,
                              maxWaitTicks: Math.max(10, Number(e.target.value) || 120),
                            },
                          }))
                        }
                        className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Min history:</span>
                      <input
                        type="number"
                        min={50}
                        max={900}
                        value={strategy.purchaseConditions.minHistoryTicks ?? 200}
                        onChange={(e) =>
                          onUpdateStrategy((prev) => ({
                            ...prev,
                            purchaseConditions: {
                              ...prev.purchaseConditions,
                              minHistoryTicks: Math.max(50, Number(e.target.value) || 200),
                            },
                          }))
                        }
                        className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                      />
                    </div>
                  </div>
                )}

                {(strategy.purchaseConditions.mode === 'digit_pct_lte' ||
                  strategy.purchaseConditions.mode === 'digit_pct_gte') && (
                  <>
                    <span>Threshold %:</span>
                    <input
                      type="number"
                      min={1}
                      max={95}
                      value={strategy.purchaseConditions.thresholdPct}
                      onChange={(e) =>
                        onUpdateStrategy((prev) => ({
                          ...prev,
                          purchaseConditions: {
                            ...prev.purchaseConditions,
                            thresholdPct: Math.max(1, Number(e.target.value) || 10),
                          },
                        }))
                      }
                      className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                    />
                  </>
                )}

                {(strategy.purchaseConditions.mode === 'even_streak_gte' ||
                  strategy.purchaseConditions.mode === 'odd_streak_gte') && (
                  <>
                    <span>Streak length:</span>
                    <input
                      type="number"
                      min={2}
                      max={10}
                      value={strategy.purchaseConditions.streakLength}
                      onChange={(e) =>
                        onUpdateStrategy((prev) => ({
                          ...prev,
                          purchaseConditions: {
                            ...prev.purchaseConditions,
                            streakLength: Math.max(2, Number(e.target.value) || 3),
                          },
                        }))
                      }
                      className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                    />
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600 w-fit">
                {strategy.tradeParams.tradeCategory === 'Multipliers' ? (
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">Multiplier:</span>
                    <select
                      value={strategy.purchaseConditions.multiplier || 100}
                      onChange={(e) =>
                        onUpdateStrategy((prev) => ({
                          ...prev,
                          purchaseConditions: {
                            ...prev.purchaseConditions,
                            multiplier: Number(e.target.value) || 100,
                          },
                        }))
                      }
                      className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-mono font-bold"
                    >
                      {[20, 40, 50, 100, 200, 300, 500].map((m) => (
                        <option key={m} value={m}>
                          x{m}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">Duration:</span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={strategy.purchaseConditions.durationTicks}
                      onChange={(e) =>
                        onUpdateStrategy((prev) => ({
                          ...prev,
                          purchaseConditions: {
                            ...prev.purchaseConditions,
                            durationTicks: Math.min(365, Math.max(1, Number(e.target.value) || 1)),
                          },
                        }))
                      }
                      className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono font-semibold tabular-nums text-center"
                    />
                    <select
                      value={strategy.purchaseConditions.durationUnit || 't'}
                      onChange={(e) =>
                        onUpdateStrategy((prev) => ({
                          ...prev,
                          purchaseConditions: {
                            ...prev.purchaseConditions,
                            durationUnit: e.target.value as DurationUnit,
                          },
                        }))
                      }
                      className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-medium"
                    >
                      <option value="t">Ticks</option>
                      <option value="s">Seconds</option>
                      <option value="m">Minutes</option>
                      <option value="h">Hours</option>
                      <option value="d">Days</option>
                    </select>
                  </div>
                )}

                {strategy.tradeParams.tradeCategory === 'Digits' && (
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">Prediction digit:</span>
                    <select
                      value={strategy.purchaseConditions.predictionDigit}
                      onChange={(e) =>
                        onUpdateStrategy((prev) => ({
                          ...prev,
                          purchaseConditions: {
                            ...prev.purchaseConditions,
                            predictionDigit: Number(e.target.value),
                          },
                        }))
                      }
                      className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2.5 py-0.5 text-xs font-mono font-bold"
                    >
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Pre-Trade Profitability Filter & Capital Protection Strip */}
              <div className="bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-2 rounded border border-slate-300/80 dark:border-slate-600 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 font-semibold cursor-pointer text-[#0F766E] dark:text-teal-300">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <input
                      type="checkbox"
                      checked={preCfg.enabled}
                      onChange={(e) => updatePreTrade('enabled', e.target.checked)}
                      className="rounded border-slate-400 text-[#0F766E]"
                    />
                    <span>Pre-trade profitability gate</span>
                  </label>

                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={preCfg.autoSelectBestContract}
                      onChange={(e) =>
                        updatePreTrade('autoSelectBestContract', e.target.checked)
                      }
                      className="rounded border-slate-400 text-[#0E5A78]"
                    />
                    <span>Auto-select best EV contract/digit</span>
                  </label>

                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={preCfg.requireConfluence}
                      onChange={(e) =>
                        updatePreTrade('requireConfluence', e.target.checked)
                      }
                      className="rounded border-slate-400 text-[#0E5A78]"
                    />
                    <span>Require positive EV%</span>
                  </label>
                </div>

                {preCfg.enabled && (
                  <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-300/60 dark:border-slate-600/70">
                    <div className="flex items-center gap-1">
                      <span>Min Confidence %:</span>
                      <input
                        type="number"
                        min={30}
                        max={95}
                        value={preCfg.minConfidence}
                        onChange={(e) =>
                          updatePreTrade(
                            'minConfidence',
                            Math.min(95, Math.max(30, Number(e.target.value) || 65)),
                          )
                        }
                        className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 font-mono text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Min EV %:</span>
                      <input
                        type="number"
                        step="0.5"
                        value={preCfg.minEvPct}
                        onChange={(e) =>
                          updatePreTrade('minEvPct', Number(e.target.value) || 0)
                        }
                        className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 font-mono text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Loss Cooldown (t):</span>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        value={preCfg.lossCooldownTicks}
                        onChange={(e) =>
                          updatePreTrade(
                            'lossCooldownTicks',
                            Math.max(0, Number(e.target.value) || 0),
                          )
                        }
                        className="w-12 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 font-mono text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Max Loss Streak:</span>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        value={preCfg.maxConsecutiveLosses}
                        onChange={(e) =>
                          updatePreTrade(
                            'maxConsecutiveLosses',
                            Math.max(0, Number(e.target.value) || 0),
                          )
                        }
                        className="w-12 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 font-mono text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>Profit Lock %:</span>
                      <input
                        type="number"
                        min={0}
                        max={90}
                        value={preCfg.trailingProfitLockPct}
                        onChange={(e) =>
                          updatePreTrade(
                            'trailingProfitLockPct',
                            Math.min(90, Math.max(0, Number(e.target.value) || 0)),
                          )
                        }
                        className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 font-mono text-center"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* BLOCK 4: 3. Sell & 4. Restart trading conditions */}
          <div
            id="block-restart"
            className={`rounded-md overflow-hidden shadow-sm border transition-shadow ${
              focusedBlock === 'block-restart'
                ? 'ring-2 ring-[#00A8E8] border-[#00A8E8]'
                : 'border-slate-300 dark:border-slate-700'
            }`}
          >
            <div className="bg-[#1E4E68] text-white px-3.5 py-2 flex items-center gap-2 text-xs font-semibold">
              <span>3 &amp; 4. Risk Management &amp; Restart Trading Conditions</span>
            </div>

            <div className="bg-[#DDE1E6] dark:bg-slate-800/95 p-3 space-y-2 text-xs text-slate-900 dark:text-slate-100">
              <div className="flex flex-wrap items-center gap-3 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600">
                <label className="flex items-center gap-1.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={strategy.restartConditions.useMartingale}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          useMartingale: e.target.checked,
                        },
                      }))
                    }
                    className="rounded border-slate-400 text-[#0E5A78]"
                  />
                  <span>Martingale on loss</span>
                </label>

                <div className="flex items-center gap-1.5">
                  <span>Multiplier:</span>
                  <input
                    type="number"
                    step="0.1"
                    min={1}
                    max={50}
                    value={strategy.restartConditions.martingaleMultiplier}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          martingaleMultiplier: Math.max(1, Number(e.target.value) || 2),
                        },
                      }))
                    }
                    className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>

                {strategy.restartConditions.useMartingale && (
                  <>
                    <div className="flex items-center gap-1.5">
                      <span>Stage 2x:</span>
                      <input
                        type="number"
                        step="0.5"
                        min={1}
                        max={50}
                        placeholder="Auto"
                        value={strategy.restartConditions.stage2Multiplier ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          onUpdateStrategy((prev) => ({
                            ...prev,
                            restartConditions: {
                              ...prev.restartConditions,
                              stage2Multiplier:
                                raw === '' ? undefined : Math.max(1, Number(raw) || 1),
                            },
                          }));
                        }}
                        className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span>Stage 3x:</span>
                      <input
                        type="number"
                        step="0.5"
                        min={1}
                        max={50}
                        placeholder="Auto"
                        value={strategy.restartConditions.stage3Multiplier ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          onUpdateStrategy((prev) => ({
                            ...prev,
                            restartConditions: {
                              ...prev.restartConditions,
                              stage3Multiplier:
                                raw === '' ? undefined : Math.max(1, Number(raw) || 1),
                            },
                          }));
                        }}
                        className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                      />
                    </div>
                  </>
                )}

                <div className="flex items-center gap-1.5">
                  <span>Max stake ($):</span>
                  <input
                    type="number"
                    min={1}
                    value={strategy.restartConditions.maxStake}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          maxStake: Math.max(1, Number(e.target.value) || 100),
                        },
                      }))
                    }
                    className="w-20 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600">
                <label className="flex items-center gap-1.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={Boolean(strategy.restartConditions.lockLosingDigitOnLoss)}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          lockLosingDigitOnLoss: e.target.checked,
                        },
                      }))
                    }
                    className="rounded border-slate-400 text-[#0E5A78]"
                  />
                  <span>Lock losing digit on recovery</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={Boolean(strategy.restartConditions.capStakeToRemainingStopLoss)}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          capStakeToRemainingStopLoss: e.target.checked,
                        },
                      }))
                    }
                    className="rounded border-slate-400 text-[#0E5A78]"
                  />
                  <span>Cap stake to remaining SL budget</span>
                </label>

                <div className="flex items-center gap-1.5">
                  <span>Max recovery steps (0=off):</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={strategy.restartConditions.maxRecoverySteps ?? 0}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          maxRecoverySteps: Math.min(10, Math.max(0, Number(e.target.value) || 0)),
                        },
                      }))
                    }
                    className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <span>Loss cooldown (s):</span>
                  <input
                    type="number"
                    min={0}
                    max={300}
                    value={strategy.restartConditions.lossCooldownSeconds ?? 0}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          lossCooldownSeconds: Math.min(300, Math.max(0, Number(e.target.value) || 0)),
                        },
                      }))
                    }
                    className="w-14 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600">
                <label className="flex items-center gap-1.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={Boolean(strategy.restartConditions.useFractionalBalanceRisk)}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          useFractionalBalanceRisk: e.target.checked,
                          baseRiskPct: prev.restartConditions.baseRiskPct ?? 1.5,
                        },
                      }))
                    }
                    className="rounded border-slate-400 text-[#0F766E]"
                  />
                  <span>Fractional balance risk %:</span>
                </label>
                <input
                  type="number"
                  step="0.1"
                  min={0.1}
                  max={25}
                  disabled={!strategy.restartConditions.useFractionalBalanceRisk}
                  value={strategy.restartConditions.baseRiskPct ?? 1.5}
                  onChange={(e) =>
                    onUpdateStrategy((prev) => ({
                      ...prev,
                      restartConditions: {
                        ...prev.restartConditions,
                        baseRiskPct: Math.min(25, Math.max(0.1, Number(e.target.value) || 1.5)),
                      },
                    }))
                  }
                  className="w-16 bg-white dark:bg-slate-900 disabled:opacity-50 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                />

                <label className="flex items-center gap-1.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={Boolean(strategy.restartConditions.useDailyPctLocks)}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          useDailyPctLocks: e.target.checked,
                          dailyProfitTargetPct: prev.restartConditions.dailyProfitTargetPct ?? 6,
                          dailyMaxLossPct: prev.restartConditions.dailyMaxLossPct ?? 4,
                        },
                      }))
                    }
                    className="rounded border-slate-400 text-[#0F766E]"
                  />
                  <span>Daily % locks (+TP% / -SL%):</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    max={50}
                    disabled={!strategy.restartConditions.useDailyPctLocks}
                    value={strategy.restartConditions.dailyProfitTargetPct ?? 6}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          dailyProfitTargetPct: Math.max(0.5, Number(e.target.value) || 6),
                        },
                      }))
                    }
                    className="w-14 bg-white dark:bg-slate-900 disabled:opacity-50 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                  <span className="text-slate-500">/</span>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    max={50}
                    disabled={!strategy.restartConditions.useDailyPctLocks}
                    value={strategy.restartConditions.dailyMaxLossPct ?? 4}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          dailyMaxLossPct: Math.max(0.5, Number(e.target.value) || 4),
                        },
                      }))
                    }
                    className="w-14 bg-white dark:bg-slate-900 disabled:opacity-50 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 bg-[#E6E9ED] dark:bg-slate-700/70 px-2.5 py-1.5 rounded border border-slate-300/80 dark:border-slate-600 w-fit">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">Take profit ($):</span>
                  <input
                    type="number"
                    min={1}
                    value={strategy.restartConditions.takeProfit}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          takeProfit: Math.max(1, Number(e.target.value) || 50),
                        },
                      }))
                    }
                    className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="font-medium">Stop loss ($):</span>
                  <input
                    type="number"
                    min={1}
                    value={strategy.restartConditions.stopLoss}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          stopLoss: Math.max(1, Number(e.target.value) || 100),
                        },
                      }))
                    }
                    className="w-16 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-full px-2 py-0.5 text-xs font-mono tabular-nums text-center"
                  />
                </div>

                <label className="flex items-center gap-1.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={strategy.restartConditions.tradeAgain}
                    onChange={(e) =>
                      onUpdateStrategy((prev) => ({
                        ...prev,
                        restartConditions: {
                          ...prev.restartConditions,
                          tradeAgain: e.target.checked,
                        },
                      }))
                    }
                    className="rounded border-slate-400 text-[#0E5A78]"
                  />
                  <span>Trade again</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Polyglot Strategy Code Compiler Modal */}
      {polyglotOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
                <h3 className="font-display font-bold text-sm text-slate-900 dark:text-slate-100">
                  Polyglot Strategy Compiler — {strategy.name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPolyglotOpen(false)}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 flex-1 overflow-hidden flex flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {POLYGLOT_LANGUAGES.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => setPolyglotLang(l.id)}
                      className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold cursor-pointer ${
                        polyglotLang === l.id
                          ? 'bg-[#0E5A78] text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      const code = generatePolyglotStrategyCode(strategy, polyglotLang);
                      try {
                        await navigator.clipboard.writeText(code);
                        setPolyglotCopied(true);
                        window.setTimeout(() => setPolyglotCopied(false), 1800);
                      } catch {
                        // Ignore clipboard failure
                      }
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-xs font-semibold cursor-pointer"
                  >
                    {polyglotCopied ? <Check className="w-3.5 h-3.5 text-teal-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{polyglotCopied ? 'Copied' : 'Copy'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const code = generatePolyglotStrategyCode(strategy, polyglotLang);
                      const ext = POLYGLOT_LANGUAGES.find((l) => l.id === polyglotLang)?.extension ?? 'txt';
                      const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${strategy.id || 'deriv-bot'}.${ext}`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#389E94] hover:bg-[#2F877E] text-white text-xs font-semibold cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export File</span>
                  </button>
                </div>
              </div>
              <pre className="flex-1 min-h-[280px] overflow-auto studio-scroll rounded bg-slate-950 text-slate-100 p-3.5 font-mono text-[11px] leading-relaxed">
                <code>{generatePolyglotStrategyCode(strategy, polyglotLang)}</code>
              </pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
