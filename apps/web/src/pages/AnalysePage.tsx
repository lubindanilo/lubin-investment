import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AnalyzeResponse, ValoParams, ValuationResult } from '@lubin/shared';
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

  // Charge la watchlist uniquement si l'utilisateur est connecté. Sinon, ne rien afficher
  // (l'analyse en elle-même reste publique — c'est juste le bouton "Ajouter" qui change).
  useEffect(() => {
    if (!user) { setInWatchlist(new Set()); return; }
    api.watchlist.list().then(items => setInWatchlist(new Set(items.map(e => e.ticker)))).catch(() => {});
  }, [user]);

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
    const criteres = [...analysis.criteres.slice(0, -1), valuation];
    const pass = criteres.filter(c => c.statut === 'pass').length;
    const warn = criteres.filter(c => c.statut === 'warn').length;
    const score = pass + Math.round(warn * 0.5);
    setAnalysis({ ...analysis, criteres, valuation, valoParams: params, score, achat: score / analysis.scoreMax >= 0.7 });
  }

  // 11 chiffres + (10 business + 5 management si qualitativeAvailable) + 1 valuation
  // L'ordre est garanti par buildResponse côté backend (chiffres puis business puis management puis valo).
  const chiffres = analysis?.criteres.slice(0, 11) ?? [];
  const business = analysis?.qualitativeAvailable ? analysis.criteres.slice(11, 21) : [];
  const management = analysis?.qualitativeAvailable ? analysis.criteres.slice(21, 26) : [];

  return (
    <>
      <h1 className="section-title">Analyser une entreprise</h1>
      <p className="section-sub">Tape un ticker — analyse fondamentale complète sur 27 critères.</p>

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

      {analysis && (
        <>
          {!analysis.fundamentalsAvailable && (
            <div className="fund-missing-banner">
              <div className="fund-missing-title">⚠ Données fondamentales indisponibles pour {analysis.ticker}</div>
              <div className="fund-missing-msg">
                Notre source (Finnhub free tier) couvre principalement les actions cotées aux US. Pour les sociétés européennes (Suisse, France, Allemagne, etc.) ou asiatiques, les chiffres et la valorisation ne sont pas accessibles.
              </div>
              <div className="fund-missing-hint">
                Seule l'analyse qualitative (GPT recherche web) reste valide ci-dessous. Si la société a une cotation ADR US (ex : Nestlé <code>NSRGY</code>, ASML <code>ASML</code>, LVMH <code>LVMUY</code>), essaie ce ticker à la place.
              </div>
            </div>
          )}

          <ScoreCard
            analysis={analysis}
            onAddWatchlist={addToWatchlist}
            alreadyInWatchlist={inWatchlist.has(analysis.ticker)}
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
                📉 Graphique non disponible — le symbole <code>{analysis.ticker}</code> n'est pas indexé sur TradingView et Yahoo ne le résout pas.
              </div>
            </div>
          )}

          <SectionHeader title="Chiffres (11)" sub="Calculés à partir des données fondamentales temps réel" score={scoreOf(chiffres)} />
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
            <div className="qual-cta">
              <div className="qual-cta-icon">🤖</div>
              <div className="qual-cta-title">Analyse qualitative pas encore générée</div>
              <div className="qual-cta-text">
                Les 15 critères qualitatifs (business model + management) sont calculés via GPT-4 avec recherche web (~10 s, déclenche un appel API payant).
                <br/>Une fois généré, le <strong>business model est cache à vie</strong> (immutable) et le <strong>management peut être rafraîchi manuellement</strong>.
              </div>
              <button className="btn-primary qual-cta-btn" onClick={generateQualitative} disabled={generatingQual}>
                {generatingQual ? <><span className="spinner" /> Génération en cours…</> : '🤖 Générer l\'analyse qualitative'}
              </button>
            </div>
          )}

          <SectionHeader title="Valorisation" />
          <ValuationPanel analysis={analysis} onValuationChanged={onValuationChanged} />

          <NewsPanel ticker={analysis.ticker} news={analysis.news} />
        </>
      )}
    </>
  );
}

function AnalyseLoadingState() {
  // L'analyse quant est rapide (~1-2 s). Plus de GPT dans le flow, plus besoin du
  // tracker de progression multi-étapes. Spinner + compteur de secondes suffit.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="empty-state">
      <div className="empty-state-icon"><span className="spinner" /></div>
      <div className="empty-state-text">
        Analyse en cours…{' '}
        <span style={{ color: 'var(--text3)', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>
          ({(elapsedMs / 1000).toFixed(1)}s)
        </span>
      </div>
    </div>
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
