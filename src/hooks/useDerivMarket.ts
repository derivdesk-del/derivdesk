import { useEffect, useMemo, useRef, useState } from 'react';
import { derivFetch, parseJsonResponse } from '../lib/derivClient.ts';
import {
  DERIV_MARKETS,
  type FeedStatus,
  type MarketSymbol,
  type ServerWsMessage,
  type TickPoint,
} from '../shared/types.ts';

export interface DigitStat {
  digit: number;
  count: number;
  pct: number;
  isHot: boolean;
  isCold: boolean;
}

export function useDerivMarket(symbol: string) {
  const [markets, setMarkets] = useState<MarketSymbol[]>(DERIV_MARKETS);
  const [ticks, setTicks] = useState<TickPoint[]>([]);
  const [feedStatus, setFeedStatus] = useState<FeedStatus>({
    connected: false,
    source: 'deriv-ws',
    accountMode: 'demo',
    authorizedLoginId: null,
    lastError: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    let active = true;
    const loadMarkets = async () => {
      try {
        const res = await derivFetch('/api/deriv/markets');
        if (res.ok && active) {
          const data = await parseJsonResponse<{ markets?: MarketSymbol[] }>(res);
          if (Array.isArray(data.markets) && data.markets.length > 0) {
            setMarkets(data.markets);
          }
        }
      } catch {
        // Keep built-in market list
      }
    };
    loadMarkets();
    const refresh = window.setTimeout(loadMarkets, 3000);
    return () => {
      active = false;
      window.clearTimeout(refresh);
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (closed) return;
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
        wsRef.current = ws;

        ws.onopen = () => {
          try {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: symbolRef.current }));
          } catch {
            // Ignore transient send error
          }
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as ServerWsMessage;
            if (msg.type === 'feed:status') {
              setFeedStatus(msg.status);
            } else if (msg.type === 'history') {
              if (msg.symbol === symbolRef.current) {
                setTicks(msg.ticks.slice(-1000));
              }
            } else if (msg.type === 'tick') {
              if (msg.tick.symbol === symbolRef.current) {
                setTicks((prev) => {
                  const next = [...prev, msg.tick];
                  return next.length > 1000 ? next.slice(-1000) : next;
                });
              }
            }
          } catch {
            // Ignore invalid JSON
          }
        };

        ws.onerror = () => {
          ws.close();
        };

        ws.onclose = () => {
          setFeedStatus((prev) => ({ ...prev, connected: false }));
          if (!closed) {
            reconnectTimer = window.setTimeout(connect, 2000);
          }
        };
      } catch {
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      }
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    setTicks([]);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', symbol }));
      } catch {
        // Ignore transient send error
      }
    }
  }, [symbol]);

  const latestTick = ticks.length > 0 ? ticks[ticks.length - 1] : null;
  const previousTick = ticks.length > 1 ? ticks[ticks.length - 2] : null;

  const computeDigitStats = useMemo(() => {
    return (sampleSize: number): DigitStat[] => {
      const slice = ticks.slice(-sampleSize);
      const counts = Array.from({ length: 10 }, () => 0);
      for (const t of slice) {
        counts[t.lastDigit] = (counts[t.lastDigit] || 0) + 1;
      }
      const total = slice.length || 1;
      const pcts = counts.map((c) => Number(((c / total) * 100).toFixed(1)));
      const maxPct = Math.max(...pcts);
      const minPct = Math.min(...pcts);
      return counts.map((count, digit) => ({
        digit,
        count,
        pct: pcts[digit],
        isHot: pcts[digit] === maxPct && slice.length > 0,
        isCold: pcts[digit] === minPct && slice.length > 0,
      }));
    };
  }, [ticks]);

  return {
    markets,
    ticks,
    latestTick,
    previousTick,
    feedStatus,
    computeDigitStats,
  };
}
