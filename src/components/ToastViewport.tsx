import { AlertTriangle, CheckCircle2, ShieldAlert, X, Zap } from 'lucide-react';
import type { AppToast, ToastVariant } from '../shared/types.ts';

interface ToastViewportProps {
  toasts: AppToast[];
  onDismiss: (id: string) => void;
  onClearAll: () => void;
}

const VARIANT_STYLES: Record<
  ToastVariant,
  {
    container: string;
    iconWrap: string;
    label: string;
    labelText: string;
  }
> = {
  info: {
    container:
      'bg-white/95 dark:bg-[#0F172A]/95 border-slate-200 dark:border-slate-800',
    iconWrap:
      'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 border border-sky-200/80 dark:border-sky-800/70',
    label: 'text-sky-700 dark:text-sky-300',
    labelText: 'Execution',
  },
  success: {
    container:
      'bg-white/95 dark:bg-[#0F172A]/95 border-emerald-200 dark:border-emerald-900/70',
    iconWrap:
      'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800/70',
    label: 'text-emerald-700 dark:text-emerald-300',
    labelText: 'Settled',
  },
  warning: {
    container:
      'bg-white/95 dark:bg-[#0F172A]/95 border-amber-200 dark:border-amber-900/70',
    iconWrap:
      'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200/80 dark:border-amber-800/70',
    label: 'text-amber-700 dark:text-amber-300',
    labelText: 'Risk Notice',
  },
  error: {
    container:
      'bg-white/95 dark:bg-[#0F172A]/95 border-rose-300 dark:border-rose-900/80',
    iconWrap:
      'bg-rose-50 dark:bg-rose-950/70 text-rose-600 dark:text-rose-400 border border-rose-200/80 dark:border-rose-800/70',
    label: 'text-rose-700 dark:text-rose-300',
    labelText: 'Threshold Alert',
  },
};

function ToastIcon({ variant }: { variant: ToastVariant }) {
  switch (variant) {
    case 'success':
      return <CheckCircle2 className="w-4 h-4" />;
    case 'warning':
      return <AlertTriangle className="w-4 h-4" />;
    case 'error':
      return <ShieldAlert className="w-4 h-4" />;
    default:
      return <Zap className="w-4 h-4" />;
  }
}

export function ToastViewport({
  toasts,
  onDismiss,
  onClearAll,
}: ToastViewportProps) {
  if (toasts.length === 0) return null;

  return (
    <section
      aria-label="Real-time trading notifications"
      className="fixed bottom-9 right-4 z-50 flex flex-col gap-2 w-80 sm:w-96 max-w-[calc(100vw-2rem)] pointer-events-none"
    >
      {toasts.length >= 2 && (
        <div className="flex justify-end pointer-events-auto">
          <button
            type="button"
            onClick={onClearAll}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/95 dark:bg-[#0F172A]/95 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white shadow-sm transition-colors cursor-pointer"
          >
            Clear all ({toasts.length})
          </button>
        </div>
      )}

      {toasts.map((toast) => {
        const style = VARIANT_STYLES[toast.variant];
        const isAssertive = toast.variant === 'error';
        const timeStr = new Date(toast.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        return (
          <div
            key={toast.id}
            role={isAssertive ? 'alert' : 'status'}
            aria-live={isAssertive ? 'assertive' : 'polite'}
            className={`pointer-events-auto rounded-lg border shadow-md backdrop-blur-sm p-3 transition-all duration-150 ${style.container}`}
          >
            <div className="flex items-start gap-2.5">
              <div
                className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${style.iconWrap}`}
              >
                <ToastIcon variant={toast.variant} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[11px] font-semibold tracking-tight ${style.label}`}
                  >
                    {style.labelText}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-slate-400 dark:text-slate-500">
                    {timeStr}
                  </span>
                </div>

                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 mt-0.5 leading-snug">
                  {toast.title}
                </p>

                <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5 leading-snug break-words">
                  {toast.message}
                </p>

                {toast.meta && (
                  <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800/80 truncate">
                    {toast.meta}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                aria-label={`Dismiss ${toast.title}`}
                className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
