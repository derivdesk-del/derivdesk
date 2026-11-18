import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  auth,
  signInWithGooglePopup,
  signOutGoogle,
  syncUserProfileToFirestore,
  testConnection,
} from '../lib/firebase.ts';

interface AuthContextValue {
  user: User | null;
  authReady: boolean;
  authBusy: boolean;
  authError: string | null;
  signInWithGoogle: () => Promise<User | null>;
  signOut: () => Promise<void>;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    void testConnection();
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        try {
          await syncUserProfileToFirestore(nextUser);
        } catch (err) {
          console.error('Profile sync failed:', err);
        }
      }
    });
    return () => unsub();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const signedIn = await signInWithGooglePopup();
      await syncUserProfileToFirestore(signedIn);
      return signedIn;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Sign-In failed';
      setAuthError(msg);
      return null;
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await signOutGoogle();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-Out failed');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      authReady,
      authBusy,
      authError,
      signInWithGoogle,
      signOut,
      clearAuthError,
    }),
    [authBusy, authError, authReady, clearAuthError, signInWithGoogle, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
