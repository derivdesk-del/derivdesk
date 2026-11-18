import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  analyzeMarketTicks,
  computeLocalRegimeFilter,
  computeMarkovTransitionSurvival,
  evaluateDtraderPerfectSetup,
  evaluatePreTradeGate,
} from './src/lib/marketAnalysis.ts';
import {
  DEFAULT_BOT_STRATEGY,
  DEFAULT_PRETRADE_ANALYSIS,
  DERIV_MARKETS,
  type AiAnalysisResult,
  type AiScannerSignal,
  type BotStrategyConfig,
  type ClientWsMessage,
  type ContractTypeOption,
  type DerivAccountInfo,
  type DerivAuthSession,
  type DurationUnit,
  type FeedStatus,
  type MarketGroup,
  type MarketScanOpportunity,
  type MarketSymbol,
  type ServerWsMessage,
  type TickPoint,
} from './src/shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DERIV_APP_ID = process.env.DERIV_APP_ID?.trim() || '34RXuPGgdUNCTWhsYjRcD';
const ENV_DERIV_API_TOKEN = process.env.DERIV_API_TOKEN?.trim() || '';
const ALLOW_REAL_TRADING = process.env.ALLOW_REAL_TRADING === 'true';
const DERIV_API_BASE = 'https://api.derivws.com/trading/v1/options';

interface UserDerivSession {
  sid: string;
  token: string;
  protocol: 'v1-pat' | 'v3-ws';
  accounts: DerivAccountInfo[];
  accountTokens?: Record<string, string>;
  activeAccountId: string;
  email: string | null;
  fullname: string | null;
  ws: WebSocket | null;
}

const userSessions = new Map<string, UserDerivSession>();

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      out[k] = v;
    }
  }
  return out;
}

function sanitizeSessionPayload(session: UserDerivSession | null): DerivAuthSession {
  if (!session) {
    return {
      authenticated: false,
      sessionId: null,
      appId: DERIV_APP_ID,
      activeAccountId: null,
      activeAccountType: null,
      balance: null,
      currency: 'USD',
      email: null,
      fullname: null,
      accounts: [],
    };
  }
  const active =
    session.accounts.find((a) => a.accountId === session.activeAccountId) ??
    session.accounts[0];
  return {
    authenticated: true,
    sessionId: session.sid,
    appId: DERIV_APP_ID,
    activeAccountId: active?.accountId ?? session.activeAccountId,
    activeAccountType: active?.accountType ?? 'demo',
    balance: active?.balance ?? 0,
    currency: active?.currency ?? 'USD',
    email: session.email,
    fullname: session.fullname,
    accounts: session.accounts,
  };
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const liveMarketsMap = new Map<string, MarketSymbol>(
  DERIV_MARKETS.map((m) => [m.symbol, m]),
);
let liveMarketsList: MarketSymbol[] = [...DERIV_MARKETS];

const SUBMARKET_LABELS: Record<string, string> = {
  random_index: 'Continuous Indices',
  jump_index: 'Jump Indices',
  random_daily: 'Daily Reset Indices',
  step_index: 'Step Indices',
  crash_index: 'Crash/Boom Indices',
  range_index: 'Range Break Indices',
  forex_basket: 'Forex Baskets',
  commodity_basket: 'Commodity Baskets',
  major_pairs: 'Major Pairs',
  minor_pairs: 'Minor Pairs',
  metals: 'Metals',
  non_stable_coin: 'Non-Stable Coins',
  americas_OTC: 'Americas',
  europe_OTC: 'Europe',
  asia_oceania_OTC: 'Asia/Oceania',
};

function mapActiveSymbol(raw: {
  underlying_symbol?: string;
  symbol?: string;
  underlying_symbol_name?: string;
  display_name?: string;
  market?: string;
  submarket?: string;
  pip_size?: number;
  exchange_is_open?: number;
}): MarketSymbol | null {
  const sym = raw.underlying_symbol || raw.symbol;
  if (!sym) return null;
  const existing = liveMarketsMap.get(sym);
  const market = raw.market || 'synthetic_index';
  const submarket = raw.submarket || 'random_index';

  let marketGroup: MarketGroup = 'Derived';
  if (market === 'forex') marketGroup = 'Forex';
  else if (market === 'commodities') marketGroup = 'Commodities';
  else if (market === 'indices') marketGroup = 'Stock Indices';
  else if (market === 'cryptocurrency') marketGroup = 'Cryptocurrencies';

  const pipFloat = Number(raw.pip_size || 0.01);
  const pipSize =
    pipFloat > 0 && pipFloat < 1
      ? Math.max(0, Math.round(-Math.log10(pipFloat)))
      : existing?.pipSize ?? 2;

  const supportsDigits =
    submarket === 'random_index' ||
    submarket === 'jump_index' ||
    submarket === 'random_daily';
  const supportsRiseFall =
    market === 'forex' ||
    market === 'commodities' ||
    market === 'indices' ||
    submarket === 'random_index' ||
    submarket === 'jump_index' ||
    submarket === 'random_daily' ||
    submarket === 'step_index' ||
    submarket === 'forex_basket' ||
    submarket === 'commodity_basket';
  const supportsMultipliers =
    market === 'cryptocurrency' ||
    market === 'forex' ||
    market === 'commodities' ||
    submarket === 'random_index' ||
    submarket === 'jump_index' ||
    submarket === 'step_index' ||
    submarket === 'crash_index';

  let defaultDuration = 1;
  let defaultDurationUnit: DurationUnit = 't';
  if (market === 'forex' || market === 'indices' || submarket.includes('basket')) {
    defaultDuration = 15;
    defaultDurationUnit = 'm';
  } else if (market === 'commodities') {
    defaultDuration = 5;
    defaultDurationUnit = 'm';
  } else if (submarket === 'step_index') {
    defaultDuration = 5;
    defaultDurationUnit = 't';
  }

  return {
    symbol: sym,
    name: raw.underlying_symbol_name || raw.display_name || existing?.name || sym,
    marketGroup,
    subGroup: SUBMARKET_LABELS[submarket] || existing?.subGroup || submarket,
    pipSize,
    basePrice: existing?.basePrice ?? (market === 'forex' ? 1.1 : 1000),
    exchangeOpen: raw.exchange_is_open !== 0,
    supportsDigits,
    supportsRiseFall,
    supportsMultipliers,
    defaultDuration,
    defaultDurationUnit,
  };
}

function getMarketMeta(symbol: string): MarketSymbol {
  const existing = liveMarketsMap.get(symbol);
  if (existing) return existing;
  const clean = symbol.trim();
  if (/^[A-Za-z0-9_:-]{2,32}$/.test(clean)) {
    return {
      ...DERIV_MARKETS[1],
      symbol: clean,
      name: clean,
    };
  }
  return DERIV_MARKETS[1];
}

function resolveSymbolForSubscription(symbol: string): string {
  const clean = symbol.trim();
  if (/^[A-Za-z0-9_:-]{2,32}$/.test(clean)) {
    return clean;
  }
  return 'R_25';
}

function formatTick(symbol: string, epoch: number, quote: number): TickPoint {
  const meta = getMarketMeta(symbol);
  const formattedQuote = quote.toFixed(meta.pipSize);
  const lastChar = formattedQuote.charAt(formattedQuote.length - 1);
  const lastDigit = Number.parseInt(lastChar, 10);
  return {
    symbol,
    epoch,
    quote,
    formattedQuote,
    lastDigit: Number.isNaN(lastDigit) ? 0 : lastDigit,
  };
}

// =========================================================================
// Deriv v1 PAT & Classic v3 WS Authentication Helpers
// =========================================================================

async function authenticateWithV1Pat(
  token: string,
): Promise<{ accounts: DerivAccountInfo[]; error?: string } | null> {
  try {
    const res = await fetch(`${DERIV_API_BASE}/accounts`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Deriv-App-ID': DERIV_APP_ID,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return null;
    }
    const rawText = await res.text();
    const trimmed = rawText.trim();
    if (!trimmed || trimmed.startsWith('<')) {
      return null;
    }
    const json = JSON.parse(trimmed) as {
      data?: {
        account_id: string;
        balance: number;
        currency: string;
        status?: string;
        account_type: 'demo' | 'real';
      }[];
    };
    if (!Array.isArray(json.data) || json.data.length === 0) {
      return null;
    }
    const accounts: DerivAccountInfo[] = json.data.map((a) => ({
      accountId: a.account_id,
      accountType: a.account_type === 'real' ? 'real' : 'demo',
      currency: a.currency || 'USD',
      balance: Number(a.balance ?? 0),
      status: a.status || 'active',
      protocol: 'v1-pat',
    }));
    return { accounts };
  } catch {
    return null;
  }
}

async function openV1OtpSocket(
  token: string,
  accountId: string,
  accountType: 'demo' | 'real',
  onBalanceUpdate: (balance: number, currency: string) => void,
): Promise<{ ws: WebSocket } | { error: string }> {
  try {
    const otpRes = await fetch(
      `${DERIV_API_BASE}/accounts/${encodeURIComponent(accountId)}/otp`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Deriv-App-ID': DERIV_APP_ID,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    );
    const otpText = await otpRes.text();
    if (!otpRes.ok) {
      let msg = `Deriv OTP request failed (${otpRes.status})`;
      try {
        const errJson = JSON.parse(otpText) as {
          error?: { message?: string };
          message?: string;
        };
        msg = errJson.error?.message || errJson.message || msg;
      } catch {
        // Keep status message
      }
      return { error: msg };
    }

    const trimmedOtp = otpText.trim();
    if (trimmedOtp.startsWith('<')) {
      return { error: `Deriv OTP endpoint returned non-JSON response (${otpRes.status}).` };
    }
    const otpJson = JSON.parse(trimmedOtp || '{}') as {
      otp?: string;
      url?: string;
      websocket_url?: string;
      data?: {
        otp?: string;
        url?: string;
        websocket_url?: string;
      };
    };
    const payload = otpJson.data ?? otpJson;
    const rawUrl =
      payload.url ||
      payload.websocket_url ||
      (payload.otp
        ? `wss://api.derivws.com/trading/v1/options/ws/${accountType}?otp=${encodeURIComponent(payload.otp)}`
        : undefined);
    if (!rawUrl) {
      return { error: 'Deriv OTP response did not include a WebSocket URL.' };
    }
    const wsUrl = rawUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    return await new Promise<{ ws: WebSocket } | { error: string }>((resolve) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          'Deriv-App-ID': DERIV_APP_ID,
        },
      });
      const timer = setTimeout(() => {
        ws.terminate();
        resolve({ error: 'Timed out opening Deriv authenticated WebSocket.' });
      }, 7000);

      ws.on('open', () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
        resolve({ ws });
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            msg_type?: string;
            balance?: { balance?: number; currency?: string };
          };
          if (msg.msg_type === 'balance' && msg.balance) {
            onBalanceUpdate(
              Number(msg.balance.balance ?? 0),
              msg.balance.currency || 'USD',
            );
          }
        } catch {
          // Ignore malformed frame
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        resolve({ error: err.message || 'Deriv authenticated WebSocket error.' });
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to open Deriv WebSocket.' };
  }
}

async function authenticateWithClassicV3(token: string): Promise<{
  accounts: DerivAccountInfo[];
  activeAccountId: string;
  email: string | null;
  fullname: string | null;
  ws: WebSocket;
} | { error: string }> {
  return await new Promise((resolve) => {
    const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
    let resolved = false;
    let list: DerivAccountInfo[] = [];
    let authPayload: {
      loginid: string;
      email?: string;
      fullname?: string;
    } | null = null;
    let balanceFlushTimer: NodeJS.Timeout | null = null;

    const finalize = () => {
      if (resolved || !authPayload) return;
      resolved = true;
      clearTimeout(timer);
      if (balanceFlushTimer) clearTimeout(balanceFlushTimer);
      resolve({
        accounts: list,
        activeAccountId: authPayload.loginid,
        email: authPayload.email ?? null,
        fullname: authPayload.fullname ?? null,
        ws,
      });
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (balanceFlushTimer) clearTimeout(balanceFlushTimer);
        ws.terminate();
        resolve({ error: 'Timed out connecting to Deriv authentication server.' });
      }
    }, 8000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as {
          msg_type?: string;
          error?: { message?: string };
          authorize?: {
            loginid: string;
            balance: number;
            currency: string;
            is_virtual: number;
            email?: string;
            fullname?: string;
            account_list?: {
              loginid: string;
              currency: string;
              is_virtual: number;
              is_disabled: number;
            }[];
          };
          balance?: {
            accounts?: Record<string, { balance?: number; currency?: string }>;
          };
        };

        if (data.error && !resolved) {
          resolved = true;
          clearTimeout(timer);
          if (balanceFlushTimer) clearTimeout(balanceFlushTimer);
          ws.close();
          resolve({ error: data.error.message || 'Invalid Deriv API token.' });
          return;
        }

        if (data.msg_type === 'authorize' && data.authorize) {
          const auth = data.authorize;
          authPayload = {
            loginid: auth.loginid,
            email: auth.email,
            fullname: auth.fullname,
          };
          list = (auth.account_list || []).map((a) => ({
            accountId: a.loginid,
            accountType: a.is_virtual === 1 ? 'demo' : 'real',
            currency: a.currency || auth.currency || 'USD',
            balance: a.loginid === auth.loginid ? Number(auth.balance ?? 0) : 0,
            status: a.is_disabled ? 'disabled' : 'active',
            protocol: 'v3-ws',
          }));

          if (!list.some((a) => a.accountId === auth.loginid)) {
            list.unshift({
              accountId: auth.loginid,
              accountType: auth.is_virtual === 1 ? 'demo' : 'real',
              currency: auth.currency || 'USD',
              balance: Number(auth.balance ?? 0),
              status: 'active',
              protocol: 'v3-ws',
            });
          }

          ws.send(JSON.stringify({ balance: 1, account: 'all', subscribe: 1 }));
          balanceFlushTimer = setTimeout(finalize, 380);
          return;
        }

        if (data.msg_type === 'balance' && data.balance?.accounts && !resolved && authPayload) {
          for (const [id, info] of Object.entries(data.balance.accounts)) {
            const acc = list.find((a) => a.accountId === id);
            if (acc && typeof info.balance === 'number') {
              acc.balance = Number(info.balance);
              if (info.currency) acc.currency = info.currency;
            }
          }
          finalize();
        }
      } catch {
        // Ignore parse error
      }
    });

    ws.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (balanceFlushTimer) clearTimeout(balanceFlushTimer);
        resolve({ error: 'Unable to reach Deriv WebSocket server.' });
      }
    });
  });
}

async function createDerivSession(token: string, sid: string): Promise<UserDerivSession | { error: string }> {
  // 1. Try Deriv Options v1 REST API using registered Deriv-App-ID (34RXuPGgdUNCTWhsYjRcD)
  const v1 = await authenticateWithV1Pat(token);
  if (v1 && v1.accounts.length > 0) {
    // Prefer demo account first for safety
    const preferred =
      v1.accounts.find((a) => a.accountType === 'demo') ?? v1.accounts[0];
    const session: UserDerivSession = {
      sid,
      token,
      protocol: 'v1-pat',
      accounts: v1.accounts,
      activeAccountId: preferred.accountId,
      email: null,
      fullname: null,
      ws: null,
    };

    const otpSock = await openV1OtpSocket(
      token,
      preferred.accountId,
      preferred.accountType,
      (balance, currency) => {
        const target = session.accounts.find(
          (a) => a.accountId === session.activeAccountId,
        );
        if (target) {
          target.balance = balance;
          target.currency = currency;
        }
      },
    );
    if ('ws' in otpSock) {
      session.ws = otpSock.ws;
    }
    return session;
  }

  // 2. Fallback to classic Deriv v3 WS authorize for traditional API tokens
  const v3 = await authenticateWithClassicV3(token);
  if ('error' in v3) {
    return { error: v3.error };
  }
  const session: UserDerivSession = {
    sid,
    token,
    protocol: 'v3-ws',
    accounts: v3.accounts,
    activeAccountId: v3.activeAccountId,
    email: v3.email,
    fullname: v3.fullname,
    ws: v3.ws,
  };

  v3.ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        msg_type?: string;
        balance?: {
          balance?: number;
          currency?: string;
          loginid?: string;
          accounts?: Record<string, { balance?: number; currency?: string }>;
        };
      };
      if (msg.msg_type === 'balance' && msg.balance) {
        if (msg.balance.accounts) {
          for (const [id, info] of Object.entries(msg.balance.accounts)) {
            const acc = session.accounts.find((a) => a.accountId === id);
            if (acc && typeof info.balance === 'number') {
              acc.balance = Number(info.balance);
              if (info.currency) acc.currency = info.currency;
            }
          }
        }
        const targetId = msg.balance.loginid || session.activeAccountId;
        const acc = session.accounts.find((a) => a.accountId === targetId);
        if (acc && typeof msg.balance.balance === 'number') {
          acc.balance = Number(msg.balance.balance);
          if (msg.balance.currency) acc.currency = msg.balance.currency;
        }
      }
    } catch {
      // Ignore
    }
  });

  return session;
}

let rpcCounter = 10000;
function nextRpcId(): number {
  rpcCounter = (rpcCounter + 1) % 90000000;
  return rpcCounter + 10000;
}

async function sendDerivRpc<T = Record<string, unknown>>(
  ws: WebSocket,
  payload: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<(T & { msg_type?: string }) | { error: string }> {
  if (ws.readyState !== WebSocket.OPEN) {
    return { error: 'Deriv WebSocket is not open.' };
  }
  const reqId = nextRpcId();
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (res: (T & { msg_type?: string }) | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMsg);
      ws.off('close', onClose);
      resolve(res);
    };
    const timer = setTimeout(() => {
      finish({ error: 'Deriv RPC request timed out.' });
    }, timeoutMs);
    const onClose = () => {
      finish({ error: 'Deriv WebSocket closed during RPC.' });
    };
    const onMsg = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          req_id?: number;
          msg_type?: string;
          error?: { message?: string };
        } & T;
        if (msg.req_id !== reqId) return;
        if (msg.error) {
          finish({ error: msg.error.message || 'Deriv API returned an error.' });
        } else {
          finish(msg);
        }
      } catch {
        // Ignore malformed frame
      }
    };
    ws.on('message', onMsg);
    ws.on('close', onClose);
    try {
      ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    } catch (err) {
      finish({ error: err instanceof Error ? err.message : 'Failed to send Deriv RPC.' });
    }
  });
}

async function sendPublicDerivRpc<T = Record<string, unknown>>(
  payload: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<(T & { msg_type?: string }) | { error: string; apiError?: boolean }> {
  // Prefer existing open public upstream WebSocket if it's real Deriv WS
  if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN && feedStatus.source === 'deriv-ws') {
    const res = await sendDerivRpc<T>(upstreamWs, payload, timeoutMs);
    // Return immediately on success OR genuine Deriv API error (don't mask API errors behind fallback connect errors)
    if (!('error' in res) || (!res.error.includes('not open') && !res.error.includes('closed during RPC'))) {
      return res;
    }
  }

  const openAndQuery = (useClassic: boolean) =>
    new Promise<(T & { msg_type?: string }) | { error: string; apiError?: boolean }>((resolve) => {
      const ws = useClassic
        ? new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089')
        : new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public', {
            headers: { 'Deriv-App-ID': DERIV_APP_ID },
          });
      let settled = false;
      let opened = false;
      const done = (r: (T & { msg_type?: string }) | { error: string; apiError?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // Ignore
        }
        resolve(r);
      };
      const timer = setTimeout(() => {
        ws.terminate();
        done({ error: 'Timed out reaching Deriv public API.' });
      }, timeoutMs);

      ws.on('open', async () => {
        opened = true;
        const res = await sendDerivRpc<T>(ws, payload, Math.max(2500, timeoutMs - 500));
        done('error' in res ? { error: res.error, apiError: true } : res);
      });
      ws.on('error', () => {
        done({ error: opened ? 'Deriv WebSocket RPC error.' : 'Could not reach Deriv public WebSocket.' });
      });
    });

  const primary = await openAndQuery(false);
  if (!('error' in primary) || primary.apiError) return primary;
  return await openAndQuery(true);
}

async function ensureSessionSocket(session: UserDerivSession): Promise<{ ws: WebSocket } | { error: string }> {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    return { ws: session.ws };
  }
  const activeAcc =
    session.accounts.find((a) => a.accountId === session.activeAccountId) ?? session.accounts[0];
  if (!activeAcc) {
    return { error: 'No active Deriv account found.' };
  }
  if (session.protocol === 'v1-pat') {
    const otpSock = await openV1OtpSocket(
      session.token,
      activeAcc.accountId,
      activeAcc.accountType,
      (bal, cur) => {
        activeAcc.balance = bal;
        activeAcc.currency = cur;
      },
    );
    if ('ws' in otpSock) {
      session.ws = otpSock.ws;
      return { ws: otpSock.ws };
    }
    return { error: otpSock.error };
  }
  const activeToken = session.accountTokens?.[activeAcc.accountId] || session.token;
  const reauth = await authenticateWithClassicV3(activeToken);
  if ('error' in reauth) {
    return { error: reauth.error };
  }
  session.ws = reauth.ws;
  return { ws: reauth.ws };
}

async function sendSessionDerivRpc<T = Record<string, unknown>>(
  session: UserDerivSession,
  payload: Record<string, unknown>,
  timeoutMs = 9000,
): Promise<(T & { msg_type?: string }) | { error: string }> {
  const sock = await ensureSessionSocket(session);
  if ('error' in sock) {
    return { error: sock.error };
  }
  return await sendDerivRpc<T>(sock.ws, payload, timeoutMs);
}

async function executeDerivContract(
  session: UserDerivSession,
  params: {
    symbol: string;
    contractType: ContractTypeOption;
    barrier?: number;
    stake: number;
    durationTicks: number;
    durationUnit?: DurationUnit;
    multiplier?: number;
    limitOrder?: {
      takeProfit?: number;
      stopLoss?: number;
    };
  },
): Promise<{
  contractId: string;
  entrySpot: string;
  exitSpot: string;
  payout: number;
  profit: number;
  won: boolean;
  status: 'won' | 'lost' | 'open';
  balance: number;
} | { error: string }> {
  const activeAcc = session.accounts.find(
    (a) => a.accountId === session.activeAccountId,
  );
  if (!activeAcc) {
    return { error: 'No active Deriv account found.' };
  }
  if (activeAcc.accountType === 'real' && process.env.ALLOW_REAL_TRADING === 'false') {
    return {
      error:
        'Real-account trading is disabled by server environment (ALLOW_REAL_TRADING=false). Switch to your Deriv Demo account.',
    };
  }

  const sock = await ensureSessionSocket(session);
  if ('error' in sock) {
    return { error: sock.error || 'Authenticated Deriv WebSocket is disconnected.' };
  }
  const ws = sock.ws;

  const resolvedType =
    params.contractType === 'Both' ? 'DIGITDIFF' : params.contractType;
  const isMultiplier = resolvedType === 'MULTUP' || resolvedType === 'MULTDOWN';
  const durationUnit: DurationUnit = params.durationUnit || 't';
  const needsBarrier =
    resolvedType === 'DIGITMATCH' ||
    resolvedType === 'DIGITDIFF' ||
    resolvedType === 'DIGITOVER' ||
    resolvedType === 'DIGITUNDER';

  const reqIdProposal = nextRpcId();
  const reqIdBuy = nextRpcId();
  const reqIdPoc = nextRpcId();

  return await new Promise((resolve) => {
    let contractId: string | null = null;
    let pocSubscriptionId: string | null = null;
    let entrySpotSnapshot = '—';
    let balanceUpdatedFromWs = false;
    let settled = false;

    const finish = (payload: {
      contractId: string;
      entrySpot: string;
      exitSpot: string;
      payout: number;
      profit: number;
      won: boolean;
      status: 'won' | 'lost' | 'open';
      balance: number;
    } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (openFallbackTimer) clearTimeout(openFallbackTimer);
      ws.off('message', onMessage);
      if (pocSubscriptionId && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ forget: pocSubscriptionId }));
        } catch {
          // Ignore forget error
        }
      }
      resolve(payload);
    };

    let openFallbackTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      if (contractId) {
        finish({
          contractId,
          entrySpot: entrySpotSnapshot,
          exitSpot: 'OPEN',
          payout: 0,
          profit: 0,
          won: false,
          status: 'open',
          balance: activeAcc.balance,
        });
      } else {
        finish({ error: 'Deriv contract settlement timed out.' });
      }
    }, 25000);

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          req_id?: number;
          msg_type?: string;
          error?: { message?: string };
          subscription?: { id?: string };
          balance?: { balance?: number; currency?: string };
          proposal?: { id: string; ask_price: number };
          buy?: { contract_id: number | string; buy_price: number; balance_after?: number };
          proposal_open_contract?: {
            contract_id: number | string;
            is_sold?: number | boolean;
            status?: string;
            entry_spot?: number | string;
            entry_spot_display_value?: string;
            exit_tick?: number | string;
            exit_tick_display_value?: string;
            exit_spot?: number | string;
            exit_spot_display_value?: string;
            payout?: number;
            sell_price?: number;
            profit?: number;
            buy_price?: number;
          };
        };

        if (msg.msg_type === 'balance' && msg.balance && contractId !== null) {
          balanceUpdatedFromWs = true;
          if (typeof msg.balance.balance === 'number') {
            activeAcc.balance = Number(msg.balance.balance);
          }
        }

        if (
          msg.error &&
          (msg.req_id === reqIdProposal || msg.req_id === reqIdBuy || msg.req_id === reqIdPoc)
        ) {
          finish({ error: msg.error.message || 'Deriv trade rejected.' });
          return;
        }

        if (msg.msg_type === 'proposal' && msg.req_id === reqIdProposal && msg.proposal) {
          const askPrice = Number(msg.proposal.ask_price ?? params.stake);
          const maxPrice = Number(Math.max(params.stake, askPrice).toFixed(2));
          ws.send(
            JSON.stringify({
              buy: msg.proposal.id,
              price: maxPrice,
              req_id: reqIdBuy,
            }),
          );
          return;
        }

        if (msg.msg_type === 'buy' && msg.req_id === reqIdBuy && msg.buy) {
          contractId = String(msg.buy.contract_id);
          if (typeof msg.buy.balance_after === 'number') {
            activeAcc.balance = Number(msg.buy.balance_after);
          } else {
            const spent = Number(msg.buy.buy_price ?? params.stake);
            activeAcc.balance = Number(Math.max(0, activeAcc.balance - spent).toFixed(2));
          }
          ws.send(
            JSON.stringify({
              proposal_open_contract: 1,
              contract_id: msg.buy.contract_id,
              subscribe: 1,
              req_id: reqIdPoc,
            }),
          );
          // For multi-minute/hour contracts or Multipliers, return as open position after 3.5s
          if (isMultiplier || durationUnit !== 't') {
            openFallbackTimer = setTimeout(() => {
              if (contractId) {
                finish({
                  contractId,
                  entrySpot: entrySpotSnapshot,
                  exitSpot: 'OPEN',
                  payout: 0,
                  profit: 0,
                  won: false,
                  status: 'open',
                  balance: activeAcc.balance,
                });
              }
            }, 3500);
          }
          return;
        }

        if (
          msg.msg_type === 'proposal_open_contract' &&
          msg.proposal_open_contract &&
          contractId !== null &&
          String(msg.proposal_open_contract.contract_id) === contractId
        ) {
          if (msg.subscription?.id) {
            pocSubscriptionId = msg.subscription.id;
          }
          const poc = msg.proposal_open_contract;
          if (poc.entry_spot_display_value || poc.entry_spot != null) {
            entrySpotSnapshot =
              poc.entry_spot_display_value || String(poc.entry_spot);
          }
          const isSettled =
            poc.is_sold === 1 ||
            poc.is_sold === true ||
            poc.status === 'won' ||
            poc.status === 'lost';
          if (isSettled) {
            const profit = Number(poc.profit ?? 0);
            const won = poc.status === 'won' || profit > 0;
            const payout = won ? Number(poc.sell_price ?? poc.payout ?? 0) : 0;
            if (won && !balanceUpdatedFromWs) {
              activeAcc.balance = Number((activeAcc.balance + payout).toFixed(2));
            }
            const exitSpot =
              poc.exit_tick_display_value ||
              poc.exit_spot_display_value ||
              (poc.exit_tick != null
                ? String(poc.exit_tick)
                : poc.exit_spot != null
                  ? String(poc.exit_spot)
                  : '—');
            finish({
              contractId,
              entrySpot: entrySpotSnapshot,
              exitSpot,
              payout,
              profit,
              won,
              status: won ? 'won' : 'lost',
              balance: activeAcc.balance,
            });
          }
        }
      } catch {
        // Ignore parse error
      }
    };

    ws.on('message', onMessage);

    const proposalPayload: Record<string, unknown> = {
      proposal: 1,
      amount: params.stake,
      basis: 'stake',
      contract_type: resolvedType,
      currency: activeAcc.currency || 'USD',
      req_id: reqIdProposal,
    };
    if (isMultiplier) {
      proposalPayload.multiplier = params.multiplier || 100;
      if (params.limitOrder && (params.limitOrder.takeProfit || params.limitOrder.stopLoss)) {
        const limitObj: Record<string, number> = {};
        if (params.limitOrder.takeProfit && params.limitOrder.takeProfit > 0) {
          limitObj.take_profit = Number(params.limitOrder.takeProfit.toFixed(2));
        }
        if (params.limitOrder.stopLoss && params.limitOrder.stopLoss > 0) {
          limitObj.stop_loss = Number(params.limitOrder.stopLoss.toFixed(2));
        }
        if (Object.keys(limitObj).length > 0) {
          proposalPayload.limit_order = limitObj;
        }
      }
    } else {
      proposalPayload.duration = params.durationTicks;
      proposalPayload.duration_unit = durationUnit;
    }
    if (session.protocol === 'v1-pat') {
      proposalPayload.underlying_symbol = params.symbol;
    } else {
      proposalPayload.symbol = params.symbol;
    }
    if (needsBarrier && typeof params.barrier === 'number') {
      proposalPayload.barrier = String(params.barrier);
    }
    ws.send(JSON.stringify(proposalPayload));
  });
}

// =========================================================================
// Shared Public Market Feed Cache & Upstream WebSocket Bridge
// =========================================================================

const tickBuffers = new Map<string, TickPoint[]>();
const clientSubs = new Map<WebSocket, string>();
let upstreamWs: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let fallbackInterval: NodeJS.Timeout | null = null;
const subscribedUpstreamSymbols = new Set<string>();

const feedStatus: FeedStatus = {
  connected: false,
  source: 'deriv-ws',
  accountMode: 'demo',
  authorizedLoginId: null,
  lastError: null,
};

function sendToClient(ws: WebSocket, msg: ServerWsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Ignore closed socket race
    }
  }
}

function broadcastStatus() {
  const payload = JSON.stringify({
    type: 'feed:status',
    status: feedStatus,
  } satisfies ServerWsMessage);
  for (const ws of clientSubs.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch {
        // Ignore closed socket race
      }
    }
  }
}

function broadcastTick(tick: TickPoint) {
  let buf = tickBuffers.get(tick.symbol);
  if (!buf) {
    buf = [];
    tickBuffers.set(tick.symbol, buf);
  }
  buf.push(tick);
  if (buf.length > 1000) {
    buf.splice(0, buf.length - 1000);
  }

  const payload = JSON.stringify({ type: 'tick', tick } satisfies ServerWsMessage);
  for (const [ws, sym] of clientSubs.entries()) {
    if (sym === tick.symbol && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch {
        // Ignore closed socket race
      }
    }
  }
}

function seedLocalHistory(symbol: string) {
  if (tickBuffers.has(symbol) && (tickBuffers.get(symbol)?.length ?? 0) >= 1000) {
    return;
  }
  const meta = getMarketMeta(symbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const points: TickPoint[] = [];
  let price = meta.basePrice;
  const volScale = symbol.includes('100') ? 0.0018 : symbol.includes('75') ? 0.0014 : 0.0008;

  for (let i = 999; i >= 0; i--) {
    const delta = (Math.random() - 0.5) * 2 * price * volScale;
    price = Math.max(meta.basePrice * 0.5, price + delta);
    points.push(formatTick(symbol, nowSec - i, price));
  }
  tickBuffers.set(symbol, points);
}

function startFallbackStream() {
  if (fallbackInterval) return;
  feedStatus.source = 'synthetic-replay';
  feedStatus.connected = true;
  broadcastStatus();

  for (const sym of new Set([...clientSubs.values(), 'R_25'])) {
    seedLocalHistory(sym);
  }

  fallbackInterval = setInterval(() => {
    const activeSymbols = new Set<string>(['R_25']);
    for (const sym of clientSubs.values()) {
      activeSymbols.add(sym);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const sym of activeSymbols) {
      seedLocalHistory(sym);
      const buf = tickBuffers.get(sym);
      const prev = buf?.[buf.length - 1];
      if (!prev) continue;
      const meta = getMarketMeta(sym);
      const volScale = sym.includes('100') ? 0.0018 : sym.includes('75') ? 0.0014 : 0.0008;
      const delta = (Math.random() - 0.5) * 2 * prev.quote * volScale;
      const nextPrice = Math.max(meta.basePrice * 0.5, prev.quote + delta);
      broadcastTick(formatTick(sym, nowSec, nextPrice));
    }
  }, 1000);
}

function stopFallbackStream() {
  if (fallbackInterval) {
    clearInterval(fallbackInterval);
    fallbackInterval = null;
  }
}

function subscribeUpstreamSymbol(symbol: string) {
  if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
    seedLocalHistory(symbol);
    return;
  }
  if (subscribedUpstreamSymbols.has(symbol)) {
    return;
  }
  subscribedUpstreamSymbols.add(symbol);
  try {
    upstreamWs.send(
      JSON.stringify({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 1000,
        end: 'latest',
        start: 1,
        style: 'ticks',
        subscribe: 1,
      }),
    );
  } catch {
    subscribedUpstreamSymbols.delete(symbol);
  }
}

function connectDerivUpstream(useClassicFallback = false) {
  if (
    upstreamWs &&
    (upstreamWs.readyState === WebSocket.OPEN ||
      upstreamWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const ws = useClassicFallback
    ? new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089')
    : new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public', {
        headers: {
          'Deriv-App-ID': DERIV_APP_ID,
        },
      });
  upstreamWs = ws;

  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
    }
  }, 6000);

  ws.on('open', () => {
    clearTimeout(connectTimeout);
    stopFallbackStream();
    subscribedUpstreamSymbols.clear();
    feedStatus.connected = true;
    feedStatus.source = 'deriv-ws';
    feedStatus.lastError = null;

    ws.send(JSON.stringify({ active_symbols: 'brief' }));

    const targets = new Set<string>(['R_25', ...clientSubs.values()]);
    for (const sym of targets) {
      subscribeUpstreamSymbol(sym);
    }
    broadcastStatus();
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString()) as {
        req_id?: number;
        msg_type?: string;
        error?: { message?: string };
        echo_req?: { ticks_history?: string };
        active_symbols?: {
          underlying_symbol?: string;
          symbol?: string;
          underlying_symbol_name?: string;
          display_name?: string;
          market?: string;
          submarket?: string;
          pip_size?: number;
          exchange_is_open?: number;
        }[];
        history?: { prices?: number[]; times?: number[] };
        tick?: { symbol?: string; underlying_symbol?: string; epoch: number; quote: number };
      };

      if (data.error) {
        if (typeof data.req_id === 'number') {
          return;
        }
        feedStatus.lastError = data.error.message || 'Deriv API error';
        broadcastStatus();
        return;
      }

      if (Array.isArray(data.active_symbols) && data.active_symbols.length > 0) {
        const mapped: MarketSymbol[] = [];
        for (const item of data.active_symbols) {
          const m = mapActiveSymbol(item);
          if (m) {
            liveMarketsMap.set(m.symbol, m);
            mapped.push(m);
          }
        }
        if (mapped.length > 0) {
          liveMarketsList = mapped;
        }
        return;
      }

      if (data.msg_type === 'history' && data.history && data.echo_req?.ticks_history) {
        const sym = data.echo_req.ticks_history;
        const prices = data.history.prices || [];
        const times = data.history.times || [];
        const parsed: TickPoint[] = [];
        for (let i = 0; i < prices.length; i++) {
          parsed.push(formatTick(sym, Number(times[i] || 0), Number(prices[i] || 0)));
        }
        tickBuffers.set(sym, parsed);
        const msg: ServerWsMessage = { type: 'history', symbol: sym, ticks: parsed };
        for (const [clientWs, subSym] of clientSubs.entries()) {
          if (subSym === sym) {
            sendToClient(clientWs, msg);
          }
        }
        return;
      }

      if (data.msg_type === 'tick' && data.tick) {
        const tickSym = data.tick.symbol || data.tick.underlying_symbol || 'R_25';
        const pt = formatTick(
          tickSym,
          Number(data.tick.epoch),
          Number(data.tick.quote),
        );
        broadcastTick(pt);
      }
    } catch {
      // Ignore malformed frame
    }
  });

  ws.on('close', () => {
    clearTimeout(connectTimeout);
    upstreamWs = null;
    subscribedUpstreamSymbols.clear();
    if (!useClassicFallback) {
      connectDerivUpstream(true);
      return;
    }
    startFallbackStream();
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectDerivUpstream(false);
      }, 25000);
    }
  });

  ws.on('error', () => {
    clearTimeout(connectTimeout);
    if (!useClassicFallback) {
      ws.terminate();
      return;
    }
    feedStatus.lastError = 'Deriv WebSocket unreachable, using local market replay';
    startFallbackStream();
  });
}

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // Keep open authenticated Deriv WebSockets alive
  setInterval(() => {
    for (const sess of userSessions.values()) {
      if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
        try {
          sess.ws.send(JSON.stringify({ ping: 1 }));
        } catch {
          // Ignore send failure
        }
      }
    }
  }, 25000);

  const isHttpsRequest = (req: express.Request): boolean => {
    const xfProto = String(req.headers['x-forwarded-proto'] || '');
    const origin = String(req.headers.origin || '');
    return req.secure || xfProto.includes('https') || origin.startsWith('https://');
  };

  const buildSessionCookie = (req: express.Request, sid: string, maxAge: number): string => {
    if (isHttpsRequest(req)) {
      return `deriv_sid=${sid}; HttpOnly; Path=/; SameSite=None; Secure; Partitioned; Max-Age=${maxAge}`;
    }
    return `deriv_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  };

  // Auto-bootstrap server session asynchronously so port binding is never delayed
  let envDefaultSession: UserDerivSession | null = null;
  if (ENV_DERIV_API_TOKEN) {
    void createDerivSession(ENV_DERIV_API_TOKEN, 'env-default')
      .then((bootstrapped) => {
        if (!('error' in bootstrapped)) {
          envDefaultSession = bootstrapped;
          feedStatus.authorizedLoginId = bootstrapped.activeAccountId;
          broadcastStatus();
        }
      })
      .catch(() => {
        // Non-fatal if env token bootstrap fails
      });
  }

  const getSessionIdFromReq = (req: express.Request): string | undefined => {
    const headerSid = req.header('x-deriv-session')?.trim();
    if (headerSid && userSessions.has(headerSid)) {
      return headerSid;
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.deriv_sid && userSessions.has(cookies.deriv_sid)) {
      return cookies.deriv_sid;
    }
    return undefined;
  };

  const getSessionForReq = (req: express.Request): UserDerivSession | null => {
    const sid = getSessionIdFromReq(req);
    if (sid && userSessions.has(sid)) {
      return userSessions.get(sid) ?? null;
    }
    return envDefaultSession;
  };

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      appId: DERIV_APP_ID,
      feedStatus,
      cachedSymbols: Array.from(tickBuffers.keys()),
    });
  });

  // Deriv Account Auth Endpoints
  app.get('/api/deriv/session', (req, res) => {
    const session = getSessionForReq(req);
    res.json(sanitizeSessionPayload(session));
  });

  app.post('/api/deriv/login', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Please paste your Deriv API token.' });
      return;
    }

    const sid = crypto.randomBytes(24).toString('hex');
    const result = await createDerivSession(token, sid);
    if ('error' in result) {
      res.status(401).json({ error: result.error });
      return;
    }

    // Close any prior session on this browser
    const oldSid = getSessionIdFromReq(req);
    if (oldSid && userSessions.has(oldSid)) {
      userSessions.get(oldSid)?.ws?.close();
      userSessions.delete(oldSid);
    }

    userSessions.set(sid, result);
    res.setHeader('Set-Cookie', buildSessionCookie(req, sid, 86400));
    res.json(sanitizeSessionPayload(result));
  });

  app.post('/api/deriv/oauth-callback', async (req, res) => {
    const rawAccounts = Array.isArray(req.body?.accounts)
      ? (req.body.accounts as { accountId?: string; token?: string; currency?: string }[])
      : [];
    const cleaned = rawAccounts
      .filter((a) => typeof a.accountId === 'string' && typeof a.token === 'string' && a.token.trim())
      .map((a) => ({
        accountId: String(a.accountId).trim(),
        token: String(a.token).trim(),
        currency: String(a.currency || 'USD').trim(),
      }));

    if (cleaned.length === 0) {
      res.status(400).json({ error: 'No valid Deriv OAuth account tokens supplied.' });
      return;
    }

    // Prefer Demo (VRTC...) account first for safety
    const preferred =
      cleaned.find((a) => a.accountId.toUpperCase().startsWith('VRTC')) ?? cleaned[0];

    const sid = crypto.randomBytes(24).toString('hex');
    const authRes = await createDerivSession(preferred.token, sid);
    if ('error' in authRes) {
      res.status(401).json({ error: authRes.error });
      return;
    }

    const tokenMap: Record<string, string> = {};
    for (const acc of cleaned) {
      tokenMap[acc.accountId] = acc.token;
    }
    authRes.accountTokens = tokenMap;

    const oldSid = getSessionIdFromReq(req);
    if (oldSid && userSessions.has(oldSid)) {
      userSessions.get(oldSid)?.ws?.close();
      userSessions.delete(oldSid);
    }

    userSessions.set(sid, authRes);
    res.setHeader('Set-Cookie', buildSessionCookie(req, sid, 86400));
    res.json(sanitizeSessionPayload(authRes));
  });

  app.post('/api/deriv/switch-account', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Not signed in to a Deriv account.' });
      return;
    }
    const targetId = String(req.body?.accountId || '').trim();
    const target = session.accounts.find((a) => a.accountId === targetId);
    if (!target) {
      res.status(404).json({ error: 'Requested account ID not found.' });
      return;
    }

    if (session.protocol === 'v1-pat') {
      session.activeAccountId = target.accountId;
      session.ws?.close();
      const otpSock = await openV1OtpSocket(
        session.token,
        target.accountId,
        target.accountType,
        (bal, cur) => {
          target.balance = bal;
          target.currency = cur;
        },
      );
      session.ws = 'ws' in otpSock ? otpSock.ws : null;
      res.json(sanitizeSessionPayload(session));
      return;
    }

    // Classic v3 WS: only re-authorize if we have an OAuth token for target account (or target is already authorized token account)
    const perAccountToken = session.accountTokens?.[target.accountId];
    if (perAccountToken) {
      const reauth = await authenticateWithClassicV3(perAccountToken);
      if ('error' in reauth) {
        res.status(400).json({ error: reauth.error });
        return;
      }
      session.ws?.close();
      session.ws = reauth.ws;
      session.token = perAccountToken;
      session.activeAccountId = reauth.activeAccountId;
      for (const updatedAcc of reauth.accounts) {
        const existing = session.accounts.find((a) => a.accountId === updatedAcc.accountId);
        if (existing && updatedAcc.balance > 0) {
          existing.balance = updatedAcc.balance;
          existing.currency = updatedAcc.currency;
        }
      }
      res.json(sanitizeSessionPayload(session));
      return;
    }

    if (target.accountId !== session.activeAccountId) {
      res.status(400).json({
        error:
          'Single-account classic API tokens can only trade their own loginid. Sign in with a token scoped to that account or use Deriv Personal Access Token (PAT) / OAuth.',
      });
      return;
    }
    res.json(sanitizeSessionPayload(session));
  });

  app.post('/api/deriv/reset-demo', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Sign in with your Deriv API token first.' });
      return;
    }
    const active = session.accounts.find(
      (a) => a.accountId === session.activeAccountId,
    );
    if (!active || active.accountType !== 'demo') {
      res.status(400).json({ error: 'Balance reset is only available for Demo accounts.' });
      return;
    }

    if (session.protocol === 'v1-pat') {
      try {
        const r = await fetch(
          `${DERIV_API_BASE}/accounts/${encodeURIComponent(active.accountId)}/reset-demo-balance`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.token}`,
              'Deriv-App-ID': DERIV_APP_ID,
              'Content-Type': 'application/json',
            },
          },
        );
        if (r.ok) {
          const refreshed = await authenticateWithV1Pat(session.token);
          if (refreshed) {
            session.accounts = refreshed.accounts;
          } else {
            active.balance = 10000;
          }
          res.json(sanitizeSessionPayload(session));
          return;
        }
      } catch {
        // Fallback below
      }
    } else if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ topup_virtual: 1 }));
    }

    res.json(sanitizeSessionPayload(session));
  });

  app.get('/api/deriv/markets', (_req, res) => {
    res.json({ markets: liveMarketsList });
  });

  app.post('/api/deriv/scan-markets', async (req, res) => {
    const group = String(req.body?.group || 'All');
    const stake = Math.max(0.35, Number(req.body?.stake) || 10);
    const perfectOnly = Boolean(req.body?.perfectOnly);
    const minConfidence = Math.min(
      95,
      Math.max(perfectOnly ? 80 : 30, Number(req.body?.minConfidence) || (perfectOnly ? 82 : 60)),
    );
    const minEvPct = Number.isFinite(Number(req.body?.minEvPct))
      ? Math.max(perfectOnly ? 1.5 : -999, Number(req.body?.minEvPct))
      : perfectOnly
        ? 1.8
        : 0.5;
    const maxMarkets = Math.min(120, Math.max(4, Number(req.body?.maxMarkets) || 24));
    const sortBy = String(req.body?.sortBy || 'score') as 'score' | 'probability' | 'ev';

    const openMarkets = liveMarketsList.filter(
      (m) => m.exchangeOpen !== false && (group === 'All' || m.marketGroup === group),
    );
    const candidatePool =
      openMarkets.length > 0
        ? openMarkets
        : liveMarketsList.filter((m) => group === 'All' || m.marketGroup === group);

    const prioritySymbols = new Set([
      'R_10',
      'R_25',
      'R_50',
      'R_75',
      'R_100',
      '1HZ10V',
      '1HZ25V',
      '1HZ50V',
      '1HZ75V',
      '1HZ100V',
      'JD10',
      'JD25',
      'JD50',
      'frxEURUSD',
      'frxGBPUSD',
      'frxUSDJPY',
      'frxAUDUSD',
      'frxXAUUSD',
      'cryBTCUSD',
      'cryETHUSD',
      'OTC_NDX',
      'OTC_SPC',
    ]);

    const prioritized = [
      ...candidatePool.filter((m) => prioritySymbols.has(m.symbol)),
      ...candidatePool.filter((m) => !prioritySymbols.has(m.symbol)),
    ];
    const selected = prioritized.slice(0, maxMarkets);
    const selectedSymbols = selected.map((m) => m.symbol);

    const nowSec = Math.floor(Date.now() / 1000);
    const symbolsNeedingFetch = selectedSymbols.filter((sym) => {
      const buf = tickBuffers.get(sym);
      if (!buf || buf.length < 800) return true;
      const lastEpoch = buf[buf.length - 1]?.epoch ?? 0;
      return nowSec - lastEpoch > 20;
    });

    if (symbolsNeedingFetch.length > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const pending = new Map<number, string>();
        const ws = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public', {
          headers: { 'Deriv-App-ID': DERIV_APP_ID },
        });

        const timers: NodeJS.Timeout[] = [];
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          for (const t of timers) clearTimeout(t);
          try {
            ws.close();
          } catch {
            // Ignore close error
          }
          resolve();
        };

        const timeout = setTimeout(
          finish,
          symbolsNeedingFetch.length > 30 ? 5800 : 3800,
        );

        ws.on('open', () => {
          const chunkSize = 24;
          for (let start = 0; start < symbolsNeedingFetch.length; start += chunkSize) {
            const chunk = symbolsNeedingFetch.slice(start, start + chunkSize);
            const delay = Math.floor(start / chunkSize) * 90;
            const timer = setTimeout(() => {
              if (settled || ws.readyState !== WebSocket.OPEN) return;
              chunk.forEach((sym, offset) => {
                const reqId = 90000 + start + offset;
                pending.set(reqId, sym);
                ws.send(
                  JSON.stringify({
                    ticks_history: sym,
                    adjust_start_time: 1,
                    count: 1000,
                    end: 'latest',
                    style: 'ticks',
                    req_id: reqId,
                  }),
                );
              });
            }, delay);
            timers.push(timer);
          }
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString()) as {
              req_id?: number;
              msg_type?: string;
              history?: { prices?: number[]; times?: number[] };
              echo_req?: { ticks_history?: string };
            };
            const sym =
              (typeof msg.req_id === 'number' ? pending.get(msg.req_id) : undefined) ||
              msg.echo_req?.ticks_history;
            if (typeof msg.req_id === 'number') {
              pending.delete(msg.req_id);
            }
            if (msg.msg_type === 'history' && msg.history && sym) {
              const prices = msg.history.prices || [];
              const times = msg.history.times || [];
              if (prices.length > 0) {
                const parsed: TickPoint[] = [];
                for (let i = 0; i < prices.length; i++) {
                  parsed.push(
                    formatTick(sym, Number(times[i] || 0), Number(prices[i] || 0)),
                  );
                }
                tickBuffers.set(sym, parsed);
              }
            }
            if (pending.size === 0) {
              finish();
            }
          } catch {
            // Ignore malformed response
          }
        });

        ws.on('error', finish);
        ws.on('close', finish);
      });
    }

    const results: MarketScanOpportunity[] = [];
    for (const meta of selected) {
      seedLocalHistory(meta.symbol);
      const ticks = tickBuffers.get(meta.symbol) ?? [];
      if (ticks.length < 35) continue;

      const report = analyzeMarketTicks(ticks, meta, 1000, stake);
      const topOpp = report.topOpportunity;
      if (!topOpp) continue;

      const evalStrategy: BotStrategyConfig = {
        ...DEFAULT_BOT_STRATEGY,
        tradeParams: {
          ...DEFAULT_BOT_STRATEGY.tradeParams,
          marketGroup: meta.marketGroup,
          subGroup: meta.subGroup,
          symbol: meta.symbol,
          tradeCategory: topOpp.tradeCategory,
          tradeType: topOpp.tradeType,
          contractType: topOpp.contractType,
        },
        purchaseConditions: {
          ...DEFAULT_BOT_STRATEGY.purchaseConditions,
          mode: 'best_quant_edge',
          durationTicks: topOpp.duration,
          durationUnit: topOpp.durationUnit,
          multiplier: topOpp.multiplier ?? 100,
          predictionDigit: topOpp.barrier,
        },
        preTradeAnalysis: {
          ...DEFAULT_PRETRADE_ANALYSIS,
          enabled: true,
          minConfidence,
          minEvPct,
          autoSelectBestContract: true,
          requireConfluence: true,
        },
      };

      const verdict = evaluatePreTradeGate(ticks, meta, evalStrategy, stake, 0);
      const matchedOpp =
        report.opportunities.find(
          (o) =>
            o.contractType === verdict.recommendedContract &&
            (verdict.recommendedContract.startsWith('DIGIT')
              ? o.barrier === verdict.recommendedBarrier
              : true),
        ) ?? topOpp;

      const score = Number(
        (
          verdict.expectedValuePct * 3.5 +
          verdict.confidence * 0.75 +
          Math.min(20, (matchedOpp.winRatePct - matchedOpp.breakEvenPct) * 2) +
          (verdict.approved ? 25 : 0)
        ).toFixed(2),
      );

      const isPerfectApproved = perfectOnly
        ? verdict.approved &&
          verdict.confidence >= minConfidence &&
          verdict.expectedValuePct >= minEvPct &&
          matchedOpp.winRatePct >= matchedOpp.breakEvenPct + 1.2
        : verdict.approved;

      results.push({
        symbol: meta.symbol,
        name: meta.name,
        marketGroup: meta.marketGroup,
        subGroup: meta.subGroup,
        latestPrice: report.latestPrice,
        pipSize: meta.pipSize,
        regime: report.regime,
        trendDirection: report.trendDirection,
        rsi14: report.rsi14,
        volatilityBps: report.volatilityBps,
        tradeCategory: matchedOpp.tradeCategory,
        tradeType: matchedOpp.tradeType,
        contractType: verdict.recommendedContract,
        barrier: verdict.recommendedBarrier,
        duration: matchedOpp.duration,
        durationUnit: matchedOpp.durationUnit,
        multiplier: matchedOpp.multiplier,
        conditionMode: matchedOpp.conditionMode,
        strategyLabel: matchedOpp.label,
        rationale: matchedOpp.rationale,
        winRatePct: matchedOpp.winRatePct,
        breakEvenPct: matchedOpp.breakEvenPct,
        expectedValuePct: verdict.expectedValuePct,
        profitFactor: matchedOpp.profitFactor,
        simulatedNetUsd: matchedOpp.simulatedNetUsd,
        confidence: verdict.confidence,
        approved: isPerfectApproved,
        reasons: verdict.reasons,
        score,
        sampleSize: report.sampleSize,
      });
    }

    if (sortBy === 'probability') {
      results.sort((a, b) => {
        if (b.winRatePct !== a.winRatePct) return b.winRatePct - a.winRatePct;
        return b.score - a.score;
      });
    } else if (sortBy === 'ev') {
      results.sort((a, b) => b.expectedValuePct - a.expectedValuePct);
    } else {
      results.sort((a, b) => b.score - a.score);
    }

    res.json({
      scannedAt: Date.now(),
      totalScanned: results.length,
      bestOpportunity: results[0] ?? null,
      results,
    });
  });

  app.post('/api/deriv/trade', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated with Deriv.' });
      return;
    }
    const symbol = String(req.body?.symbol || 'R_25');
    const contractType = String(req.body?.contractType || 'DIGITDIFF') as ContractTypeOption;
    const barrier =
      typeof req.body?.barrier === 'number' ? req.body.barrier : undefined;
    const stake = Math.max(0.35, Number(req.body?.stake) || 1);
    const durationUnit = (String(req.body?.durationUnit || 't') as DurationUnit);
    const durationTicks = Math.min(
      365,
      Math.max(1, Number(req.body?.durationTicks) || 1),
    );
    const multiplier =
      typeof req.body?.multiplier === 'number' ? req.body.multiplier : undefined;
    const rawLimit = req.body?.limitOrder as
      | { takeProfit?: number; stopLoss?: number }
      | undefined;
    const limitOrder =
      rawLimit && (typeof rawLimit.takeProfit === 'number' || typeof rawLimit.stopLoss === 'number')
        ? {
            takeProfit:
              typeof rawLimit.takeProfit === 'number' && rawLimit.takeProfit > 0
                ? rawLimit.takeProfit
                : undefined,
            stopLoss:
              typeof rawLimit.stopLoss === 'number' && rawLimit.stopLoss > 0
                ? rawLimit.stopLoss
                : undefined,
          }
        : undefined;

    const outcome = await executeDerivContract(session, {
      symbol,
      contractType,
      barrier,
      stake,
      durationTicks,
      durationUnit,
      multiplier,
      limitOrder,
    });

    if ('error' in outcome) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    res.json(outcome);
  });

  app.post('/api/deriv/sell', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated with Deriv.' });
      return;
    }
    const contractId = req.body?.contractId;
    if (!contractId) {
      res.status(400).json({ error: 'Missing contractId.' });
      return;
    }
    const rpc = await sendSessionDerivRpc<{
      sell?: { contract_id: number | string; sold_for: number; balance_after?: number };
    }>(session, { sell: Number(contractId) || contractId, price: 0 }, 8000);

    if ('error' in rpc) {
      res.status(400).json({ error: rpc.error });
      return;
    }
    const active = session.accounts.find((a) => a.accountId === session.activeAccountId);
    if (active && typeof rpc.sell?.balance_after === 'number') {
      active.balance = Number(rpc.sell.balance_after);
    }
    res.json({
      contractId: String(rpc.sell?.contract_id ?? contractId),
      soldFor: Number(rpc.sell?.sold_for ?? 0),
      balance: active?.balance ?? 0,
    });
  });

  app.post('/api/deriv/logout', (req, res) => {
    const sid = getSessionIdFromReq(req);
    if (sid && userSessions.has(sid)) {
      userSessions.get(sid)?.ws?.close();
      userSessions.delete(sid);
    }
    res.setHeader('Set-Cookie', buildSessionCookie(req, '', 0));
    res.json(sanitizeSessionPayload(envDefaultSession));
  });

  // =========================================================================
  // Extended Deriv Trading & Account Services Endpoints
  // =========================================================================

  // 1. Live Deriv Server Status, Time & Payout Currencies
  app.get('/api/deriv/status', async (_req, res) => {
    const [timeRes, siteRes, currRes] = await Promise.all([
      sendPublicDerivRpc<{ time?: number }>({ time: 1 }, 6000),
      sendPublicDerivRpc<{
        website_status?: {
          site_status?: string;
          currencies_config?: Record<string, unknown>;
        };
      }>({ website_status: 1 }, 4000),
      sendPublicDerivRpc<{ payout_currencies?: string[] }>({ payout_currencies: 1 }, 4000),
    ]);

    const derivReachable = !('error' in timeRes) || (feedStatus.connected && feedStatus.source === 'deriv-ws');
    const siteStatus =
      !('error' in siteRes)
        ? siteRes.website_status?.site_status || 'up'
        : derivReachable
          ? 'up'
          : 'unreachable';
    const currenciesConfigCount =
      !('error' in siteRes) && siteRes.website_status?.currencies_config
        ? Object.keys(siteRes.website_status.currencies_config).length
        : 7;
    const serverTime =
      !('error' in timeRes) && typeof timeRes.time === 'number'
        ? timeRes.time
        : Math.floor(Date.now() / 1000);
    const payoutCurrencies =
      !('error' in currRes) && Array.isArray(currRes.payout_currencies)
        ? currRes.payout_currencies
        : ['USD', 'EUR', 'GBP', 'AUD', 'BTC', 'ETH', 'USDT'];

    res.json({
      appId: DERIV_APP_ID,
      allowRealTrading: ALLOW_REAL_TRADING,
      serverTime,
      siteStatus,
      currenciesConfigCount,
      payoutCurrencies,
      feedStatus,
    });
  });

  // 2. Live Contracts Supported For Symbol (contracts_for)
  app.get('/api/deriv/contracts-for', async (req, res) => {
    const symbol = resolveSymbolForSubscription(String(req.query.symbol || 'R_25'));
    const rpc = await sendPublicDerivRpc<{
      contracts_for?: {
        available?: {
          contract_type: string;
          contract_display?: string;
          contract_category: string;
          contract_category_display?: string;
          min_contract_duration?: string;
          max_contract_duration?: string;
          barriers?: number;
          barrier_category?: string;
          sentiment?: string;
          multiplier_range?: number[];
        }[];
        close?: number;
        open?: number;
        spot?: number;
      };
    }>({ contracts_for: symbol }, 8000);

    if ('error' in rpc) {
      res.status(502).json({ error: rpc.error });
      return;
    }
    const available = (rpc.contracts_for?.available ?? []).map((spec) => ({
      contract_type: spec.contract_type,
      contract_display: spec.contract_display || spec.contract_type,
      contract_category: spec.contract_category,
      contract_category_display: spec.contract_category_display || spec.contract_category,
      min_contract_duration: spec.min_contract_duration || '1t',
      max_contract_duration: spec.max_contract_duration || '365d',
      barriers: Number(spec.barriers ?? 0),
      barrier_category: spec.barrier_category,
      sentiment: spec.sentiment,
      multiplier_range: spec.multiplier_range,
    }));
    res.json({
      symbol,
      available,
      spot: rpc.contracts_for?.spot ?? null,
      open: rpc.contracts_for?.open ?? null,
      close: rpc.contracts_for?.close ?? null,
    });
  });

  // 3. Live OHLC Candles (ticks_history style=candles)
  app.get('/api/deriv/candles', async (req, res) => {
    const symbol = resolveSymbolForSubscription(String(req.query.symbol || 'R_25'));
    const granularity = Math.min(86400, Math.max(60, Number(req.query.granularity) || 60));
    const count = Math.min(300, Math.max(20, Number(req.query.count) || 80));

    const rpc = await sendPublicDerivRpc<{
      candles?: {
        epoch: number;
        open: number;
        high: number;
        low: number;
        close: number;
      }[];
    }>(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: 'latest',
        granularity,
        style: 'candles',
      },
      8000,
    );

    if (!('error' in rpc) && Array.isArray(rpc.candles) && rpc.candles.length > 0) {
      res.json({
        symbol,
        granularity,
        candles: rpc.candles.map((c) => ({
          epoch: Number(c.epoch),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        })),
        source: 'deriv-ws',
      });
      return;
    }

    // Aggregate buffered ticks cleanly into OHLC candles if upstream candles timed out
    seedLocalHistory(symbol);
    const ticks = tickBuffers.get(symbol) ?? [];
    const buckets = new Map<number, { epoch: number; open: number; high: number; low: number; close: number }>();
    for (const t of ticks) {
      const bucketEpoch = Math.floor(t.epoch / granularity) * granularity;
      const existing = buckets.get(bucketEpoch);
      if (!existing) {
        buckets.set(bucketEpoch, {
          epoch: bucketEpoch,
          open: t.quote,
          high: t.quote,
          low: t.quote,
          close: t.quote,
        });
      } else {
        existing.high = Math.max(existing.high, t.quote);
        existing.low = Math.min(existing.low, t.quote);
        existing.close = t.quote;
      }
    }
    res.json({
      symbol,
      granularity,
      candles: Array.from(buckets.values()).slice(-count),
      source: 'tick-aggregated',
    });
  });

  // 4. Live Global Trading Times (trading_times)
  app.get('/api/deriv/trading-times', async (req, res) => {
    const date = String(req.query.date || 'today').trim() || 'today';
    const rpc = await sendPublicDerivRpc<{
      trading_times?: { markets?: unknown[] };
    }>({ trading_times: date }, 9000);

    if ('error' in rpc) {
      res.status(502).json({ error: rpc.error });
      return;
    }
    res.json({
      date,
      markets: rpc.trading_times?.markets ?? [],
    });
  });

  // 5. Live FX & Crypto Exchange Rates (Deriv exchange_rates or derived from live Deriv spot feeds)
  app.get('/api/deriv/rates', async (req, res) => {
    const base = String(req.query.base || 'USD').trim().toUpperCase() || 'USD';
    const rpc = await sendPublicDerivRpc<{
      exchange_rates?: { base_currency?: string; date?: number; rates?: Record<string, number> };
    }>({ exchange_rates: 1, base_currency: base }, 4500);

    if (!('error' in rpc) && rpc.exchange_rates?.rates) {
      res.json({
        baseCurrency: rpc.exchange_rates.base_currency ?? base,
        date: rpc.exchange_rates.date ?? Math.floor(Date.now() / 1000),
        rates: rpc.exchange_rates.rates,
      });
      return;
    }

    // Derive live spot rates directly from Deriv market ticks (EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, BTC/USD, ETH/USD, XAU/USD, XAG/USD)
    const pairs = [
      { sym: 'frxEURUSD', key: 'EUR', invert: true },
      { sym: 'frxGBPUSD', key: 'GBP', invert: true },
      { sym: 'frxAUDUSD', key: 'AUD', invert: true },
      { sym: 'frxNZDUSD', key: 'NZD', invert: true },
      { sym: 'frxUSDJPY', key: 'JPY', invert: false },
      { sym: 'frxUSDCAD', key: 'CAD', invert: false },
      { sym: 'frxUSDCHF', key: 'CHF', invert: false },
      { sym: 'cryBTCUSD', key: 'BTC', invert: true },
      { sym: 'cryETHUSD', key: 'ETH', invert: true },
      { sym: 'frxXAUUSD', key: 'XAU', invert: true },
      { sym: 'frxXAGUSD', key: 'XAG', invert: true },
    ];

    const spotResults = await Promise.all(
      pairs.map(async (p) => {
        const buf = tickBuffers.get(p.sym);
        const recent = buf?.[buf.length - 1];
        if (recent && Math.floor(Date.now() / 1000) - recent.epoch < 60) {
          return { ...p, quote: recent.quote, epoch: recent.epoch };
        }
        const h = await sendPublicDerivRpc<{
          history?: { prices?: number[]; times?: number[] };
        }>({ ticks_history: p.sym, count: 1, end: 'latest', style: 'ticks' }, 5000);
        if (!('error' in h) && h.history?.prices?.length) {
          return {
            ...p,
            quote: Number(h.history.prices[h.history.prices.length - 1]),
            epoch: Number(h.history.times?.[h.history.times.length - 1] ?? Math.floor(Date.now() / 1000)),
          };
        }
        return null;
      }),
    );

    const usdRates: Record<string, number> = { USD: 1, USDT: 1 };
    let latestEpoch = Math.floor(Date.now() / 1000);
    for (const item of spotResults) {
      if (!item || !Number.isFinite(item.quote) || item.quote <= 0) continue;
      usdRates[item.key] = item.invert ? 1 / item.quote : item.quote;
      latestEpoch = Math.max(latestEpoch, item.epoch);
    }

    const basePerUsd = usdRates[base];
    if (!basePerUsd) {
      res.status(502).json({ error: `Exchange rate base ${base} is temporarily unavailable.` });
      return;
    }

    const rebased: Record<string, number> = {};
    for (const [k, perUsd] of Object.entries(usdRates)) {
      if (k !== base) {
        rebased[k] = Number((perUsd / basePerUsd).toFixed(k === 'BTC' || k === 'ETH' ? 8 : 5));
      }
    }

    res.json({
      baseCurrency: base,
      date: latestEpoch,
      rates: rebased,
    });
  });

  // 6. Live Pre-Trade Proposal Price & Payout Quote (proposal)
  app.post('/api/deriv/proposal', async (req, res) => {
    const symbol = resolveSymbolForSubscription(String(req.body?.symbol || 'R_25'));
    const contractType = String(req.body?.contractType || 'CALL').toUpperCase();
    const stake = Math.max(0.35, Number(req.body?.stake) || 10);
    const durationTicks = Math.min(365, Math.max(1, Number(req.body?.durationTicks) || 5));
    const durationUnit = String(req.body?.durationUnit || 't');
    const barrier =
      typeof req.body?.barrier === 'number' ? req.body.barrier : undefined;
    const multiplier =
      typeof req.body?.multiplier === 'number' ? req.body.multiplier : undefined;

    const session = getSessionForReq(req);
    const activeAcc = session?.accounts.find((a) => a.accountId === session.activeAccountId);
    const currency = String(req.body?.currency || activeAcc?.currency || 'USD');

    const isMultiplier = contractType === 'MULTUP' || contractType === 'MULTDOWN';
    const needsBarrier =
      contractType === 'DIGITMATCH' ||
      contractType === 'DIGITDIFF' ||
      contractType === 'DIGITOVER' ||
      contractType === 'DIGITUNDER';

    const payload: Record<string, unknown> = {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency,
    };
    if (isMultiplier) {
      payload.multiplier = multiplier || 100;
    } else {
      payload.duration = durationTicks;
      payload.duration_unit = durationUnit;
    }
    if (needsBarrier && typeof barrier === 'number') {
      payload.barrier = String(barrier);
    }

    let rpc:
      | ({
          proposal?: {
            id: string;
            ask_price: number;
            payout: number;
            spot: number;
            date_start?: number;
            spot_time?: number;
            longcode?: string;
          };
        } & { msg_type?: string })
      | { error: string };

    if (session && session.protocol === 'v3-ws') {
      rpc = await sendSessionDerivRpc(session, { ...payload, symbol }, 7000);
    } else if (session) {
      rpc = await sendSessionDerivRpc(session, { ...payload, underlying_symbol: symbol }, 7000);
    } else {
      rpc = await sendPublicDerivRpc({ ...payload, underlying_symbol: symbol }, 7000);
    }

    if ('error' in rpc || !rpc.proposal) {
      res.status(400).json({ error: 'error' in rpc ? rpc.error : 'Proposal quote unavailable.' });
      return;
    }

    const askPrice = Number(rpc.proposal.ask_price ?? stake);
    const payout = Number(rpc.proposal.payout ?? 0);
    const impliedReturnPct =
      askPrice > 0 && payout > 0 ? Number((((payout - askPrice) / askPrice) * 100).toFixed(1)) : 0;
    const breakEvenPct =
      payout > 0 && askPrice > 0 ? Number(((askPrice / payout) * 100).toFixed(1)) : 0;

    res.json({
      quote: {
        id: rpc.proposal.id,
        ask_price: askPrice,
        payout,
        spot: Number(rpc.proposal.spot ?? 0),
        spot_time: Number(rpc.proposal.spot_time ?? rpc.proposal.date_start ?? Math.floor(Date.now() / 1000)),
        longcode: rpc.proposal.longcode || `${contractType} on ${symbol}`,
        impliedReturnPct,
        breakEvenPct,
      },
    });
  });

  // 7. Live Authenticated Open Portfolio (portfolio)
  app.get('/api/deriv/portfolio', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Sign in with your Deriv account to view open portfolio.' });
      return;
    }
    const rpc = await sendSessionDerivRpc<{
      portfolio?: {
        contracts?: {
          contract_id: number | string;
          symbol?: string;
          underlying?: string;
          contract_type: string;
          shortcode: string;
          buy_price: number;
          payout: number;
          date_start: number;
          expiry_time?: number;
          currency?: string;
        }[];
      };
    }>(session, { portfolio: 1 }, 9000);

    if ('error' in rpc) {
      res.status(400).json({ error: rpc.error });
      return;
    }
    const activeAcc = session.accounts.find((a) => a.accountId === session.activeAccountId);
    const contracts = (rpc.portfolio?.contracts ?? []).map((c) => ({
      contract_id: String(c.contract_id),
      symbol: c.symbol || c.underlying || '—',
      contract_type: c.contract_type,
      shortcode: c.shortcode,
      buy_price: Number(c.buy_price ?? 0),
      payout: Number(c.payout ?? 0),
      date_start: Number(c.date_start ?? 0),
      expiry_time: c.expiry_time ? Number(c.expiry_time) : undefined,
      currency: c.currency || activeAcc?.currency || 'USD',
    }));
    res.json({ contracts });
  });

  // 8. Live Single Contract Status / Settlement Poller (proposal_open_contract without subscription)
  app.get('/api/deriv/contract/:contractId', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated with Deriv.' });
      return;
    }
    const contractId = req.params.contractId;
    const rpc = await sendSessionDerivRpc<{
      proposal_open_contract?: {
        contract_id: number | string;
        is_sold?: number | boolean;
        status?: string;
        entry_spot?: number | string;
        entry_spot_display_value?: string;
        exit_tick?: number | string;
        exit_tick_display_value?: string;
        exit_spot?: number | string;
        exit_spot_display_value?: string;
        current_spot?: number | string;
        bid_price?: number;
        sell_price?: number;
        payout?: number;
        profit?: number;
        buy_price?: number;
      };
    }>(
      session,
      { proposal_open_contract: 1, contract_id: Number(contractId) || contractId },
      7000,
    );

    if ('error' in rpc || !rpc.proposal_open_contract) {
      res.status(400).json({ error: 'error' in rpc ? rpc.error : 'Contract unavailable.' });
      return;
    }
    const poc = rpc.proposal_open_contract;
    const isSettled =
      poc.is_sold === 1 || poc.is_sold === true || poc.status === 'won' || poc.status === 'lost';
    const profit = Number(poc.profit ?? 0);
    const won = poc.status === 'won' || (isSettled && profit > 0);
    const payout = isSettled ? (won ? Number(poc.sell_price ?? poc.payout ?? 0) : 0) : Number(poc.payout ?? 0);
    const activeAcc = session.accounts.find((a) => a.accountId === session.activeAccountId);

    res.json({
      contractId: String(poc.contract_id),
      isSold: isSettled,
      won,
      status: isSettled ? (won ? 'won' : 'lost') : 'open',
      entrySpot: poc.entry_spot_display_value || (poc.entry_spot != null ? String(poc.entry_spot) : '—'),
      exitSpot: isSettled
        ? poc.exit_tick_display_value ||
          poc.exit_spot_display_value ||
          (poc.exit_tick != null ? String(poc.exit_tick) : poc.exit_spot != null ? String(poc.exit_spot) : '—')
        : 'OPEN',
      currentSpot: poc.current_spot != null ? Number(poc.current_spot) : null,
      bidPrice: poc.bid_price != null ? Number(poc.bid_price) : null,
      payout,
      profit,
      balance: activeAcc?.balance ?? 0,
    });
  });

  // 9. Live Closed Profit Table (profit_table)
  app.get('/api/deriv/profit-table', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Sign in with your Deriv account to view Profit Table.' });
      return;
    }
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));
    const rpc = await sendSessionDerivRpc<{
      profit_table?: {
        transactions?: {
          contract_id: number | string;
          transaction_id: number | string;
          shortcode: string;
          contract_type?: string;
          underlying_symbol?: string;
          buy_price: number;
          sell_price: number;
          payout: number;
          purchase_time: number;
          sell_time: number;
          longcode: string;
        }[];
      };
    }>(session, { profit_table: 1, description: 1, sort: 'DESC', limit }, 9000);

    if ('error' in rpc) {
      res.status(400).json({ error: rpc.error });
      return;
    }

    const items = (rpc.profit_table?.transactions ?? []).map((t) => {
      const buy = Number(t.buy_price ?? 0);
      const sell = Number(t.sell_price ?? 0);
      return {
        contract_id: String(t.contract_id),
        transaction_id: String(t.transaction_id),
        shortcode: t.shortcode,
        contract_type: t.contract_type,
        underlying_symbol: t.underlying_symbol,
        buy_price: buy,
        sell_price: sell,
        payout: Number(t.payout ?? 0),
        profit: Number((sell - buy).toFixed(2)),
        purchase_time: Number(t.purchase_time ?? 0),
        sell_time: Number(t.sell_time ?? 0),
        longcode: t.longcode,
      };
    });
    res.json({ transactions: items });
  });

  // 10. Live Account Ledger Statement (statement)
  app.get('/api/deriv/statement', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Sign in with your Deriv account to view Statement.' });
      return;
    }
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 25));
    const rpc = await sendSessionDerivRpc<{
      statement?: {
        transactions?: {
          transaction_id: number | string;
          contract_id?: number | string;
          action_type: string;
          amount: number;
          balance_after: number;
          transaction_time: number;
          shortcode?: string;
          longcode?: string;
        }[];
      };
    }>(session, { statement: 1, description: 1, limit }, 9000);

    if ('error' in rpc) {
      res.status(400).json({ error: rpc.error });
      return;
    }
    const items = (rpc.statement?.transactions ?? []).map((t) => ({
      transaction_id: String(t.transaction_id),
      contract_id: t.contract_id != null ? String(t.contract_id) : undefined,
      action_type: t.action_type,
      amount: Number(t.amount ?? 0),
      balance_after: Number(t.balance_after ?? 0),
      transaction_time: Number(t.transaction_time ?? 0),
      shortcode: t.shortcode,
      longcode: t.longcode,
    }));
    res.json({ transactions: items });
  });

  // 11. Live Account Limits, Profile Settings & Verification Status (get_limits, get_settings, get_account_status)
  app.get('/api/deriv/account-profile', async (req, res) => {
    const session = getSessionForReq(req);
    if (!session) {
      res.status(401).json({ error: 'Sign in with your Deriv account to view Account Limits & Settings.' });
      return;
    }
    const activeAcc = session.accounts.find((a) => a.accountId === session.activeAccountId);

    const [limitsRpc, settingsRpc, statusRpc] = await Promise.all([
      sendSessionDerivRpc<{ get_limits?: Record<string, unknown> }>(session, { get_limits: 1 }, 8000),
      sendSessionDerivRpc<{ get_settings?: Record<string, unknown> }>(session, { get_settings: 1 }, 8000),
      sendSessionDerivRpc<{ get_account_status?: Record<string, unknown> }>(session, { get_account_status: 1 }, 8000),
    ]);

    res.json({
      accountId: activeAcc?.accountId ?? session.activeAccountId,
      accountType: activeAcc?.accountType ?? null,
      currency: activeAcc?.currency ?? 'USD',
      limits: !('error' in limitsRpc) ? (limitsRpc.get_limits ?? null) : null,
      settings: !('error' in settingsRpc) ? (settingsRpc.get_settings ?? null) : null,
      status: !('error' in statusRpc) ? (statusRpc.get_account_status ?? null) : null,
    });
  });

  // Server-side Gemini AI Universal Quantitative Bot Builder
  app.post('/api/ai/bot-builder', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'GEMINI_API_KEY is not configured in environment secrets. Please set GEMINI_API_KEY in Settings > Secrets to use AI Bot Builder.',
      });
      return;
    }

    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) {
      res.status(400).json({ error: 'Please describe the strategy you want to build.' });
      return;
    }

    try {
      const sourceMarkets = liveMarketsList.length > 0 ? liveMarketsList : DERIV_MARKETS;
      const symbolList = sourceMarkets
        .slice(0, 60)
        .map((m) => `${m.symbol} (${m.name}, ${m.marketGroup})`)
        .join(', ');
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Design a complete, institutional-grade quantitative trading bot configuration for this request: "${prompt}".
Sample Deriv symbols (plus any valid Deriv symbol): ${symbolList}.
Trade categories: Digits, Up/Down, Multipliers.
Trade types: Matches/Differs, Even/Odd, Over/Under, Rise/Fall, Multipliers.
Contract types: DIGITMATCH, DIGITDIFF, DIGITEVEN, DIGITODD, DIGITOVER, DIGITUNDER, CALL, PUT, MULTUP, MULTDOWN, Both.
Duration units: t (ticks), s (seconds), m (minutes), h (hours), d (days).
  - Rules: Forex & Stock Indices require >=15m for Rise/Fall; Metals require >=5m; Cryptocurrencies & Crash/Boom support Multipliers (MULTUP/MULTDOWN); Volatility & Jump indices support 1t-10t Digits & Rise/Fall.
Condition modes (pick the strongest winning logic matching the prompt):
  - best_quant_edge (Multi-Factor Quant Confluence + Positive EV Gate)
  - dual_zscore_digit (Dual-Window 400t/50t Binomial Z-Score Cold Digit Sniper + Anti-Cluster)
  - ema_bullish, ema_bearish, rsi_oversold, rsi_overbought, digit_pct_lte, digit_pct_gte, even_streak_gte, odd_streak_gte, trend_up, trend_down, always.
Always enforce strict capital protection & winning-only gating when appropriate:
  - Set perfectConditionsOnly=true and minConfidence>=80, minEvPct>=1.8 if user asks for safest/perfect/high-win-rate entries.
  - Use capped recovery (maxRecoverySteps=2, useMartingale=true, martingaleMultiplier=2.1) or flat sizing as requested.
  - Set fractional risk (useFractionalBalanceRisk=true, baseRiskPct=1.5) & daily % locks if balance-based risk or capital protection is requested.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          systemInstruction:
            'You are a quantitative Deriv options systems architect. Convert ANY natural-language bot request into high-conviction, positive-expected-value, risk-capped execution parameters and indicator gates.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              description: { type: Type.STRING },
              symbol: { type: Type.STRING },
              tradeCategory: { type: Type.STRING },
              tradeType: { type: Type.STRING },
              contractType: { type: Type.STRING },
              stake: { type: Type.NUMBER },
              durationTicks: { type: Type.INTEGER },
              durationUnit: { type: Type.STRING },
              multiplier: { type: Type.INTEGER },
              predictionDigit: { type: Type.INTEGER },
              conditionMode: { type: Type.STRING },
              thresholdPct: { type: Type.NUMBER },
              streakLength: { type: Type.INTEGER },
              dualZScoreThreshold: { type: Type.NUMBER },
              minConfidence: { type: Type.NUMBER },
              minEvPct: { type: Type.NUMBER },
              minSlopeRatio: { type: Type.NUMBER },
              rsiMin: { type: Type.NUMBER },
              rsiMax: { type: Type.NUMBER },
              bbMinPct: { type: Type.NUMBER },
              bbMaxPct: { type: Type.NUMBER },
              antiClusterTicks: { type: Type.INTEGER },
              perfectConditionsOnly: { type: Type.BOOLEAN },
              useMartingale: { type: Type.BOOLEAN },
              martingaleMultiplier: { type: Type.NUMBER },
              maxRecoverySteps: { type: Type.INTEGER },
              useFractionalBalanceRisk: { type: Type.BOOLEAN },
              baseRiskPct: { type: Type.NUMBER },
              useDailyPctLocks: { type: Type.BOOLEAN },
              dailyProfitTargetPct: { type: Type.NUMBER },
              dailyMaxLossPct: { type: Type.NUMBER },
              lossCooldownSeconds: { type: Type.INTEGER },
              lockLosingDigitOnLoss: { type: Type.BOOLEAN },
              takeProfit: { type: Type.NUMBER },
              stopLoss: { type: Type.NUMBER },
              reasoning: { type: Type.STRING },
            },
            required: [
              'name',
              'description',
              'symbol',
              'tradeCategory',
              'tradeType',
              'contractType',
              'stake',
              'durationTicks',
              'durationUnit',
              'predictionDigit',
              'conditionMode',
              'minConfidence',
              'minEvPct',
              'perfectConditionsOnly',
              'useMartingale',
              'martingaleMultiplier',
              'takeProfit',
              'stopLoss',
              'reasoning',
            ],
          },
        },
      });

      const parsed = JSON.parse((response.text ?? '{}').trim());
      res.json({ strategy: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemini request failed';
      res.status(502).json({ error: message });
    }
  });

  // Server-side Gemini AI Auto Market Analysis
  app.post('/api/ai/analyze', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'GEMINI_API_KEY is not configured in environment secrets. Please set GEMINI_API_KEY in Settings > Secrets to run AI Auto Analysis.',
      });
      return;
    }

    const symbol = String(req.body?.symbol || 'R_25');
    const meta = getMarketMeta(symbol);
    seedLocalHistory(symbol);
    const ticks = tickBuffers.get(symbol) ?? [];
    const recent = ticks.slice(-1000);
    if (recent.length < 10) {
      res.status(400).json({ error: 'Not enough live ticks collected yet for analysis.' });
      return;
    }

    const digitCounts = Array.from({ length: 10 }, () => 0);
    for (const t of recent) {
      digitCounts[t.lastDigit] = (digitCounts[t.lastDigit] || 0) + 1;
    }
    const digitPcts = digitCounts.map((c, d) => ({
      digit: d,
      count: c,
      pct: Number(((c / recent.length) * 100).toFixed(1)),
    }));
    const quant1000 = recent.length >= 25 ? analyzeMarketTicks(recent, meta, 1000, 10) : null;
    const markov1000 = recent.length >= 20 ? computeMarkovTransitionSurvival(recent, 1000) : null;
    const last15Prices = recent.slice(-15).map((t) => t.formattedQuote);
    const clientSummary = req.body?.metrics ? JSON.stringify(req.body.metrics) : 'none';

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Analyze live 1,000-tick market telemetry for ${symbol} (${meta.name}, Group: ${meta.marketGroup}, SubGroup: ${meta.subGroup}).
Allowed Contract Capabilities: supportsDigits=${Boolean(meta.supportsDigits)}, supportsRiseFall=${Boolean(meta.supportsRiseFall)}, supportsMultipliers=${Boolean(meta.supportsMultipliers)}, defaultDuration=${meta.defaultDuration ?? 1}${meta.defaultDurationUnit ?? 't'}.
Full Sample depth analyzed: ${recent.length} ticks (past 1000-tick horizon).
Technical metrics: ${clientSummary}.
1000t Backtest Summary: ${
          quant1000
            ? `Regime=${quant1000.regime}, Trend=${quant1000.trendDirection}, RSI14=${quant1000.rsi14}, Volatility=${quant1000.volatilityBps}bps, TopEdge=${quant1000.topOpportunity?.contractType ?? 'none'} (Win ${quant1000.topOpportunity?.winRatePct ?? 0}% vs BE ${quant1000.topOpportunity?.breakEvenPct ?? 0}%, EV ${quant1000.topOpportunity?.expectedValuePct ?? 0}%)`
            : 'warming up'
        }.
Markov Conditional Survival by Digit (given lastDigit=${markov1000?.currentLastDigit ?? 'N/A'}): ${
          markov1000 ? JSON.stringify(markov1000.differSurvivalPctByDigit) : 'unavailable'
        }.
Digit frequency distribution (0-9 over ${recent.length} ticks): ${JSON.stringify(digitPcts)}.
Last 15 quotes: ${last15Prices.join(', ')}.
IMPORTANT: Only recommend contract types supported by this market!
- If supportsDigits is false and supportsRiseFall is true (e.g. Forex, Commodities, Stock Indices, Step Indices), recommend Rise/Fall (CALL or PUT) with valid duration (e.g. ${meta.defaultDuration ?? 15}${meta.defaultDurationUnit ?? 'm'}).
- If supportsRiseFall is false and supportsMultipliers is true (e.g. Cryptocurrencies, Crash/Boom), recommend Multipliers (MULTUP or MULTDOWN).
- If supportsDigits is true, evaluate both Digits (DIGITDIFF, DIGITOVER, DIGITUNDER, DIGITEVEN, DIGITODD) and Rise/Fall (CALL, PUT) across the 1000-tick horizon and Markov survival, and pick the highest expected-value setup.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          systemInstruction:
            'You are a concise quantitative microstructure & options strategist analyzing full 1000-tick histories. Return valid, risk-managed Deriv contract configurations matching the market capabilities.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              symbol: { type: Type.STRING },
              regime: { type: Type.STRING },
              biasSummary: { type: Type.STRING },
              recommendedTradeType: { type: Type.STRING },
              recommendedContract: { type: Type.STRING },
              targetDigit: { type: Type.INTEGER },
              confidenceNote: { type: Type.STRING },
              riskWarning: { type: Type.STRING },
              suggestedStake: { type: Type.NUMBER },
              suggestedDurationTicks: { type: Type.INTEGER },
              suggestedDurationUnit: { type: Type.STRING },
            },
            required: [
              'symbol',
              'regime',
              'biasSummary',
              'recommendedTradeType',
              'recommendedContract',
              'targetDigit',
              'confidenceNote',
              'riskWarning',
              'suggestedStake',
              'suggestedDurationTicks',
              'suggestedDurationUnit',
            ],
          },
        },
      });

      const analysis = JSON.parse((response.text ?? '{}').trim()) as AiAnalysisResult;
      res.json({ analysis, sampleSize1000: recent.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemini analysis failed';
      res.status(502).json({ error: message });
    }
  });

  // Server-side Gemini AI Quantitative Auto-Scanner Endpoint (Full 1,000-Tick + Markov Horizon)
  app.post('/api/ai/scanner', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'GEMINI_API_KEY is not configured in environment secrets. Please set GEMINI_API_KEY in Settings > Secrets to run AI Scanner.',
      });
      return;
    }

    const symbol = String(req.body?.symbol || 'R_25');
    const fastMode = Boolean(req.body?.fastMode);
    const meta = getMarketMeta(symbol);
    seedLocalHistory(symbol);
    const serverTicks = tickBuffers.get(symbol) ?? [];
    const clientPrices = Array.isArray(req.body?.prices)
      ? (req.body.prices as unknown[])
          .map((p) => Number(p))
          .filter((p) => Number.isFinite(p) && p > 0)
      : [];

    const evalTicks = serverTicks.slice(-1000);
    const recentPrices =
      evalTicks.length >= 20
        ? evalTicks.slice(-25).map((t) => t.quote)
        : clientPrices.slice(-25);

    if (recentPrices.length < 20) {
      res.status(400).json({ error: 'Need at least 20 live ticks to evaluate AI scanner regime.' });
      return;
    }

    const regime = computeLocalRegimeFilter(recentPrices, 20, 0.6);
    const quantSummary =
      evalTicks.length >= 25 ? analyzeMarketTicks(evalTicks, meta, 1000, 10) : null;
    const markov1000 =
      evalTicks.length >= 25 ? computeMarkovTransitionSurvival(evalTicks, 1000) : null;
    const dtrader1000 =
      meta.supportsDigits && evalTicks.length >= 120
        ? evaluateDtraderPerfectSetup(evalTicks, meta, { minBufferTicks: 300 })
        : null;

    const hasStrongDigitEdge = Boolean(dtrader1000?.allGatesPassed);

    if (!regime.valid && !hasStrongDigitEdge) {
      const holdSignal: AiScannerSignal = {
        symbol,
        action: 'HOLD',
        confidence_score: 0,
        contract_type: meta.supportsRiseFall
          ? 'CALL'
          : meta.supportsMultipliers
            ? 'MULTUP'
            : 'DIGITDIFF',
        barrier: dtrader1000?.barrier ?? 4,
        duration: meta.defaultDuration ?? 1,
        duration_unit: meta.defaultDurationUnit ?? 't',
        multiplier: meta.supportsMultipliers ? 100 : undefined,
        sampleSize1000: evalTicks.length,
        markovEdgePct: dtrader1000?.markovSurvivalPct,
        modelUsed: fastMode ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen',
        rationale: `Blocked locally over ${evalTicks.length}t: choppy regime (slopeRatio ${regime.slopeRatio} <= 0.60 stdDev) and 7-gate DTrader not armed.`,
      };
      res.json({ signal: holdSignal, regime, appId: DERIV_APP_ID, aiSkipped: true });
      return;
    }

    const allowedContracts: ContractTypeOption[] = [];
    if (meta.supportsRiseFall !== false) allowedContracts.push('CALL', 'PUT');
    if (meta.supportsMultipliers) allowedContracts.push('MULTUP', 'MULTDOWN');
    if (meta.supportsDigits) {
      allowedContracts.push('DIGITDIFF', 'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD');
    }
    if (allowedContracts.length === 0) allowedContracts.push('CALL', 'PUT');

    const chosenModel = fastMode ? 'gemini-3.1-flash-lite' : 'gemini-4-hydrogen';
    const chosenThinking = fastMode ? ThinkingLevel.MINIMAL : ThinkingLevel.HIGH;

    try {
      const response = await ai.models.generateContent({
        model: chosenModel,
        contents: `Evaluate 1,000-tick quantitative auto-trade signal for ${symbol} (${meta.name}, ${meta.marketGroup}).
Sample horizon analyzed: ${evalTicks.length} ticks.
Local Pre-Filter Regime (last 20t): direction=${regime.direction}, slope=${regime.slope}, stdDev=${regime.volatility}, slopeRatio=${regime.slopeRatio}.
Last 20 prices: ${recentPrices.slice(-20).join(', ')}.
1,000-Tick Technical & Backtest Summary: ${
          quantSummary
            ? `RSI(14)=${quantSummary.rsi14}, EMA9=${quantSummary.ema9}, EMA21=${quantSummary.ema21}, Bollinger%B=${quantSummary.bollingerPctB}, Vol=${quantSummary.volatilityBps}bps, TopQuant=${quantSummary.topOpportunity?.contractType ?? 'none'} (Win ${quantSummary.topOpportunity?.winRatePct ?? 0}%, EV ${quantSummary.topOpportunity?.expectedValuePct ?? 0}%)`
            : 'unavailable'
        }.
Markov 1000t Conditional Setup: ${
          dtrader1000
            ? `Contract=${dtrader1000.contractType}[${dtrader1000.barrier}], All7Gates=${dtrader1000.allGatesPassed}, Conf=${dtrader1000.confidence}%, EV=${dtrader1000.expectedValuePct}%, MarkovSurvival=${dtrader1000.markovSurvivalPct}%, Horizons(1k/250/60)=${dtrader1000.horizonBreakdown.h1000}/${dtrader1000.horizonBreakdown.h250}/${dtrader1000.horizonBreakdown.h60}%`
            : markov1000
              ? `Markov transitions=${markov1000.sampleTransitions}`
              : 'unavailable'
        }.
Allowed contract types for ${symbol}: ${allowedContracts.join(', ')}.
Default expiry for ${symbol}: ${meta.defaultDuration ?? 1}${meta.defaultDurationUnit ?? 't'}.
Strict rule: Only return action='AUTO_EXECUTE' with confidence_score >= 85 when the 1,000-tick horizon, Markov conditional probability, and momentum alignment strongly favor high-probability win. Otherwise return action='HOLD'.`,
        config: {
          thinkingConfig: { thinkingLevel: chosenThinking },
          systemInstruction:
            'You are a strict institutional Deriv quantitative scanner evaluating 1,000-tick histories and Markov conditional transition probabilities. Be ultra-selective: only approve AUTO_EXECUTE when conviction is >= 85% and contract_type matches symbol capabilities.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING, enum: ['AUTO_EXECUTE', 'HOLD'] },
              confidence_score: { type: Type.NUMBER },
              contract_type: { type: Type.STRING },
              barrier: { type: Type.INTEGER },
              duration: { type: Type.INTEGER },
              duration_unit: { type: Type.STRING },
              multiplier: { type: Type.INTEGER },
              rationale: { type: Type.STRING },
            },
            required: [
              'action',
              'confidence_score',
              'contract_type',
              'barrier',
              'duration',
              'duration_unit',
              'rationale',
            ],
          },
        },
      });

      const raw = JSON.parse((response.text ?? '{}').trim()) as Partial<AiScannerSignal>;
      const candidateContract = String(raw.contract_type || '').toUpperCase() as ContractTypeOption;
      const fallbackDirectional: ContractTypeOption =
        meta.supportsMultipliers && !meta.supportsRiseFall
          ? regime.direction === 'BULLISH'
            ? 'MULTUP'
            : 'MULTDOWN'
          : meta.supportsRiseFall !== false
            ? regime.direction === 'BULLISH'
              ? 'CALL'
              : 'PUT'
            : 'DIGITDIFF';

      const safeContract = allowedContracts.includes(candidateContract)
        ? candidateContract
        : fallbackDirectional;

      const isMult = safeContract === 'MULTUP' || safeContract === 'MULTDOWN';
      const defaultDur = meta.defaultDuration ?? (meta.supportsDigits ? 1 : 15);
      const defaultUnit = meta.defaultDurationUnit ?? (meta.supportsDigits ? 't' : 'm');
      const rawUnit = String(raw.duration_unit || defaultUnit) as DurationUnit;
      const validUnits: DurationUnit[] = ['t', 's', 'm', 'h', 'd'];
      const safeUnit = validUnits.includes(rawUnit) ? rawUnit : defaultUnit;

      let safeDuration = Math.max(1, Number(raw.duration) || defaultDur);
      if (!meta.supportsDigits && !isMult && safeUnit === 't') {
        safeDuration = defaultDur;
      }

      const signal: AiScannerSignal = {
        symbol,
        action: raw.action === 'AUTO_EXECUTE' ? 'AUTO_EXECUTE' : 'HOLD',
        confidence_score: Math.min(100, Math.max(0, Math.round(Number(raw.confidence_score) || 0))),
        contract_type: safeContract,
        barrier: Math.min(9, Math.max(0, Math.round(Number(raw.barrier) || 4))),
        duration: safeDuration,
        duration_unit: !meta.supportsDigits && !isMult && safeUnit === 't' ? defaultUnit : safeUnit,
        multiplier: isMult ? Math.max(20, Number(raw.multiplier) || 100) : undefined,
        rationale: String(raw.rationale || 'Evaluated 1,000-tick horizon and Markov probability.'),
        sampleSize1000: evalTicks.length,
        markovEdgePct: dtrader1000?.markovSurvivalPct,
        modelUsed: chosenModel,
      };

      res.json({ signal, regime, appId: DERIV_APP_ID, aiSkipped: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemini scanner failed';
      res.status(502).json({ error: message });
    }
  });

  // Multi-Turn Gemini Quant Chatbot (Free-Tier Supported: gemini-4-hydrogen & gemini-3.1-flash-lite)
  app.post('/api/ai/chat', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'GEMINI_API_KEY is not configured in environment secrets. Please set GEMINI_API_KEY in Settings > Secrets to use AI Quant Chat.',
      });
      return;
    }

    const message = String(req.body?.message || '').trim();
    if (!message) {
      res.status(400).json({ error: 'Message cannot be empty.' });
      return;
    }

    const symbol = String(req.body?.symbol || 'R_25');
    const rolePreset = String(req.body?.rolePreset || 'architect') as
      | 'architect'
      | 'dtrader'
      | 'scanner'
      | 'fast';
    const includeLiveTelemetry = req.body?.includeLiveTelemetry !== false;
    const rawHistory = Array.isArray(req.body?.history)
      ? (req.body.history as { role?: string; content?: string }[])
      : [];

    const meta = getMarketMeta(symbol);
    seedLocalHistory(symbol);
    const ticks = (tickBuffers.get(symbol) ?? []).slice(-1000);

    let telemetryBlock = '';
    if (includeLiveTelemetry && ticks.length >= 25) {
      const report1000 = analyzeMarketTicks(ticks, meta, 1000, 10);
      const dtrader =
        meta.supportsDigits !== false
          ? evaluateDtraderPerfectSetup(ticks, meta, { minBufferTicks: 300 })
          : null;
      telemetryBlock = `\n[LIVE 1,000-TICK TELEMETRY FOR ${symbol} (${meta.name})]
- Buffer Depth: ${ticks.length} ticks | Latest Price: ${report1000.latestPrice.toFixed(meta.pipSize)}
- Technicals: Regime=${report1000.regime}, Trend=${report1000.trendDirection}, EMA9=${report1000.ema9.toFixed(meta.pipSize)}, EMA21=${report1000.ema21.toFixed(meta.pipSize)}, RSI14=${report1000.rsi14}, Bollinger%B=${report1000.bollingerPctB}%, Vol=${report1000.volatilityBps}bps
- Top 1000t Backtest Edge: ${report1000.topOpportunity ? `${report1000.topOpportunity.contractType}[${report1000.topOpportunity.barrier}] Win=${report1000.topOpportunity.winRatePct}% vs BE=${report1000.topOpportunity.breakEvenPct}%, EV=${report1000.topOpportunity.expectedValuePct}%` : 'none'}
- DTrader 7-Gate Master Status: ${dtrader ? `${dtrader.allGatesPassed ? 'ALL 7 GATES ARMED' : 'WAITING'} | Contract=${dtrader.contractType}[${dtrader.barrier}] | Conf=${dtrader.confidence}% | EV=${dtrader.expectedValuePct}% | MarkovSurvival=${dtrader.markovSurvivalPct}% | 1000/250/60t=${dtrader.horizonBreakdown.h1000}/${dtrader.horizonBreakdown.h250}/${dtrader.horizonBreakdown.h60}% | DualZ=${dtrader.zScore}` : 'N/A for non-digit market'}`;
    }

    const presetConfig: Record<
      'architect' | 'dtrader' | 'scanner' | 'fast',
      { model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite'; thinking: ThinkingLevel; sys: string }
    > = {
      architect: {
        model: 'gemini-4-hydrogen',
        thinking: ThinkingLevel.XHIGH,
        sys: 'You are an institutional Deriv Quantitative Strategy Architect. Design rigorous, positive-EV automated trading strategies, capped 2-step risk controls, and multi-horizon 1,000-tick rules with clear mathematical rationale.',
      },
      dtrader: {
        model: 'gemini-4-hydrogen',
        thinking: ThinkingLevel.HIGH,
        sys: 'You are the Master DTrader Circles Tactician. Focus strictly on 7-gate sniper entries, Markov conditional survival probability, 1000t/250t/60t tri-horizon alignment, 10-tick anti-cluster guards, and strict loss avoidance.',
      },
      scanner: {
        model: 'gemini-4-hydrogen',
        thinking: ThinkingLevel.MEDIUM,
        sys: 'You are a 1,000-Tick Market Scanner Analyst. Explain live volatility, EMA/RSI regime filters, Dual-Z scores, and EV margins concisely using exact numbers from the live telemetry.',
      },
      fast: {
        model: 'gemini-3.1-flash-lite',
        thinking: ThinkingLevel.MINIMAL,
        sys: 'You are a concise, fast quantitative trading assistant. Give crisp, bullet-point answers grounded in the live market metrics.',
      },
    };

    const selectedPreset = presetConfig[rolePreset] ?? presetConfig.architect;
    const historyTurns = rawHistory
      .slice(-16)
      .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: String(m.content).slice(0, 8000) }],
      }));

    const sendWithModel = async (
      modelName: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite',
      thinkingLevel: ThinkingLevel,
    ) => {
      const chat = ai.chats.create({
        model: modelName,
        history: historyTurns,
        config: {
          thinkingConfig: { thinkingLevel },
          systemInstruction: `${selectedPreset.sys}${telemetryBlock}`,
        },
      });
      return chat.sendMessage({ message: message.slice(0, 8000) });
    };

    try {
      let actualModel = selectedPreset.model;
      let response;
      try {
        response = await sendWithModel(selectedPreset.model, selectedPreset.thinking);
      } catch (primaryErr) {
        const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const isTransientDemand =
          primaryMsg.includes('503') ||
          primaryMsg.includes('UNAVAILABLE') ||
          primaryMsg.includes('high demand');
        if (!isTransientDemand) throw primaryErr;

        const fallbackModel =
          selectedPreset.model === 'gemini-3.1-flash-lite'
            ? 'gemini-4-hydrogen'
            : 'gemini-3.1-flash-lite';
        const fallbackThinking =
          fallbackModel === 'gemini-3.1-flash-lite'
            ? ThinkingLevel.MINIMAL
            : ThinkingLevel.MEDIUM;
        actualModel = fallbackModel;
        response = await sendWithModel(fallbackModel, fallbackThinking);
      }

      const reply = (response.text ?? '').trim() || 'No response generated.';
      res.json({
        reply,
        modelUsed: actualModel,
        rolePreset,
        symbol,
        sampleSize1000: ticks.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini chat request failed';
      res.status(502).json({ error: msg });
    }
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  wss.on('error', (err) => {
    console.error('WebSocketServer error:', err);
  });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://localhost');
      if (reqUrl.pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    const defaultSymbol = 'R_25';
    clientSubs.set(ws, defaultSymbol);
    sendToClient(ws, { type: 'feed:status', status: feedStatus });

    seedLocalHistory(defaultSymbol);
    const existing = tickBuffers.get(defaultSymbol);
    if (existing && existing.length > 0) {
      sendToClient(ws, { type: 'history', symbol: defaultSymbol, ticks: existing });
    }
    subscribeUpstreamSymbol(defaultSymbol);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientWsMessage;
        if (msg.type === 'subscribe' && typeof msg.symbol === 'string') {
          const validSym = resolveSymbolForSubscription(msg.symbol);
          clientSubs.set(ws, validSym);
          seedLocalHistory(validSym);
          const buf = tickBuffers.get(validSym);
          if (buf && buf.length > 0) {
            sendToClient(ws, { type: 'history', symbol: validSym, ticks: buf });
          }
          subscribeUpstreamSymbol(validSym);
        }
      } catch {
        // Ignore malformed message
      }
    });

    ws.on('close', () => {
      clientSubs.delete(ws);
    });
    ws.on('error', () => {
      clientSubs.delete(ws);
    });
  });

  // Ensure unmatched /api/* routes and API middleware errors return JSON rather than SPA <!doctype html>
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      error: `API route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  app.use(
    '/api',
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        typeof (err as { status?: unknown }).status === 'number'
          ? (err as { status: number }).status
          : 500;
      const message =
        err instanceof Error ? err.message : 'Unexpected server API error.';
      if (!res.headersSent) {
        res.status(status).json({ error: message });
      }
    },
  );

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`DerivDesk Bot Studio listening on http://0.0.0.0:${port} (App ID: ${DERIV_APP_ID})`);
    connectDerivUpstream(false);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
