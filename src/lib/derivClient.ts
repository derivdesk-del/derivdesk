import type { DerivAuthSession } from '../shared/types.ts';

const SESSION_KEY = 'derivdesk_sid';
let memorySessionId: string | null = null;

export function getDerivSessionId(): string | null {
  if (memorySessionId) return memorySessionId;
  try {
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      memorySessionId = stored;
      return stored;
    }
  } catch {
    // Ignore storage restriction
  }
  return null;
}

export function setDerivSessionId(sid: string | null | undefined): void {
  memorySessionId = sid || null;
  try {
    if (sid) {
      window.sessionStorage.setItem(SESSION_KEY, sid);
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Ignore storage restriction
  }
}

export function syncDerivSession(session: DerivAuthSession): DerivAuthSession {
  if (session.authenticated && session.sessionId) {
    setDerivSessionId(session.sessionId);
  } else if (!session.authenticated) {
    setDerivSessionId(null);
  }
  return session;
}

export async function derivFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const sid = getDerivSessionId();
  if (sid && !headers.has('X-Deriv-Session')) {
    headers.set('X-Deriv-Session', sid);
  }
  const method = (init.method || 'GET').toUpperCase();
  const reqInit: RequestInit = {
    ...init,
    credentials: 'include',
    headers,
  };
  const res = await fetch(input, reqInit);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (method === 'GET' && input.startsWith('/api/') && contentType.includes('text/html')) {
    await new Promise((r) => window.setTimeout(r, 600));
    return fetch(input, reqInit);
  }
  return res;
}

export async function parseJsonResponse<T = Record<string, unknown>>(
  res: Response,
  fallbackError = `Request failed (${res.status})`,
): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (
    contentType.includes('text/html') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<')
  ) {
    throw new Error(
      `Server returned an HTML page (HTTP ${res.status || 502}) instead of JSON. Please wait a moment and try again.`,
    );
  }

  if (!trimmed) {
    if (!res.ok) {
      throw new Error(fallbackError);
    }
    return {} as T;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      res.ok ? 'Server returned malformed JSON.' : fallbackError,
    );
  }
}

export async function tryParseJsonResponse<T = Record<string, unknown>>(
  res: Response,
): Promise<T | null> {
  try {
    return await parseJsonResponse<T>(res);
  } catch {
    return null;
  }
}

export interface DerivOAuthAccountParam {
  accountId: string;
  token: string;
  currency: string;
}

export function extractDerivOAuthAccountsFromUrl(
  search: string = window.location.search,
): DerivOAuthAccountParam[] {
  const params = new URLSearchParams(search);
  const accounts: DerivOAuthAccountParam[] = [];
  for (let i = 1; i <= 20; i++) {
    const accountId = params.get(`acct${i}`)?.trim();
    const token = params.get(`token${i}`)?.trim();
    const currency = params.get(`cur${i}`)?.trim() || 'USD';
    if (accountId && token) {
      accounts.push({ accountId, token, currency });
    }
  }
  return accounts;
}

