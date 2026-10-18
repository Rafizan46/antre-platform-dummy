import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { createApiClient } from '../api/client';
import { createEndpoints, type Endpoints } from '../api/endpoints';
import { clearSession, loadSession, saveSession, sessionFromLogin, type Session } from './session';

export interface AuthValue {
  session: Session | null;
  api: Endpoints;
  /** Set when a session ended on its own (expiry or 401), shown on the login page. */
  notice: string | null;
  login(email: string, password: string): Promise<Session>;
  logout(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

const MAX_TIMER_MS = 2 ** 31 - 1;
export const SESSION_EXPIRED_NOTICE = 'Sesi Anda berakhir. Silakan masuk kembali.';

export interface AuthProviderProps {
  children: ReactNode;
  baseUrl?: string;
  storage?: Storage;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function AuthProvider({
  children,
  baseUrl = '',
  storage = window.sessionStorage,
  fetchImpl,
  now = Date.now,
}: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(() => loadSession(storage, now()));
  const [notice, setNotice] = useState<string | null>(null);
  // The API client reads the token from a ref so it never has to be recreated.
  const tokenRef = useRef<string | null>(session?.token ?? null);

  const end = useCallback(
    (message: string | null) => {
      tokenRef.current = null;
      clearSession(storage);
      setSession(null);
      setNotice(message);
    },
    [storage],
  );

  const api = useMemo(
    () =>
      createEndpoints(
        createApiClient({
          baseUrl,
          fetchImpl,
          getToken: () => tokenRef.current,
          onUnauthorized: () => end(SESSION_EXPIRED_NOTICE),
        }),
      ),
    [baseUrl, fetchImpl, end],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.login(email, password);
      const next = sessionFromLogin(result, now());
      tokenRef.current = next.token;
      saveSession(storage, next);
      setNotice(null);
      setSession(next);
      return next;
    },
    [api, storage, now],
  );

  const logout = useCallback(() => end(null), [end]);

  // Expire the session when the token's lifetime runs out.
  useEffect(() => {
    if (session === null) return undefined;
    const delay = Math.min(Math.max(session.expiresAt - now(), 0), MAX_TIMER_MS);
    const timer = setTimeout(() => end(SESSION_EXPIRED_NOTICE), delay);
    return () => clearTimeout(timer);
  }, [session, now, end]);

  const value = useMemo(
    () => ({ session, api, notice, login, logout }),
    [session, api, notice, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
