import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  BotStrategyConfig,
  ChatRolePreset,
  CloudChatSession,
  CloudStrategyRecord,
  GeminiChatMessage,
  ScannerSessionLogRecord,
} from '../shared/types.ts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
export const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  const serialized = JSON.stringify(errInfo);
  console.error('Firestore Error:', serialized);
  throw new Error(serialized);
}

let connectionTested = false;
export async function testConnection(): Promise<boolean> {
  if (connectionTested) return true;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration (Firestore offline).');
      return false;
    }
    // Missing test/connection document still confirms live Firestore reachability
    return true;
  }
}

function sanitizeSafeId(raw: string, prefix = 'id'): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : `${prefix}_${Date.now()}`;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

function toMillis(ts: unknown): number {
  if (ts instanceof Timestamp) return ts.toMillis();
  if (typeof ts === 'number') return ts;
  return Date.now();
}

export async function signInWithGooglePopup(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutGoogle(): Promise<void> {
  await firebaseSignOut(auth);
}

export async function syncUserProfileToFirestore(user: User): Promise<void> {
  const uid = sanitizeSafeId(user.uid, 'user');
  const publicPath = `users/${uid}`;
  const privatePath = `users/${uid}/private/info`;
  const displayName = (user.displayName || user.email?.split('@')[0] || 'Quant Trader')
    .trim()
    .slice(0, 80);

  try {
    const ref = doc(db, 'users', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const payload: Record<string, unknown> = {
        uid,
        displayName: displayName || 'Quant Trader',
        preferredModel: 'gemini-4-hydrogen',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (user.photoURL && user.photoURL.length <= 500) {
        payload.photoURL = user.photoURL;
      }
      await setDoc(ref, payload);
    } else {
      const existing = snap.data() as Record<string, unknown>;
      const updatePayload: Record<string, unknown> = {
        uid,
        displayName: displayName || String(existing.displayName || 'Quant Trader'),
        preferredModel: existing.preferredModel === 'gemini-3.1-flash-lite'
          ? 'gemini-3.1-flash-lite'
          : 'gemini-4-hydrogen',
        createdAt: existing.createdAt,
        updatedAt: serverTimestamp(),
      };
      if (user.photoURL && user.photoURL.length <= 500) {
        updatePayload.photoURL = user.photoURL;
      } else if (typeof existing.photoURL === 'string') {
        updatePayload.photoURL = existing.photoURL;
      }
      await updateDoc(ref, updatePayload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, publicPath);
  }

  if (user.email) {
    try {
      const privRef = doc(db, 'users', uid, 'private', 'info');
      const privSnap = await getDoc(privRef);
      const email = user.email.trim().slice(0, 160);
      if (!privSnap.exists()) {
        await setDoc(privRef, {
          uid,
          email,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(privRef, {
          uid,
          email,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  }
}

export async function saveStrategyToCloud(
  userId: string,
  strategy: BotStrategyConfig,
): Promise<string> {
  const uid = sanitizeSafeId(userId, 'user');
  const strategyId = sanitizeSafeId(strategy.id || `strat_${Date.now()}`, 'strat');
  const path = `users/${uid}/strategies/${strategyId}`;
  const stakeVal = Math.max(
    0.35,
    Number(strategy.variables.find((v) => v.name === 'stake')?.value ?? 1),
  );
  const cleanConfig = stripUndefinedDeep(strategy);

  try {
    const ref = doc(db, 'users', uid, 'strategies', strategyId);
    const snap = await getDoc(ref);
    const baseData: Record<string, unknown> = {
      ownerId: uid,
      name: (strategy.name || 'Untitled Strategy').trim().slice(0, 120),
      description: (strategy.description || 'Quantitative Deriv strategy').trim().slice(0, 500),
      symbol: (strategy.tradeParams.symbol || 'R_25').slice(0, 32),
      contractType: (strategy.tradeParams.contractType || 'DIGITDIFF').slice(0, 24),
      stake: stakeVal,
      takeProfit: Math.max(0, Number(strategy.restartConditions.takeProfit) || 50),
      stopLoss: Math.max(0, Number(strategy.restartConditions.stopLoss) || 100),
      config: cleanConfig,
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(ref, {
        ...baseData,
        createdAt: serverTimestamp(),
      });
    } else {
      const existing = snap.data() as Record<string, unknown>;
      await updateDoc(ref, {
        ...baseData,
        createdAt: existing.createdAt,
      });
    }
    return strategyId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeUserStrategies(
  userId: string,
  onData: (items: CloudStrategyRecord[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const uid = sanitizeSafeId(userId, 'user');
  const path = `users/${uid}/strategies`;
  const q = query(collection(db, 'users', uid, 'strategies'), orderBy('updatedAt', 'desc'), limit(25));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: CloudStrategyRecord[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          ownerId: String(data.ownerId || uid),
          name: String(data.name || 'Strategy'),
          description: typeof data.description === 'string' ? data.description : '',
          symbol: String(data.symbol || 'R_25'),
          contractType: String(data.contractType || 'DIGITDIFF'),
          stake: Number(data.stake || 1),
          takeProfit: Number(data.takeProfit || 50),
          stopLoss: Number(data.stopLoss || 100),
          config: data.config as BotStrategyConfig,
          updatedAt: toMillis(data.updatedAt),
        };
      });
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    },
  );
}

export async function deleteCloudStrategy(userId: string, strategyId: string): Promise<void> {
  const uid = sanitizeSafeId(userId, 'user');
  const sid = sanitizeSafeId(strategyId, 'strat');
  const path = `users/${uid}/strategies/${sid}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'strategies', sid));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function upsertChatSession(
  userId: string,
  session: {
    chatId: string;
    title: string;
    rolePreset: ChatRolePreset;
    model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
    activeSymbol: string;
  },
): Promise<string> {
  const uid = sanitizeSafeId(userId, 'user');
  const cid = sanitizeSafeId(session.chatId, 'chat');
  const path = `users/${uid}/chats/${cid}`;

  try {
    const ref = doc(db, 'users', uid, 'chats', cid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        title: (session.title || 'Quant Session').trim().slice(0, 100),
        rolePreset: session.rolePreset,
        model: session.model,
        activeSymbol: (session.activeSymbol || 'R_25').slice(0, 32),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const existing = snap.data() as Record<string, unknown>;
      await updateDoc(ref, {
        ownerId: uid,
        title: (session.title || String(existing.title || 'Quant Session')).trim().slice(0, 100),
        rolePreset: session.rolePreset,
        model: session.model,
        activeSymbol: (session.activeSymbol || 'R_25').slice(0, 32),
        createdAt: existing.createdAt,
        updatedAt: serverTimestamp(),
      });
    }
    return cid;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function appendChatMessage(
  userId: string,
  chatId: string,
  msg: {
    id?: string;
    role: 'user' | 'assistant';
    content: string;
    modelUsed: string;
  },
): Promise<void> {
  const uid = sanitizeSafeId(userId, 'user');
  const cid = sanitizeSafeId(chatId, 'chat');
  const mid = sanitizeSafeId(msg.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'msg');
  const path = `users/${uid}/chats/${cid}/messages/${mid}`;

  try {
    await setDoc(doc(db, 'users', uid, 'chats', cid, 'messages', mid), {
      ownerId: uid,
      chatId: cid,
      role: msg.role,
      content: msg.content.trim().slice(0, 12000) || '(empty)',
      modelUsed: (msg.modelUsed || 'gemini-4-hydrogen').slice(0, 48),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeChatSessions(
  userId: string,
  onData: (sessions: CloudChatSession[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const uid = sanitizeSafeId(userId, 'user');
  const path = `users/${uid}/chats`;
  const q = query(collection(db, 'users', uid, 'chats'), orderBy('updatedAt', 'desc'), limit(15));

  return onSnapshot(
    q,
    (snapshot) => {
      const sessions: CloudChatSession[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          ownerId: String(data.ownerId || uid),
          title: String(data.title || 'Quant Session'),
          rolePreset: (data.rolePreset as ChatRolePreset) || 'architect',
          model:
            data.model === 'gemini-3.1-flash-lite'
              ? 'gemini-3.1-flash-lite'
              : 'gemini-4-hydrogen',
          activeSymbol: String(data.activeSymbol || 'R_25'),
          updatedAt: toMillis(data.updatedAt),
        };
      });
      onData(sessions);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    },
  );
}

export function subscribeChatMessages(
  userId: string,
  chatId: string,
  onData: (messages: GeminiChatMessage[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const uid = sanitizeSafeId(userId, 'user');
  const cid = sanitizeSafeId(chatId, 'chat');
  const path = `users/${uid}/chats/${cid}/messages`;
  const q = query(
    collection(db, 'users', uid, 'chats', cid, 'messages'),
    orderBy('createdAt', 'asc'),
    limit(80),
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const messages: GeminiChatMessage[] = snapshot.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          role: data.role === 'assistant' ? 'assistant' : 'user',
          content: String(data.content || ''),
          modelUsed: String(data.modelUsed || 'gemini-4-hydrogen'),
          createdAt: toMillis(data.createdAt),
        };
      });
      onData(messages);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    },
  );
}

export async function saveScannerSessionLog(
  userId: string,
  entry: Omit<ScannerSessionLogRecord, 'id' | 'ownerId' | 'createdAt'>,
): Promise<string> {
  const uid = sanitizeSafeId(userId, 'user');
  const logId = sanitizeSafeId(`scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'scan');
  const path = `users/${uid}/scannerLogs/${logId}`;

  try {
    await setDoc(doc(db, 'users', uid, 'scannerLogs', logId), {
      ownerId: uid,
      symbol: (entry.symbol || 'R_25').slice(0, 32),
      contractType: (entry.contractType || 'DIGITDIFF').slice(0, 24),
      barrier: Number(entry.barrier ?? 0),
      sampleSize: Math.min(5000, Math.max(1, Number(entry.sampleSize) || 1000)),
      winRatePct: Math.min(100, Math.max(0, Number(entry.winRatePct) || 0)),
      evPct: Math.min(1000, Math.max(-100, Number(entry.evPct) || 0)),
      confidence: Math.min(100, Math.max(0, Number(entry.confidence) || 0)),
      netPnl: Number(entry.netPnl ?? 0),
      wins: Math.max(0, Math.round(Number(entry.wins) || 0)),
      losses: Math.max(0, Math.round(Number(entry.losses) || 0)),
      rationale: (entry.rationale || '1000-tick sniper snapshot').trim().slice(0, 500),
      createdAt: serverTimestamp(),
    });
    return logId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}
