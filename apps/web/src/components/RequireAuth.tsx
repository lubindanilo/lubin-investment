/**
 * Route guard : redirige vers /login si l'utilisateur n'est pas authentifié.
 * Pendant le bootstrap (api.auth.me() en vol), affiche un placeholder neutre
 * pour éviter le flash "page → login → page" sur les sessions valides.
 *
 * `state.from` permet à la page de login de rediriger vers la cible originale
 * une fois le login réussi.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><span className="spinner" /></div>
        <div className="empty-state-text">Chargement…</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }

  return <>{children}</>;
}
