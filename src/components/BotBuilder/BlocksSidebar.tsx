import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';
import type { BotStrategyConfig } from '../../shared/types.ts';

interface BlocksSidebarProps {
  strategy: BotStrategyConfig;
  onFocusBlock: (blockId: string) => void;
  onQuickAction: (action: string) => void;
  onOpenQuickStrategy: () => void;
  onOpenAiBuilder: () => void;
}

interface MenuSection {
  id: string;
  label: string;
  targetBlock?: string;
  children?: { id: string; label: string; action: string }[];
}

const MENU_SECTIONS: MenuSection[] = [
  { id: 'trade-params', label: 'Trade parameters', targetBlock: 'block-trade-params' },
  { id: 'purchase', label: 'Purchase conditions', targetBlock: 'block-purchase' },
  { id: 'sell', label: 'Sell conditions (optional)', targetBlock: 'block-restart' },
  { id: 'restart', label: 'Restart trading conditions', targetBlock: 'block-restart' },
  {
    id: 'analysis',
    label: 'Analysis',
    children: [
      { id: 'an-best-quant', label: 'Best Pre-Trade Quant Gate', action: 'mode:best_quant_edge' },
      { id: 'an-dual-z', label: 'Dual-Window Z-Score (-1.6)', action: 'mode:dual_zscore_digit' },
      { id: 'an-ema-bull', label: 'EMA(9) > EMA(21) Bullish', action: 'mode:ema_bullish' },
      { id: 'an-ema-bear', label: 'EMA(9) < EMA(21) Bearish', action: 'mode:ema_bearish' },
      { id: 'an-rsi-low', label: 'RSI(14) <= 34 Oversold', action: 'mode:rsi_oversold' },
      { id: 'an-rsi-high', label: 'RSI(14) >= 66 Overbought', action: 'mode:rsi_overbought' },
      { id: 'an-digit-lt', label: 'Digit % <= threshold', action: 'mode:digit_pct_lte' },
      { id: 'an-digit-gt', label: 'Digit % >= threshold', action: 'mode:digit_pct_gte' },
      { id: 'an-even-streak', label: 'Even streak trigger', action: 'mode:even_streak_gte' },
      { id: 'an-odd-streak', label: 'Odd streak trigger', action: 'mode:odd_streak_gte' },
    ],
  },
  {
    id: 'utility',
    label: 'Utility',
    children: [
      { id: 'ut-add-var', label: 'Add custom variable', action: 'add:variable' },
      { id: 'ut-always', label: 'Immediate entry mode', action: 'mode:always' },
      { id: 'ut-trend-up', label: 'Momentum up trigger', action: 'mode:trend_up' },
    ],
  },
  { id: 'modifiers', label: 'Contract modifiers', targetBlock: 'block-purchase' },
  {
    id: 'additional',
    label: 'Additional blocks',
    children: [
      { id: 'add-martingale', label: 'Enable Martingale (2.1x)', action: 'preset:martingale' },
      { id: 'add-flat', label: 'Flat stake (no Martingale)', action: 'preset:flat' },
      { id: 'add-fast', label: 'Toggle Fast trades', action: 'toggle:fastTrades' },
    ],
  },
];

export function BlocksSidebar({
  onFocusBlock,
  onQuickAction,
  onOpenQuickStrategy,
  onOpenAiBuilder,
}: BlocksSidebarProps) {
  const [menuOpen, setMenuOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const filteredSections = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return MENU_SECTIONS;
    return MENU_SECTIONS.filter((sec) => {
      if (sec.label.toLowerCase().includes(q)) return true;
      return sec.children?.some((c) => c.label.toLowerCase().includes(q));
    });
  }, [search]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <aside className="w-[248px] shrink-0 bg-white dark:bg-[#0F172A] border-r border-slate-200 dark:border-slate-800 flex flex-col min-h-0 relative select-none">
      {/* Top Quick Strategy & XML Upload Buttons */}
      <div className="p-3 border-b border-slate-100 dark:border-slate-800 space-y-2">
        <button
          type="button"
          onClick={onOpenQuickStrategy}
          className="w-full py-2.5 px-4 rounded-md bg-[#00A8E8] hover:bg-[#0092CA] text-white text-sm font-semibold shadow-sm transition-colors whitespace-nowrap cursor-pointer"
        >
          Quick strategy
        </button>
        <button
          type="button"
          onClick={() => onQuickAction('upload:xml')}
          className="w-full py-1.5 px-3 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
          <span>Upload XML / JSON Bot</span>
        </button>
      </div>

      {/* Blocks Menu Header & Search */}
      <div className="flex-1 min-h-0 flex flex-col">
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="w-full px-4 py-3 flex items-center justify-between text-sm font-bold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
        >
          <span>Blocks menu</span>
          {menuOpen ? (
            <ChevronUp className="w-4 h-4 text-slate-500" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-500" />
          )}
        </button>

        {menuOpen && (
          <div className="flex-1 min-h-0 flex flex-col px-3 pb-16">
            <div className="relative mb-2.5">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
              />
            </div>

            <div className="flex-1 overflow-y-auto studio-scroll divide-y divide-slate-100 dark:divide-slate-800/70">
              {filteredSections.map((section) => {
                const hasChildren = Boolean(section.children?.length);
                const isExpanded = Boolean(expandedIds[section.id]) || Boolean(search.trim());
                return (
                  <div key={section.id} className="py-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (hasChildren) {
                          toggleExpand(section.id);
                        } else if (section.targetBlock) {
                          onFocusBlock(section.targetBlock);
                        }
                      }}
                      className="w-full px-2 py-2.5 flex items-center justify-between text-left text-[13px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded transition-colors cursor-pointer"
                    >
                      <span className="truncate">{section.label}</span>
                      {hasChildren && (
                        <ChevronDown
                          className={`w-4 h-4 text-slate-500 transition-transform ${
                            isExpanded ? 'rotate-180' : ''
                          }`}
                        />
                      )}
                    </button>

                    {hasChildren && isExpanded && section.children && (
                      <div className="pl-2 pb-1.5 space-y-1">
                        {section.children.map((child) => (
                          <button
                            key={child.id}
                            type="button"
                            onClick={() => onQuickAction(child.action)}
                            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40 rounded transition-colors text-left cursor-pointer"
                          >
                            <Plus className="w-3 h-3 shrink-0 text-sky-600 dark:text-sky-400" />
                            <span className="truncate">{child.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredSections.length === 0 && (
                <div className="py-6 text-center text-xs text-slate-400">
                  No matching blocks
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Floating AI Bot Builder Pill Button */}
      <div className="absolute bottom-3 left-3 right-3 pointer-events-none flex justify-start">
        <button
          type="button"
          onClick={onOpenAiBuilder}
          className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-semibold shadow-md transition-transform active:scale-95 cursor-pointer whitespace-nowrap"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>AI Bot Builder</span>
        </button>
      </div>
    </aside>
  );
}
