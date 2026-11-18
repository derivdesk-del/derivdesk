import {
  Activity,
  BarChart3,
  Bot,
  Box,
  Briefcase,
  CircleDot,
  LayoutDashboard,
  Layers,
  LineChart,
  Puzzle,
  Scale,
  Sparkles,
} from 'lucide-react';
import type { MainTabId } from '../shared/types.ts';

interface NavTabsProps {
  activeTab: MainTabId;
  onSelectTab: (tab: MainTabId) => void;
}

const NAV_ITEMS: { id: MainTabId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'bulk-trader', label: 'Bulk Trader', icon: Layers },
  { id: 'bot-builder', label: 'Bot Builder', icon: Puzzle },
  { id: 'freebots', label: 'Freebots & strategies', icon: Bot },
  { id: 'dtrader-circles', label: 'Dtrader / Circles', icon: CircleDot },
  { id: 'hedging-beast', label: 'Hedging Beast', icon: Scale },
  { id: 'ai-analysis', label: 'AI Auto Analysis', icon: Sparkles },
  { id: 'trading-view', label: 'Trading View', icon: LineChart },
  { id: 'analysis-tool', label: 'Analysis tool', icon: BarChart3 },
  { id: 'quant-3d', label: '3D Quant Arena', icon: Box },
  { id: 'deriv-services', label: 'Deriv Services', icon: Briefcase },
];

export function NavTabs({ activeTab, onSelectTab }: NavTabsProps) {
  return (
    <nav
      aria-label="Workspace navigation"
      className="h-[42px] shrink-0 bg-slate-100/90 dark:bg-[#0B1120] border-b border-slate-200 dark:border-slate-800 px-3 flex items-end gap-1 overflow-x-auto studio-scroll select-none"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelectTab(item.id)}
            className={`flex items-center gap-2 px-3.5 py-2 text-xs rounded-t-md transition-colors whitespace-nowrap shrink-0 cursor-pointer border-t border-x ${
              isActive
                ? 'bg-white dark:bg-[#0F172A] text-slate-900 dark:text-slate-100 font-semibold border-slate-200 dark:border-slate-700 -mb-px pb-[9px]'
                : 'bg-transparent border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 font-medium'
            }`}
          >
            <Icon
              className={`w-3.5 h-3.5 ${
                isActive
                  ? 'text-[#00A8E8]'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            />
            <span>{item.label}</span>
          </button>
        );
      })}
      <div className="ml-auto hidden xl:flex items-center gap-1.5 pb-2 pr-1 text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
        <Activity className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
        <span>Live Options Workspace</span>
      </div>
    </nav>
  );
}
