import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { Icon, type IconName } from '../components/ui/primitives.js';
import { HeroPreview } from '../components/ui/HeroPreview.js';
import './HomePage.css';

const BENEFITS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'bars', title: 'Des chiffres, pas du bla-bla', text: '10 critères financiers objectifs calculés en quelques secondes. La donnée tranche, pas les opinions.' },
  { icon: 'pulse', title: 'Toute la cote, surveillée', text: 'Une veille automatique note en continu l\'univers boursier et fait remonter les meilleures entreprises.' },
  { icon: 'shield', title: 'La méthode des grands investisseurs', text: 'Rentabilité, croissance, qualité du bilan : les critères des compounders de long terme.' },
  { icon: 'scale', title: 'Qualité et prix, séparés', text: 'La qualité du business et le prix d\'entrée sont jugés indépendamment. Jamais l\'un pour l\'autre.' },
];

const STEPS: { n: string; title: string; text: string }[] = [
  { n: '01', title: 'Tapez un ticker', text: 'Entrez le symbole d\'une action. La note de qualité s\'affiche en quelques secondes.' },
  { n: '02', title: 'Lisez la note et sa composition', text: 'Une note sur 10, sa répartition vert/orange/rouge, et le détail des 10 critères.' },
  { n: '03', title: 'Décidez du prix d\'entrée', text: 'Ajustez vos hypothèses pour obtenir le prix d\'achat conseillé, séparé de la qualité.' },
];

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="home">
      {/* ── Hero ── */}
      <section className="home-hero">
        <div className="home-hero-halo" aria-hidden="true" />
        <div className="home-hero-grid wrap">
          <div className="home-hero-left fade-up">
            <span className="chip home-chip" data-active="true">Analyse fondamentale automatisée</span>
            <h1 className="home-title">
              Trouvez les entreprises de qualité,<br />
              <span className="home-accent">sans le bruit.</span>
            </h1>
            <p className="home-lede">
              Tapez un ticker, obtenez une note de qualité sur 10 calculée sur des critères financiers
              objectifs. Une valorisation jugée séparément. Et une veille qui note tout le marché pour vous.
            </p>
            <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
              <Link to="/analyser" className="btn btn-brand btn-lg">Analyser une action <Icon name="arrowRight" size={17} /></Link>
              <Link to="/screener" className="btn btn-ghost btn-lg">Explorer le screener</Link>
            </div>
            <div className="home-stats">
              <div><span className="num home-stat-n">10</span><span className="home-stat-l">critères chiffrés</span></div>
              <div><span className="num home-stat-n">6&nbsp;200+</span><span className="home-stat-l">titres surveillés</span></div>
              <div><span className="num home-stat-n">&lt; 3 s</span><span className="home-stat-l">par analyse</span></div>
            </div>
          </div>
          <div className="home-hero-right fade-up">
            <HeroPreview />
          </div>
        </div>
      </section>

      {/* ── Bénéfices ── */}
      <section className="wrap home-section">
        <div className="home-cards">
          {BENEFITS.map(b => (
            <div key={b.title} className="home-card">
              <div className="home-card-icon"><Icon name={b.icon} size={21} /></div>
              <div className="home-card-title">{b.title}</div>
              <p>{b.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Comment ça marche ── */}
      <section className="home-how">
        <div className="wrap">
          <div className="home-how-head">
            <span className="kicker">Comment ça marche</span>
            <h2 className="home-h2">Une action jugée en un coup d'œil</h2>
          </div>
          <div className="home-steps">
            {STEPS.map(s => (
              <div key={s.n} className="home-step">
                <div className="num home-step-num">{s.n}</div>
                <div className="home-step-title">{s.title}</div>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="wrap" style={{ padding: '24px 28px 64px' }}>
        <div className="home-final">
          <div className="home-final-halo" aria-hidden="true" />
          <h2 className="home-final-title">Trouvez les 10/10 sans les chercher</h2>
          <p className="home-final-sub">La veille note l'univers en continu — vous récoltez les meilleures.</p>
          <div className="row gap-12 center" style={{ flexWrap: 'wrap' }}>
            <Link to="/analyser" className="btn btn-brand btn-lg">Analyser une action</Link>
            {!user && <Link to="/signup" className="btn home-cta-light btn-lg">Créer un compte</Link>}
          </div>
        </div>
      </section>
    </div>
  );
}
