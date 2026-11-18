import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  error: Error | null;
}

function formatErrorMessage(raw: string): { headline: string; detail: string } {
  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      operationType?: string;
      path?: string | null;
    };
    if (parsed && parsed.operationType) {
      return {
        headline: 'Cloud Sync Permission or Network Guard',
        detail: `${parsed.error || 'Operation denied'} (${parsed.operationType}${parsed.path ? ` on ${parsed.path}` : ''})`,
      };
    }
  } catch {
    // Plain error string
  }
  return {
    headline: 'Workspace Recovery',
    detail: raw || 'An unexpected rendering error occurred.',
  };
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('DerivDesk ErrorBoundary:', error, info);
  }

  render() {
    if (this.state.error) {
      const formatted = formatErrorMessage(this.state.error.message);
      return (
        <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 dark:bg-[#090D16] p-6 text-slate-900 dark:text-slate-100">
          <div className="max-w-md w-full rounded-lg border border-rose-200 dark:border-rose-900 bg-white dark:bg-[#0F172A] p-6 shadow-lg space-y-4">
            <div className="flex items-center gap-2.5 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h1 className="font-display font-bold text-base">{formatted.headline}</h1>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">
              {formatted.detail}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold cursor-pointer"
              >
                Dismiss &amp; Continue
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#0E5A78] hover:bg-[#0B4861] text-white text-xs font-semibold cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reload Workspace</span>
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
