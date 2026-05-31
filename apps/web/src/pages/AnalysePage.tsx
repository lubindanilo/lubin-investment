import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AnalyzeResponse, ValoParams, ValuationResult, ScreenerTopRow, ScreenerStats } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useAuth } from '../contexts/AuthContext.js';
import { ScoreCard } from '../components/ScoreCard.js';
import { CriteriaGrid } from '../components/CriterionCard.js';
import { SectionHeader } from '../components/SectionHeader.js';
import { ValuationPanel } from '../components/ValuationPanel.js';
import { NewsPanel } from '../components/NewsPanel.js';
import { TradingViewChart } from '../components/TradingViewChart.js';
import { PriceChart } from '../components/PriceChart.js';
import { EarningsPanel } from '../components/EarningsPanel.js';
import './AnalysePage.css';

function scoreOf(items: { statut: 'pass' | 'fail' | 'warn' }[]) {
  const pass = items.filter(c => c.statut === 'pass').length;
  const warn = items.filter(c => c.statut === 'warn').length;
  return `${pass + Math.round(warn * 0.5)}/${items.length}`;
}

export function AnalysePage() {
  const { ticker: routeTicker } = useParams<{ ticker?: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [ticker, setTicker] = useState(routeTicker?.toUpperCase() ?? '');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshingQual, setRefreshingQual] = useState(false);
  const [inWatchlist, setInWatchlist] = useState<Set<string>>(new Set());
  const [lastTicker, setLastTicker] = useState<string>('');

  // L'appartenance à la watchlist vient désormais de la réponse analyze elle-même
  // (analysis.inWatchlist, calculé côté serveur) → fini les faux "Ajouter" quand un
  // second fetch de la watchlist échouait. Le set local ne sert plus qu'au flip
  // optimiste juste après un clic "Ajouter". On le vide au changement d'utilisateur.
  useEffect(() => { setInWatchlist(new Set()); }, [user]);

  const run = useCallback(async (t: string) => {
    if (!t.trim()) return;
    const cleaned = t.trim().toUpperCase();
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setLastTicker(cleaned);
    try {
      const data = await api.analyze(cleaned);
      setAnalysis(data);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, (e as Error).message);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (routeTicker) {
      setTicker(routeTicker.toUpperCase());
      run(routeTicker.toUpperCase());
    }
  }, [routeTicker, run]);

  async function addToWatchlist() {
    if (!analysis) return;
    // Pas connecté → on envoie vers /login en mémorisant la page courante
    if (!user) {
      navigate('/login', { state: { from: `/analyse/${analysis.ticker}` } });
      toast.push('warn', 'Connecte-toi pour gérer ta watchlist');
      return;
    }
    try {
      await api.watchlist.add(analysis.ticker);
      setInWatchlist(prev => new Set(prev).add(analysis.ticker));
      toast.push('success', `${analysis.ticker} ajouté à la watchlist`);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  // État "génération en cours" pour le bouton "Générer l'analyse qualitative"
  const [generatingQual, setGeneratingQual] = useState(false);

  async function generateQualitative() {
    if (!analysis) return;
    setGeneratingQual(true);
    try {
      const data = await api.generateQualitative(analysis.ticker);
      setAnalysis(data);
      toast.push('success', 'Analyse qualitative générée');
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setGeneratingQual(false);
    }
  }

  async function refreshManagementOnly() {
    if (!analysis) return;
    setRefreshingQual(true);
    try {
      const data = await api.refreshManagement(analysis.ticker);
      setAnalysis(data);
      toast.push('success', 'Données management mises à jour');
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setRefreshingQual(false);
    }
  }

  function onValuationChanged(valuation: ValuationResult, params: ValoParams) {
    if (!analysis) return;
    // Le score ne dépend PAS de la valorisation (cf. backend) — on met juste à jour
    // la dernière entrée du tableau criteres (= buy price) et on garde le score actuel.
    const criteres = [...analysis.criteres.slice(0, -1), valuation];
    setAnalysis({ ...analysis, criteres, valuation, valoParams: params });
  }

  // Structure du tableau criteres (cf. backend buildResponse) :
  //   [0..9]    chiffres (10)
  //   [10..19]  business (10) — vide si qualitatif pas encore généré
  //   [20..24]  management (5) — vide si qualitatif pas encore généré
  //   [25, 26]  valorisation = [P/FCF actuel, Buy price]
  // La valorisation n'entre PAS dans le score (timing d'entrée ≠ qualité business).
  const chiffres = analysis?.criteres.slice(0, 10) ?? [];
  const business = analysis?.qualitativeAvailable ? analysis.criteres.slice(10, 20) : [];
  const management = analysis?.qualitativeAvailable ? analysis.criteres.slice(20, 25) : [];
  // Les 2 cartes valorisation (P/FCF + buy price). Toujours présentes.
  const valuationCards = analysis?.criteres.slice(-2) ?? [];

  return (
    <>
      <h1 className="section-title">Analyser une entreprise</h1>
      <p className="section-sub">Note quantitative /10 instantanée à partir d'un ticker — analyse qualitative et valorisation en option.</p>

      <div className="search-wrap">
        <input
          className="input"
          placeholder="Ex : MEDP, ADBE, AAPL, QLYS"
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && run(ticker)}
        />
        <button className="btn-primary" onClick={() => run(ticker)} disabled={loading || !ticker.trim()}>
          {loading ? <><span className="spinner" /> Analyse…</> : 'Analyser'}
        </button>
      </div>

      {error && (
        <ErrorState
          error={error}
          onRetry={lastTicker ? () => run(lastTicker) : undefined}
        />
      )}

      {loading && !analysis && <AnalyseLoadingState />}

      {!loading && !analysis && !error && (
        <LandingDiscovery onPick={(t) => { setTicker(t); run(t); }} />
      )}

      {analysis && (
        <>
          {!analysis.fundamentalsAvailable && (
            <div className="fund-missing-banner">
              <div className="fund-missing-title">Données fondamentales indisponibles pour {analysis.ticker}</div>
              <div className="fund-missing-msg">
                La couverture des données fondamentales est limitée pour ce titre (principalement les actions cotées aux US). Pour les sociétés européennes ou asiatiques, les chiffres et la valorisation ne sont pas disponibles.
              </div>
              <div className="fund-missing-hint">
                Seule l'analyse qualitative reste valide ci-dessous. Si la société a une cotation ADR US (ex : Nestlé <code>NSRGY</code>, ASML <code>ASML</code>, LVMH <code>LVMUY</code>), essaie ce ticker à la place.
              </div>
            </div>
          )}

          <ScoreCard
            analysis={analysis}
            onAddWatchlist={addToWatchlist}
            alreadyInWatchlist={analysis.inWatchlist === true || inWatchlist.has(analysis.ticker)}
          />

          <EarningsPanel ticker={analysis.ticker} earnings={analysis.earnings} currency={analysis.currency} />

          {analysis.fundamentalsSource === 'yahoo' ? (
            // Tickers EU résolus via Yahoo : TradingView ne reconnaît pas COPN sans préfixe
            // SIX:COPN. On affiche notre propre chart Recharts avec données Yahoo /v8/chart
            // (qui a 20-30 ans de prix pour les EU, contre 4 ans pour les fundamentals).
            <PriceChart ticker={analysis.ticker} currency={analysis.currency} />
          ) : analysis.fundamentalsAvailable ? (
            <TradingViewChart ticker={analysis.ticker} />
          ) : (
            <div className="chart-section chart-unavailable">
              <div className="chart-title"><span>Cours boursier — {analysis.ticker}</span></div>
              <div className="chart-unavailable-msg">
                Graphique non disponible pour le symbole <code>{analysis.ticker}</code>.
              </div>
            </div>
          )}

          <SectionHeader title="Chiffres (10)" sub="Calculés à partir des données fondamentales temps réel" score={scoreOf(chiffres)} />
          <CriteriaGrid items={chiffres} ticker={analysis.ticker} currency={analysis.currency} annualOnly={analysis.fundamentalsSource === 'yahoo'} />

          {/* Section qualitative — soit affichée (cache hit), soit CTA "Générer" (cache miss).
              On évite tout appel GPT automatique : l'utilisateur clique explicitement quand il veut. */}
          {analysis.qualitativeAvailable ? (
            <>
              <SectionHeader
                title="Qualitatif (15)"
                sub={`Business model${analysis.businessCachedAt ? ` · cache à vie depuis ${new Date(analysis.businessCachedAt).toLocaleDateString('fr-FR')}` : ''} + Management${analysis.managementCachedAt ? ` · maj du ${new Date(analysis.managementCachedAt).toLocaleDateString('fr-FR')}` : ''}`}
              />

              <SectionHeader title="Business model (10)" score={scoreOf(business)} />
              <CriteriaGrid items={business} />

              <SectionHeader
                title="Management (5)"
                sub="Allocation, ancienneté, transparence, skin in the game, rachats opportunistes"
                score={scoreOf(management)}
                right={
                  <button className="btn-secondary" onClick={refreshManagementOnly} disabled={refreshingQual}>
                    {refreshingQual ? <><span className="spinner" /> Mise à jour…</> : '↻ Rafraîchir le Management'}
                  </button>
                }
              />
              <CriteriaGrid items={management} />
            </>
          ) : (
            <div className="qual-cta-slim">
              <span className="qual-cta-slim-text">
                Analyse qualitative (business model + management) — optionnelle, générée à la demande.
              </span>
              <button className="btn-secondary qual-cta-slim-btn" onClick={generateQualitative} disabled={generatingQual}>
                {generatingQual ? <><span className="spinner" /> Génération…</> : 'Générer'}
              </button>
            </div>
          )}

          <SectionHeader
            title="Valorisation"
            sub="Timing d'entrée — n'entre PAS dans le score qualité. Une bonne action reste bonne, juste pas encore au bon prix."
          />
          {valuationCards.length === 2 && (
            <CriteriaGrid
              items={valuationCards}
              ticker={analysis.ticker}
              currency={analysis.currency}
              annualOnly={analysis.fundamentalsSource === 'yahoo'}
            />
          )}
          <ValuationPanel analysis={analysis} onValuationChanged={onValuationChanged} />

          <NewsPanel ticker={analysis.ticker} news={analysis.news} />
        </>
      )}
    </>
  );
}

/** Skeleton de la page analyse (fantôme de la score-card + grille de critères). */
function AnalyseLoadingState() {
  return (
    <div className="analyse-skeleton" aria-busy="true" aria-label="Analyse en cours">
      <div className="skel-scorecard">
        <div className="skeleton skel-circle" />
        <div className="skel-lines">
          <div className="skeleton skel-line skel-line-lg" />
          <div className="skeleton skel-line skel-line-md" />
        </div>
      </div>
      <div className="skeleton skel-section-title" />
      <div className="skel-grid">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton skel-card" />)}
      </div>
    </div>
  );
}

/**
 * Vitrine d'accueil : met en avant les entreprises les mieux notées par la veille,
 * pour découvrir directement les pépites plutôt que de chercher un ticker à l'aveugle.
 */
function LandingDiscovery({ onPick }: { onPick: (ticker: string) => void }) {
  const [picks, setPicks] = useState<ScreenerTopRow[]>([]);
  const [stats, setStats] = useState<ScreenerStats | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.screener.top({ minRatio: 0.9, minMax: 8, limit: 8 }).catch(() => [] as ScreenerTopRow[]),
      api.screener.stats().catch(() => null),
    ]).then(([p, s]) => {
      if (cancelled) return;
      setPicks(p);
      setStats(s);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="landing">
      <div className="landing-head">
        <h2 className="landing-title">Les mieux notées</h2>
        {stats && stats.scored > 0 && (
          <Link to="/screener" className="landing-seeall">
            {stats.scored.toLocaleString('fr-FR')} entreprises analysées · voir le screener →
          </Link>
        )}
      </div>

      {!loaded ? (
        <div className="landing-grid">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton landing-card-skel" />)}
        </div>
      ) : picks.length === 0 ? (
        <div className="landing-empty">
          La veille démarre — les meilleures notes apparaîtront ici au fil de l'eau. En attendant,
          essaie un ticker ci-dessus :{' '}
          <button className="landing-ex" onClick={() => onPick('AAPL')}>AAPL</button>,{' '}
          <button className="landing-ex" onClick={() => onPick('MSFT')}>MSFT</button>,{' '}
          <button className="landing-ex" onClick={() => onPick('ASML')}>ASML</button>.
        </div>
      ) : (
        <div className="landing-grid">
          {picks.map(p => {
            const ratio = p.scoreChiffresMax ? (p.scoreChiffres ?? 0) / p.scoreChiffresMax : 0;
            const cls = ratio >= 1 ? 'top' : ratio >= 0.8 ? 'high' : 'mid';
            return (
              <button key={p.ticker} className="landing-card" onClick={() => onPick(p.ticker)}>
                <div className="landing-card-top">
                  <span className="landing-card-ticker">{p.ticker}</span>
                  <span className={`landing-card-score ${cls}`}>{p.scoreChiffres}/{p.scoreChiffresMax}</span>
                </div>
                <div className="landing-card-name">{p.name ?? p.ticker}</div>
                {p.pfcfTTM != null && p.pfcfTTM > 0 && (
                  <div className="landing-card-pfcf">P/FCF {p.pfcfTTM.toFixed(1)}×</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  // 400/404 → message simple. 429 → message rate limit. 0/500+ → message + bouton retry.
  let title: string;
  let hint: string;
  if (error.status === 429) {
    title = 'Trop de requêtes — patiente une minute';
    hint = 'Tu as atteint le rate limit. Réessaie dans 60 secondes.';
  } else if (error.status === 0) {
    title = 'Connexion serveur impossible';
    hint = 'Vérifie que l\'API tourne (pnpm dev:api) puis réessaie.';
  } else if (error.status >= 500) {
    title = 'Erreur côté serveur';
    hint = 'Le serveur a renvoyé une erreur. Réessaie dans quelques secondes.';
  } else if (error.status === 400) {
    title = 'Ticker invalide';
    hint = 'Vérifie le ticker (lettres majuscules, max 8 caractères).';
  } else {
    title = 'Erreur';
    hint = error.userMessage;
  }
  return (
    <div className="error-box">
      <div className="error-box-title">{title}</div>
      <div className="error-box-hint">{hint}</div>
      {error.details && <div className="error-box-details">{error.details}</div>}
      {error.retriable && onRetry && (
        <button className="btn-secondary" onClick={onRetry} style={{ marginTop: 12 }}>
          ↻ Réessayer
        </button>
      )}
    </div>
  );
}
