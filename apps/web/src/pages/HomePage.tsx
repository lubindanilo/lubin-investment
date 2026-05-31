import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScreenerStats } from '@lubin/shared';
import { api } from '../lib/api.js';
import { useAuth } from '../contexts/AuthContext.js';
import './HomePage.css';

/**
 * Page d'accueil commerciale (route `/`). Décrit l'app et ses bénéfices, avec des CTA
 * vers l'outil d'analyse et le screener. Public — c'est la vitrine du produit.
 */
export function HomePage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<ScreenerStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.screener.stats().then(s => { if (!cancelled) setStats(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="home">
      {/* ── Hero ── */}
      <section className="home-hero">
        <div className="home-badge">Analyse fondamentale, sans le bruit</div>
        <h1 className="home-title">
          Repérez les entreprises de <span className="home-accent">qualité</span>,<br />
          notées sur des chiffres — pas sur des opinions.
        </h1>
        <p className="home-lede">
          Tapez un ticker, obtenez une <strong>note quantitative /10</strong> en un instant : rentabilité,
          croissance du cash, retour sur capital, solidité du bilan, valorisation. Une méthode inspirée de
          Buffett et Bettin/Mauboussin, appliquée automatiquement.
        </p>
        <div className="home-cta-row">
          <Link to="/analyser" className="btn-primary home-cta">Analyser une action</Link>
          <Link to="/screener" className="btn-secondary home-cta">Explorer le screener</Link>
        </div>
        {stats && stats.scored > 0 && (
          <div className="home-livestat">
            <span className="home-livedot" />
            {stats.scored.toLocaleString('fr-FR')} entreprises déjà notées automatiquement
            {stats.pending > 0 && ` · ${stats.pending.toLocaleString('fr-FR')} en cours`}
          </div>
        )}
      </section>

      {/* ── Bénéfices ── */}
      <section className="home-section">
        <h2 className="home-h2">Pourquoi cet outil</h2>
        <div className="home-cards">
          <div className="home-card">
            <div className="home-card-title">Des chiffres, pas du bla-bla</div>
            <p>Une note /10 calculée sur 10 critères de qualité objectifs (marges, cash-flows, ROCE, dette…). Fini les avis subjectifs : la donnée tranche.</p>
          </div>
          <div className="home-card">
            <div className="home-card-title">Une veille de tout le marché</div>
            <p>L'app note en continu et automatiquement l'univers des actions. Vous découvrez directement les mieux notées au lieu de chercher ticker par ticker.</p>
          </div>
          <div className="home-card">
            <div className="home-card-title">La méthode des grands investisseurs</div>
            <p>Cash ROCE, free cash flow par action ajusté, croissance organique, moat… les critères qui comptent vraiment sur le long terme — chacun expliqué.</p>
          </div>
          <div className="home-card">
            <div className="home-card-title">Qualité et prix séparés</div>
            <p>La qualité du business et le bon prix d'entrée sont jugés séparément. Une excellente entreprise reste excellente — il suffit d'attendre le bon moment.</p>
          </div>
        </div>
      </section>

      {/* ── Comment ça marche ── */}
      <section className="home-section">
        <h2 className="home-h2">Comment ça marche</h2>
        <div className="home-steps">
          <div className="home-step">
            <div className="home-step-num">1</div>
            <div>
              <div className="home-step-title">Tapez un ticker</div>
              <p>AAPL, MSFT, ASML… L'app récupère les fondamentaux et calcule la note en quelques secondes.</p>
            </div>
          </div>
          <div className="home-step">
            <div className="home-step-num">2</div>
            <div>
              <div className="home-step-title">Lisez la note /10</div>
              <p>Chaque critère est noté OUI / PARTIEL / NON, avec une explication du pourquoi et du comment. Cliquez pour voir l'historique.</p>
            </div>
          </div>
          <div className="home-step">
            <div className="home-step-num">3</div>
            <div>
              <div className="home-step-title">Suivez les meilleures</div>
              <p>Ajoutez vos favorites à la watchlist et laissez le screener faire remonter les 10/10 du marché entier.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="home-final">
        <h2 className="home-final-title">Prêt à analyser ?</h2>
        <p className="home-final-sub">Gratuit, instantané, sans installation.</p>
        <div className="home-cta-row">
          <Link to="/analyser" className="btn-primary home-cta">Analyser une action</Link>
          {!user && <Link to="/signup" className="btn-secondary home-cta">Créer un compte</Link>}
        </div>
      </section>
    </div>
  );
}
