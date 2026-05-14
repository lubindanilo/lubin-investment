import { NavLink, Route, Routes } from 'react-router-dom';
import { AnalysePage } from './pages/AnalysePage.js';
import { WatchlistPage } from './pages/WatchlistPage.js';

export function App() {
  return (
    <>
      <header className="app-header">
        <div className="logo">
          <div className="logo-mark">LI</div>
          <div>
            <div className="logo-text">Lubin Investment</div>
            <div className="logo-sub">Analyse fondamentale</div>
          </div>
        </div>
      </header>

      <nav className="app-nav">
        <NavLink to="/" end className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
          Analyser
        </NavLink>
        <NavLink to="/watchlist" className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
          Watchlist
        </NavLink>
      </nav>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<AnalysePage />} />
          <Route path="/analyse/:ticker" element={<AnalysePage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
        </Routes>
      </main>
    </>
  );
}
