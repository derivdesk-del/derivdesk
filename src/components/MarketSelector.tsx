import { useMemo } from 'react';
import type { MarketSymbol } from '../shared/types.ts';

interface MarketSelectorProps {
  markets: MarketSymbol[];
  value: string;
  onChange: (symbol: string) => void;
  className?: string;
  digitsOnly?: boolean;
}

export function MarketSelector({
  markets,
  value,
  onChange,
  className = '',
  digitsOnly = false,
}: MarketSelectorProps) {
  const groups = useMemo(() => {
    const filtered = digitsOnly
      ? markets.filter((m) => m.supportsDigits !== false)
      : markets;
    const map = new Map<string, MarketSymbol[]>();
    for (const m of filtered) {
      const label = `${m.marketGroup} · ${m.subGroup}`;
      const list = map.get(label) ?? [];
      list.push(m);
      map.set(label, list);
    }
    return Array.from(map.entries());
  }, [digitsOnly, markets]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        className ||
        'rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100'
      }
    >
      {groups.map(([groupLabel, items]) => (
        <optgroup key={groupLabel} label={groupLabel}>
          {items.map((m) => (
            <option key={m.symbol} value={m.symbol}>
              {m.name} ({m.symbol}){m.exchangeOpen === false ? ' [Closed]' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
