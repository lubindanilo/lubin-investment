/**
 * AuthContext — état global utilisateur.
 *
 * Pattern :
 *   - Au mount du provider, on hit GET /api/auth/me pour résoudre l'état d'auth initial
 *     (l'utilisateur peut déjà avoir un cookie valide d'une session précédente).
 *   - `loading` est true tant que le `me()` initial n'a pas répondu, pour éviter le flash
 *     "non connecté → connecté" qui ferait clignoter l'UI ou rediriger à tort.
 *   - login/signup/logout sont des actions qui mutent le state et renvoient le user.
 *
 * Important : on n'utilise PAS de localStorage pour stocker le user — la source de vérité
 * c'est le cookie HttpOnly (lu via /api/auth/me). Si on rafraîchit le state depuis le
 * localStorage on prendrait le risque qu'il soit désynchro avec le cookie réel.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicUser } from '@lubin/shared';
import { api } from '../lib/api.js';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
}

interface AuthActions {
  login: (email: string, password: string) => Promise<PublicUser>;
  signup: (email: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  /** Force un re-fetch du /me — utile après une opération qui peut invalider la session. */
  refresh: () => Promise<void>;
}

type AuthContextValue = AuthState & AuthActions;

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const me = await api.auth.me();
    setUser(me);
  }, []);

  useEffect(() => {
    api.auth.me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api.auth.login(email, password);
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const u = await api.auth.signup(email, password);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
  }, []);

  // useMemo pour stabiliser la value du provider (sinon tous les consumers re-render à chaque render)
  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, signup, logout, refresh }),
    [user, loading, login, signup, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans un <AuthProvider>');
  return ctx;
}
