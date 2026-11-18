import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppToast, AppToastInput } from '../shared/types.ts';

const MAX_VISIBLE_TOASTS = 4;

export function useToasts() {
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const existingTimer = timersRef.current.get(id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const notify = useCallback((input: AppToastInput) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const isCritical = input.variant === 'error' || input.variant === 'warning';
    const defaultDuration = isCritical ? 9500 : 4200;
    const durationMs = input.durationMs ?? defaultDuration;
    const toast: AppToast = {
      ...input,
      id,
      createdAt: now,
    };

    setToasts((prev) => {
      const filtered = input.dedupeKey
        ? prev.filter((t) => {
            if (t.dedupeKey !== input.dedupeKey) return true;
            const timerId = timersRef.current.get(t.id);
            if (timerId !== undefined) {
              window.clearTimeout(timerId);
              timersRef.current.delete(t.id);
            }
            return false;
          })
        : prev;

      const next = [...filtered, toast];
      while (next.length > MAX_VISIBLE_TOASTS) {
        // Prefer pruning oldest non-persistent info/success toast before dropping critical alerts
        const pruneIdx = next.findIndex(
          (t, idx) =>
            idx < next.length - 1 &&
            !t.persistent &&
            (t.variant === 'info' || t.variant === 'success'),
        );
        const dropIdx = pruneIdx >= 0 ? pruneIdx : 0;
        const [removed] = next.splice(dropIdx, 1);
        if (removed) {
          const timerId = timersRef.current.get(removed.id);
          if (timerId !== undefined) {
            window.clearTimeout(timerId);
            timersRef.current.delete(removed.id);
          }
        }
      }
      return next;
    });

    if (!input.persistent && durationMs > 0) {
      const timerId = window.setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, durationMs);
      timersRef.current.set(id, timerId);
    }

    return id;
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  return {
    toasts,
    notify,
    dismissToast,
    clearToasts,
  };
}
