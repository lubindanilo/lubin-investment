/**
 * Page de login + inscription combinée.
 *
 * UX :
 *   - Un seul formulaire, toggle "Connexion / Inscription" en haut
 *   - Email + password (+ confirm password en mode signup pour éviter les typos)
 *   - Validation client minimale : email format + password ≥ 8 chars
 *   - Erreurs serveur (409 email existant, 401 mauvais creds) affichées en rouge sous le form
 *   - Au succès : redirige vers `from` (route protégée d'origine) ou la racine
 *   - Loading state pendant l'appel API (bouton disabled + spinner)
 *
 * Pas de "remember me" : on a un cookie de 30 jours, suffisant.
 * Pas de "mot de passe oublié" : pas de SMTP configuré pour le moment (feature à venir).
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { ApiError } from '../lib/api.js';
import './AuthPage.css';

type Mode = 'login' | 'signup';

export function AuthPage({ initialMode = 'login' }: { initialMode?: Mode }) {
  const { user, loading, login, signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Si déjà connecté, on évite que le user revienne sur /login → redirection
  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Validation client
    if (!email.trim() || !password) {
      setError('Email et mot de passe requis');
      return;
    }
    if (password.length < 8) {
      setError('Mot de passe : 8 caractères minimum');
      return;
    }
    if (mode === 'signup' && password !== confirm) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'signup') await signup(email.trim(), password);
      else await login(email.trim(), password);

      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.userMessage);
      else setError((err as Error).message ?? 'Erreur inattendue');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1 className="auth-title">{mode === 'login' ? 'Connexion' : 'Créer un compte'}</h1>
        <p className="auth-sub">
          {mode === 'login'
            ? 'Connecte-toi pour accéder à ta watchlist.'
            : 'Tes watchlists sont personnelles, ton analyse partagée pour économiser les API.'}
        </p>

        <form onSubmit={onSubmit} className="auth-form" autoComplete="on">
          <label className="auth-label">
            Email
            <input
              type="email"
              className="input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </label>

          <label className="auth-label">
            Mot de passe
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
            {mode === 'signup' && (
              <span className="auth-hint">8 caractères minimum.</span>
            )}
          </label>

          {mode === 'signup' && (
            <label className="auth-label">
              Confirmer le mot de passe
              <input
                type="password"
                className="input"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? <><span className="spinner" /> …</> : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
          </button>
        </form>

        <div className="auth-switch">
          {mode === 'login' ? (
            <>
              Pas encore de compte ?{' '}
              <button type="button" className="auth-link" onClick={() => { setMode('signup'); setError(null); }}>
                Créer un compte
              </button>
            </>
          ) : (
            <>
              Déjà inscrit ?{' '}
              <button type="button" className="auth-link" onClick={() => { setMode('login'); setError(null); }}>
                Se connecter
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
