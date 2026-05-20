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

  async function refreshQualitative() {
    if (!analysis) return;
    setRefreshingQual(true);
    try {
      await api.refreshQual(analysis.ticker);
      const data = await api.analyze(analysis.ticker);
      setAnalysis(data);
      toast.push('success', 'Analyse qualitative mise à jour');
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

  // 11 chiffres + 10 business + 5 management + 1 valuation = 27
  const chiffres = analysis?.criteres.slice(0, 11) ?? [];
  const business = analysis?.criteres.slice(11, 21) ?? [];
  const management = analysis?.criteres.slice(21, 26) ?? [];

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
          {analysis.qualError && (
            <div className="qual-error-banner">
              <div className="qual-error-title">⚠ Analyse qualitative indisponible</div>
              <div className="qual-error-msg">{analysis.qualError}</div>
              <div className="qual-error-hint">Les chiffres + valorisation restent valides. Vérifie ton quota OpenAI sur platform.openai.com/usage.</div>
            </div>
          )}
          <ScoreCard
            analysis={analysis}
            onAddWatchlist={addToWatchlist}
            alreadyInWatchlist={inWatchlist.has(analysis.ticker)}
          />

          <EarningsPanel ticker={analysis.ticker} earnings={analysis.earnings} />

          <TradingViewChart ticker={analysis.ticker} />

          <SectionHeader title="Chiffres (11)" sub="Calculés à partir des données fondamentales temps réel" score={scoreOf(chiffres)} />
          <CriteriaGrid items={chiffres} ticker={analysis.ticker} />

          <SectionHeader
            title="Qualitatif (15)"
            sub={`Business model + management${analysis.qualUpdatedAt ? ` · analyse du ${new Date(analysis.qualUpdatedAt).toLocaleDateString('fr-FR')}` : ''}`}
            right={
              <button className="btn-secondary" onClick={refreshQualitative} disabled={refreshingQual}>
                {refreshingQual ? <><span className="spinner" /> Mise à jour…</> : '↻ Rafraîchir l\'analyse qualitative'}
              </button>
            }
          />

          <SectionHeader title="Business model (10)" score={scoreOf(business)} />
          <CriteriaGrid items={business} />

          <SectionHeader title="Management (5)" sub="Allocation, ancienneté, transparence, skin in the game, rachats opportunistes" score={scoreOf(management)} />
          <CriteriaGrid items={management} />

          <SectionHeader title="Valorisation" />
          <ValuationPanel analysis={analysis} onValuationChanged={onValuationChanged} />

          <NewsPanel ticker={analysis.ticker} news={analysis.news} />
        </>
      )}
    </>
  );
}

function AnalyseLoadingState() {
  // Progression temporelle calée sur les durées réelles observées (cache miss complet) :
  //   - Étape 1 (data layer Finnhub + Yahoo)        : ~1.5 s
  //   - Étape 2 (GPT search-preview)                : ~9 s
  //   - Étape 3 (calcul valorisation)               : ~0.1 s
  // L'étape "active" porte le spinner. Une étape passée affiche ✓. Aucune boucle.
  const STEPS: { label: string; until: number }[] = [
    { label: 'Récupération des fondamentaux (Finnhub + Yahoo)', until: 1500 },
    { label: 'Recherche web qualitative (GPT-4o search)',       until: 11000 },
    { label: 'Calcul de la valorisation',                       until: Infinity },
  ];

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => clearInterval(id);
  }, []);

  const activeIdx = STEPS.findIndex(s => elapsedMs < s.until);
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  return (
    <div className="empty-state">
      <div className="empty-state-icon"><span className="spinner" /></div>
      <div className="empty-state-text">Analyse en cours… <span style={{ color: 'var(--text3)', fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>({elapsedSec}s)</span></div>
      <div className="empty-state-sub" style={{ marginTop: 12, display: 'inline-block', textAlign: 'left' }}>
        {STEPS.map((s, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <div key={i} style={{
              opacity: done || active ? 1 : 0.4,
              padding: '3px 0',
              fontFamily: active ? 'inherit' : 'inherit',
              transition: 'opacity 0.2s',
            }}>
              {done ? '✓ ' : active ? <span className="spinner" style={{ width: 10, height: 10, marginRight: 6, verticalAlign: 'middle' }} /> : '○ '}
              {s.label}
            </div>
          );
        })}
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text3)' }}>
          ~10 s si nouvelle analyse, ~2 s si déjà en cache (jusqu'à 30 jours).
        </div>
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
