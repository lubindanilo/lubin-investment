import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { HomePage } from './pages/HomePage.js';
import { AnalysePage } from './pages/AnalysePage.js';
import { WatchlistPage } from './pages/WatchlistPage.js';
import { ScreenerPage } from './pages/ScreenerPage.js';
import { AuthPage } from './pages/AuthPage.js';
import { RequireAuth } from './components/RequireAuth.js';
import { useAuth } from './contexts/AuthContext.js';
import { useToast } from './components/Toast.js';

export function App() {
  const { pathname } = useLocation();
  // Pas d'onglets d'app sur la landing commerciale (et les pages d'auth) : page vitrine.
  const showNav = pathname !== '/' && pathname !== '/login' && pathname !== '/signup';

  return (
    <>
      <header className="app-header">
        <Link to="/" className="logo">
          <div className="logo-mark">LI</div>
          <div>
            <div className="logo-text">Lubin Investment</div>
            <div className="logo-sub">Analyse fondamentale</div>
          </div>
        </Link>
        <UserMenu />
      </header>

      {showNav && (
        <nav className="app-nav">
          <NavLink to="/analyser" className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
            Analyser
          </NavLink>
          <NavLink to="/watchlist" className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
            Watchlist
          </NavLink>
          <NavLink to="/screener" className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
            Screener
          </NavLink>
        </nav>
      )}

      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/analyser" element={<AnalysePage />} />
          <Route path="/analyse/:ticker" element={<AnalysePage />} />
          <Route path="/watchlist" element={<RequireAuth><WatchlistPage /></RequireAuth>} />
          <Route path="/screener" element={<ScreenerPage />} />
          <Route path="/login" element={<AuthPage initialMode="login" />} />
          <Route path="/signup" element={<AuthPage initialMode="signup" />} />
        </Routes>
      </main>
    </>
  );
}

/**
 * Bloc utilisateur en haut à droite :
 *   - Auth → email + bouton "Se déconnecter"
 *   - Non auth → liens Connexion / Inscription
 *   - Pendant le bootstrap → vide (évite le flash "non connecté" sur sessions valides)
 */
function UserMenu() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  if (loading) return <div className="user-menu user-menu-loading" aria-hidden />;

  async function onLogout() {
    try {
      await logout();
      toast.push('success', 'Déconnecté');
      navigate('/login');
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  if (!user) {
    return (
      <div className="user-menu">
        <NavLink to="/login" className="user-menu-link">Connexion</NavLink>
        <NavLink to="/signup" className="btn-secondary user-menu-signup">Créer un compte</NavLink>
      </div>
    );
  }

  return (
    <div className="user-menu">
      <span className="user-menu-email" title={user.email}>{user.email}</span>
      <button type="button" className="user-menu-logout" onClick={onLogout}>Se déconnecter</button>
    </div>
  );
}
