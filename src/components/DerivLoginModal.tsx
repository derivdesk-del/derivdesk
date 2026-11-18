import { useMemo, useState } from 'react';
import {
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  derivFetch,
  extractDerivOAuthAccountsFromUrl,
  parseJsonResponse,
  syncDerivSession,
} from '../lib/derivClient.ts';
import type { DerivAuthSession } from '../shared/types.ts';

interface DerivLoginModalProps {
  open: boolean;
  appId: string;
  onClose: () => void;
  onSuccess: (session: DerivAuthSession) => void;
}

export function DerivLoginModal({
  open,
  appId,
  onClose,
  onSuccess,
}: DerivLoginModalProps) {
  const defaultNumericAppId = useMemo(() => {
    const envOAuthId = (import.meta.env?.VITE_DERIV_OAUTH_APP_ID as string | undefined) || '';
    if (/^\d+$/.test(envOAuthId.trim())) return envOAuthId.trim();
    if (/^\d+$/.test(appId.trim())) return appId.trim();
    return '';
  }, [appId]);

  const [authMethod, setAuthMethod] = useState<'token' | 'oauth'>('token');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [oauthAppId, setOauthAppId] = useState(defaultNumericAppId);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const oauthAuthorizeUrl = /^\d+$/.test(oauthAppId.trim())
    ? `https://oauth.deriv.com/oauth2/authorize?app_id=${encodeURIComponent(oauthAppId.trim())}&l=EN&brand=deriv`
    : '';

  const handleTokenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = token.trim();
    if (!cleaned) {
      setError('Please enter your Deriv API token.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await derivFetch('/api/deriv/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleaned }),
      });
      const data = await parseJsonResponse<DerivAuthSession & { error?: string }>(
        res,
        'Could not authenticate with Deriv.',
      );
      if (!res.ok) {
        setError(data.error || 'Could not authenticate with Deriv.');
      } else {
        setToken('');
        onSuccess(syncDerivSession(data as DerivAuthSession));
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthCallbackImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = callbackUrl.trim();
    if (!raw) {
      setError('Paste the Deriv OAuth redirect URL (with ?acct1=...&token1=...).');
      return;
    }
    const queryPart = raw.includes('?') ? `?${raw.split('?').slice(1).join('?')}` : `?${raw}`;
    const accounts = extractDerivOAuthAccountsFromUrl(queryPart);
    if (accounts.length === 0) {
      setError('No acct1/token1 parameters found in that redirect URL.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await derivFetch('/api/deriv/oauth-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts }),
      });
      const data = await parseJsonResponse<DerivAuthSession & { error?: string }>(
        res,
        'OAuth authentication failed.',
      );
      if (!res.ok) {
        setError(data.error || 'OAuth authentication failed.');
      } else {
        setCallbackUrl('');
        onSuccess(syncDerivSession(data as DerivAuthSession));
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg bg-white dark:bg-[#0F172A] border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#0E5A78] dark:text-[#00A8E8]" />
            <h2 className="font-display font-bold text-base text-slate-900 dark:text-slate-100">
              Sign in to Deriv Account
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Auth Method Switcher */}
        <div className="px-5 pt-4">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-slate-100 dark:bg-slate-900 text-xs">
            <button
              type="button"
              onClick={() => {
                setAuthMethod('token');
                setError(null);
              }}
              className={`py-1.5 rounded font-semibold cursor-pointer ${
                authMethod === 'token'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500'
              }`}
            >
              API Token / PAT
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMethod('oauth');
                setError(null);
              }}
              className={`py-1.5 rounded font-semibold cursor-pointer ${
                authMethod === 'oauth'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500'
              }`}
            >
              Deriv OAuth Multi-Account
            </button>
          </div>
        </div>

        {authMethod === 'token' ? (
          <form onSubmit={handleTokenSubmit} className="p-5 space-y-4 text-xs">
            <div className="p-3 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
              <div className="text-slate-600 dark:text-slate-300 leading-relaxed">
                Authenticates server-side via App ID{' '}
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {appId}
                </span>
                . Your token is held only in an HTTP-only server session and never stored in browser storage.
              </div>
            </div>

            <div>
              <label
                htmlFor="deriv-api-token-input"
                className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                Deriv API Token or Personal Access Token (Read &amp; Trade scopes)
              </label>
              <div className="relative">
                <input
                  id="deriv-api-token-input"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste your Deriv API token..."
                  className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-3 pr-9 py-2.5 font-mono text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00A8E8]/50"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !token.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#389E94] hover:bg-[#2F877E] disabled:opacity-50 text-white font-bold cursor-pointer"
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{loading ? 'Connecting...' : 'Log in to Deriv'}</span>
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleOAuthCallbackImport} className="p-5 space-y-4 text-xs">
            <div className="p-3 rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2">
              <div className="text-slate-600 dark:text-slate-300 leading-relaxed">
                Launch Deriv OAuth using your numeric Deriv Developer App ID (whose Redirect URL points to this app), or paste the callback URL below to connect all Demo &amp; Real accounts at once.
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={oauthAppId}
                  onChange={(e) => setOauthAppId(e.target.value)}
                  placeholder="Numeric OAuth App ID (e.g. 61234)"
                  className="flex-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 font-mono text-xs"
                />
                {oauthAuthorizeUrl ? (
                  <a
                    href={oauthAuthorizeUrl}
                    target="_top"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[#0E5A78] hover:bg-[#0B4861] text-white font-bold whitespace-nowrap"
                  >
                    <span>Authorize</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                ) : (
                  <span className="px-2.5 py-1.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-500 font-semibold">
                    Enter App ID
                  </span>
                )}
              </div>
            </div>

            <div>
              <label
                htmlFor="deriv-oauth-callback-input"
                className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
              >
                <Link2 className="w-3.5 h-3.5 text-[#0E5A78] dark:text-[#00A8E8]" />
                <span>OAuth Redirect URL / Params (?acct1=...&amp;token1=...)</span>
              </label>
              <input
                id="deriv-oauth-callback-input"
                type="text"
                autoComplete="off"
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="https://...?acct1=VRTC...&token1=a1-...&cur1=USD"
                className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 font-mono text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#00A8E8]/50"
              />
            </div>

            {error && (
              <div className="p-3 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !callbackUrl.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#389E94] hover:bg-[#2F877E] disabled:opacity-50 text-white font-bold cursor-pointer"
              >
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{loading ? 'Importing...' : 'Complete OAuth Login'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
