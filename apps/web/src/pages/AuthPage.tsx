/**
 * Login / inscription — direction "Moderne fintech" : 2 colonnes (formulaire + panneau
 * sombre avec HeroPreview). Logique d'auth réelle conservée (useAuth, redirection,
 * validation email + mot de passe ≥ 8, confirmation en inscription).
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { ApiError } from '../lib/api.js';
import { Icon } from '../components/ui/primitives.js';
import { HeroPreview } from '../components/ui/HeroPreview.js';
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
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) { setError('Email et mot de passe requis'); return; }
    if (password.length < 8) { setError('Mot de passe : 8 caractères minimum'); return; }
    if (mode === 'signup' && password !== confirm) { setError('Les mots de passe ne correspondent pas'); return; }
    setSubmitting(true);
    try {
      if (mode === 'signup') await signup(email.trim(), password);
      else await login(email.trim(), password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : ((err as Error).message ?? 'Erreur inattendue'));
    } finally {
      setSubmitting(false);
    }
  }

  const isSignup = mode === 'signup';

  return (
    <div className="auth-grid card">
      {/* Formulaire */}
      <div className="auth-form-side">
        <div style={{ width: '100%', maxWidth: 380 }}>
          <h1 className="auth-h1">{isSignup ? 'Créer un compte' : 'Bon retour'}</h1>
          <p className="muted auth-sub">{isSignup ? 'Quelques secondes pour commencer à noter le marché.' : 'Connectez-vous pour reprendre vos analyses.'}</p>

          <form onSubmit={onSubmit} className="col gap-16" autoComplete="on">
            <div className="col gap-6">
              <label className="label">E-mail</label>
              <div className="auth-field">
                <Icon name="mail" size={16} className="auth-field-icon" />
                <input className="input auth-input" type="email" value={email} autoComplete="email" autoFocus
                  onChange={e => setEmail(e.target.value)} placeholder="vous@exemple.com" required />
              </div>
            </div>
            <div className="col gap-6">
              <label className="label">Mot de passe</label>
              <div className="auth-field">
                <Icon name="lock" size={16} className="auth-field-icon" />
                <input className="input auth-input" type={showPw ? 'text' : 'password'} value={password}
                  autoComplete={isSignup ? 'new-password' : 'current-password'} minLength={8}
                  onChange={e => setPassword(e.target.value)} placeholder="••••••••" required style={{ paddingRight: 42 }} />
                <button type="button" className="auth-eye" onClick={() => setShowPw(v => !v)} aria-label="Afficher le mot de passe"><Icon name="eye" size={16} /></button>
              </div>
              {isSignup && <span className="tiny muted">8 caractères minimum.</span>}
            </div>
            {isSignup && (
              <div className="col gap-6">
                <label className="label">Confirmer le mot de passe</label>
                <div className="auth-field">
                  <Icon name="lock" size={16} className="auth-field-icon" />
                  <input className="input auth-input" type={showPw ? 'text' : 'password'} value={confirm}
                    autoComplete="new-password" minLength={8}
                    onChange={e => setConfirm(e.target.value)} placeholder="••••••••" required />
                </div>
              </div>
            )}
            {error && <div className="s-badge s-badge-bad auth-err">{error}</div>}
            <button type="submit" className="btn btn-brand btn-lg btn-block" disabled={submitting} style={{ marginTop: 4 }}>
              {submitting ? <><span className="spinner" /> …</> : isSignup ? 'Créer mon compte' : 'Se connecter'}
            </button>
          </form>

          <p className="tiny muted auth-switch">
            {isSignup ? 'Déjà un compte ? ' : 'Pas encore de compte ? '}
            <Link to={isSignup ? '/login' : '/signup'} className="auth-link" onClick={() => { setMode(isSignup ? 'login' : 'signup'); setError(null); }}>
              {isSignup ? 'Se connecter' : 'Créer un compte'}
            </Link>
          </p>
        </div>
      </div>

      {/* Panneau visuel */}
      <div className="auth-aside">
        <div className="auth-aside-halo" aria-hidden="true" />
        <div className="auth-aside-inner">
          <span className="kicker auth-aside-kicker">Lubin Investment</span>
          <h2 className="auth-aside-h2">La donnée tranche,<br />pas les opinions.</h2>
          <p className="auth-aside-p">Une note de qualité sur 10, une valorisation séparée, et une veille qui surveille tout le marché pour vous.</p>
          <div style={{ marginTop: 32, maxWidth: 320 }}><HeroPreview /></div>
        </div>
      </div>
    </div>
  );
}
