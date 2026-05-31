import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AnalyzeResponse, ValoParams, ValuationResult, ScreenerTopRow, Criterion } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import { useToast } from '../components/Toast.js';
import { useAuth } from '../contexts/AuthContext.js';
import { CriteriaGrid } from '../components/CriterionCard.js';
import { ValuationPanel } from '../components/ValuationPanel.js';
import { NewsPanel } from '../components/NewsPanel.js';
import { EarningsPanel } from '../components/EarningsPanel.js';
import { Icon, ScoreCircle, ScorePill, scoreColor, toDataStatus } from '../components/ui/primitives.js';
import { CompositionBar, PriceChart } from '../components/ui/charts.js';
import './AnalysePage.css';

const HORIZONS: Record<string, { years: number; interval: '1d' | '1wk' | '1mo' }> = {
  '1A': { years: 1, interval: '1wk' },
  '5A': { years: 5, interval: '1mo' },
  '10A': { years: 10, interval: '1mo' },
  'Tout': { years: 30, interval: '1mo' },
};

function scoreOf(items: { statut: 'pass' | 'fail' | 'warn' }[]) {
  const pass = items.filter(c => c.statut === 'pass').length;
  const warn = items.filter(c => c.statut === 'warn').length;
  return `${pass + Math.round(warn * 0.5)}/${items.length}`;
}
/** Note ramenée sur 10 (le path Yahoo peut avoir moins de critères évaluables). */
function score10(items: Criterion[]): number {
  if (items.length === 0) return 0;
  const pass = items.filter(c => c.statut === 'pass').length;
  const warn = items.filter(c => c.statut === 'warn').length;
  return Math.round(((pass + 0.5 * warn) / items.length) * 10);
}
function compositionCounts(items: Criterion[]) {
  return items.reduce((a, c) => { a[toDataStatus(c.statut)]++; return a; }, { good: 0, warn: 0, bad: 0 });
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
  const [generatingQual, setGeneratingQual] = useState(false);
  const [inWatchlist, setInWatchlist] = useState<Set<string>>(new Set());
  const [lastTicker, setLastTicker] = useState('');

  useEffect(() => { setInWatchlist(new Set()); }, [user]);

  const run = useCallback(async (t: string) => {
    if (!t.trim()) return;
    const cleaned = t.trim().toUpperCase();
    setLoading(true); setError(null); setAnalysis(null); setLastTicker(cleaned);
    window.scrollTo({ top: 0 });
    try {
      setAnalysis(await api.analyze(cleaned));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, (e as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (routeTicker) { setTicker(routeTicker.toUpperCase()); run(routeTicker.toUpperCase()); }
  }, [routeTicker, run]);

  async function addToWatchlist() {
    if (!analysis) return;
    if (!user) {
      navigate('/login', { state: { from: `/analyse/${analysis.ticker}` } });
      toast.push('warn', 'Connecte-toi pour gérer ta watchlist');
      return;
    }
    try {
      await api.watchlist.add(analysis.ticker);
      setInWatchlist(prev => new Set(prev).add(analysis.ticker));
      toast.push('success', `${analysis.ticker} ajouté à la watchlist`);
    } catch (e) { toast.push('error', (e as Error).message); }
  }

  async function generateQualitative() {
    if (!analysis) return;
    setGeneratingQual(true);
    try { setAnalysis(await api.generateQualitative(analysis.ticker)); toast.push('success', 'Analyse qualitative générée'); }
    catch (e) { toast.push('error', (e as Error).message); }
    finally { setGeneratingQual(false); }
  }

  async function refreshManagementOnly() {
    if (!analysis) return;
    setRefreshingQual(true);
    try { setAnalysis(await api.refreshManagement(analysis.ticker)); toast.push('success', 'Données management mises à jour'); }
    catch (e) { toast.push('error', (e as Error).message); }
    finally { setRefreshingQual(false); }
  }

  function onValuationChanged(valuation: ValuationResult, params: ValoParams) {
    if (!analysis) return;
    const criteres = [...analysis.criteres.slice(0, -1), valuation];
    setAnalysis({ ...analysis, criteres, valuation, valoParams: params });
  }

  const chiffres = analysis?.criteres.slice(0, 10) ?? [];
  const business = analysis?.qualitativeAvailable ? analysis.criteres.slice(10, 20) : [];
  const management = analysis?.qualitativeAvailable ? analysis.criteres.slice(20, 25) : [];
  const valuationCards = analysis?.criteres.slice(-2) ?? [];
  const watched = !!analysis && (analysis.inWatchlist === true || inWatchlist.has(analysis.ticker));

  return (
    <div className="anl">
      <div className="wrap anl-wrap">
        <div className="anl-search-block">
          <SearchBar value={ticker} onChange={setTicker} onSubmit={run} loading={loading} />
          {!loading && !analysis && !error && (
            <span className="tiny muted anl-hint">Astuce : tape un ticker comme <b>AAPL</b>, <b>MSFT</b> ou <b>ASML</b>.</span>
          )}
        </div>

        {error && <ErrorState error={error} ticker={lastTicker} onRetry={() => { setError(null); setAnalysis(null); }} />}
        {loading && !analysis && <LoadingState />}
        {!loading && !analysis && !error && <LandingDiscovery onPick={(t) => { setTicker(t); run(t); }} />}

        {analysis && (
          <AnalysisView
            analysis={analysis}
            chiffres={chiffres}
            business={business}
            management={management}
            valuationCards={valuationCards}
            watched={watched}
            onWatch={addToWatchlist}
            onGenerateQual={generateQualitative}
            generatingQual={generatingQual}
            refreshingQual={refreshingQual}
            onRefreshMgmt={refreshManagementOnly}
            onValuationChanged={onValuationChanged}
          />
        )}
      </div>
    </div>
  );
}

// ─── Barre de recherche ──────────────────────────────────────────────────────
function SearchBar({ value, onChange, onSubmit, loading }: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; loading: boolean;
}) {
  return (
    <form className="anl-search" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
      <div className="anl-search-field">
        <Icon name="search" size={18} className="anl-search-icon" />
        <input className="anl-search-input num" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder="Entrez un ticker — ex. AAPL, MSFT, ASML…" />
      </div>
      <button type="submit" className="btn btn-brand" style={{ height: 48 }} disabled={loading || !value.trim()}>
        {loading ? 'Analyse…' : <>Analyser <Icon name="arrowRight" size={17} /></>}
      </button>
    </form>
  );
}

// ─── Section (titre + sous-titre + slot droit) ───────────────────────────────
function Section({ title, sub, right, children }: {
  title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="anl-section">
      <div className="anl-section-head">
        <div className="col gap-2">
          <h2 className="anl-section-title">{title}</h2>
          {sub && <span className="tiny muted">{sub}</span>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// ─── Vue remplie ─────────────────────────────────────────────────────────────
function AnalysisView({ analysis, chiffres, business, management, valuationCards, watched, onWatch, onGenerateQual, generatingQual, refreshingQual, onRefreshMgmt, onValuationChanged }: {
  analysis: AnalyzeResponse;
  chiffres: Criterion[]; business: Criterion[]; management: Criterion[]; valuationCards: Criterion[];
  watched: boolean; onWatch: () => void; onGenerateQual: () => void; generatingQual: boolean;
  refreshingQual: boolean; onRefreshMgmt: () => void;
  onValuationChanged: (v: ValuationResult, p: ValoParams) => void;
}) {
  const scoreRef = useRef<HTMLDivElement>(null);
  const [stickyVisible, setStickyVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => { if (scoreRef.current) setStickyVisible(scoreRef.current.getBoundingClientRect().bottom < 70); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const s10 = score10(chiffres);
  const counts = compositionCounts(chiffres);
  const tone = scoreColor(s10);
  const currency = analysis.currency || 'USD';
  const annualOnly = analysis.fundamentalsSource === 'yahoo';

  return (
    <>
      <StickyScoreBar analysis={analysis} score={s10} tone={tone} visible={stickyVisible} watched={watched} onWatch={onWatch} />
      <div className="col gap-28 fade-in anl-filled">
        {!analysis.fundamentalsAvailable && (
          <div className="anl-banner">
            <Icon name="shield" size={16} />
            <span>Données fondamentales indisponibles pour <b>{analysis.ticker}</b>. Ce titre n'est pas couvert — essaie une cotation ADR US si elle existe.</span>
          </div>
        )}

        {/* ScoreCard */}
        <div ref={scoreRef} className="card anl-scorecard">
          <ScoreCircle score={s10} />
          <div className="col gap-12 grow">
            <div className="anl-scorecard-head">
              <div className="col gap-4">
                <div className="row gap-10">
                  <h1 className="anl-company">{analysis.company}</h1>
                  <span className="num anl-ticker-badge">{analysis.ticker}</span>
                  {annualOnly && <span className="num anl-ticker-badge" title="Données via Yahoo">via Yahoo</span>}
                </div>
                {analysis.price != null && (
                  <div className="num anl-price">{currency} {analysis.price.toFixed(2)}</div>
                )}
              </div>
              <button className={'btn ' + (watched ? 'btn-soft' : 'btn-brand')} onClick={onWatch}>
                {watched ? <><Icon name="check" size={16} /> Dans la watchlist</> : <><Icon name="plus" size={16} /> Ajouter à la watchlist</>}
              </button>
            </div>
            {analysis.verdict_direct?.trim() && <p className="anl-verdict">{analysis.verdict_direct}</p>}
            <div className="col gap-6 anl-composition">
              <div className="row between">
                <span className="tiny muted">Composition de la note</span>
                <span className="num tiny anl-comp-counts">
                  <span style={{ color: 'var(--good)' }}>{counts.good} oui</span> · <span style={{ color: 'var(--warn)' }}>{counts.warn} partiel</span> · <span style={{ color: 'var(--bad)' }}>{counts.bad} non</span>
                </span>
              </div>
              <CompositionBar counts={counts} />
            </div>
          </div>
        </div>

        {/* Cours */}
        <PriceSection ticker={analysis.ticker} currency={currency} />

        {/* 10 critères */}
        <Section title="Les chiffres" sub="10 critères financiers objectifs · la donnée tranche, pas les opinions">
          <CriteriaGrid items={chiffres} ticker={analysis.ticker} currency={currency} annualOnly={annualOnly} />
        </Section>

        {/* Résultats */}
        {(analysis.earnings?.next || analysis.earnings?.last) && (
          <Section title="Résultats" sub="Dernier rapport publié et prochaine échéance">
            <EarningsPanel ticker={analysis.ticker} earnings={analysis.earnings} currency={currency} />
          </Section>
        )}

        {/* Qualitatif (à la demande) */}
        <Section
          title="Analyse qualitative"
          sub="Business model et management · optionnelle, à la demande"
          right={analysis.qualitativeAvailable
            ? <button className="btn btn-ghost btn-sm" onClick={onRefreshMgmt} disabled={refreshingQual}>
                {refreshingQual ? <><span className="spinner" /> Maj…</> : <><Icon name="refresh" size={14} /> Management</>}
              </button>
            : undefined}
        >
          {analysis.qualitativeAvailable ? (
            <div className="col gap-20">
              <div className="col gap-10">
                <span className="kicker anl-qual-kicker">Business model · {scoreOf(business)}</span>
                <CriteriaGrid items={business} />
              </div>
              <div className="col gap-10">
                <span className="kicker anl-qual-kicker">Management · {scoreOf(management)}</span>
                <CriteriaGrid items={management} />
              </div>
            </div>
          ) : (
            <div className="card anl-qual-cta">
              <div className="anl-qual-cta-icon"><Icon name="layers" size={22} /></div>
              <p>L'analyse qualitative évalue le moat, la prévisibilité des revenus et la qualité du management — au-delà des seuls chiffres.</p>
              <button className="btn btn-soft" onClick={onGenerateQual} disabled={generatingQual}>
                {generatingQual ? <><span className="spinner" /> Génération…</> : 'Lancer l\'analyse qualitative'}
              </button>
            </div>
          )}
        </Section>

        {/* Valorisation */}
        <Section title="Valorisation" sub="Prix d'entrée — jugé séparément de la qualité du business">
          {valuationCards.length === 2 && (
            <CriteriaGrid items={valuationCards} ticker={analysis.ticker} currency={currency} annualOnly={annualOnly} />
          )}
          <ValuationPanel analysis={analysis} onValuationChanged={onValuationChanged} />
        </Section>

        {/* Actualités */}
        {analysis.news.length > 0 && (
          <Section title="Actualités récentes" sub="Le contexte, sans le bruit">
            <NewsPanel ticker={analysis.ticker} news={analysis.news} />
          </Section>
        )}
      </div>
    </>
  );
}

// ─── Mini-barre sticky ───────────────────────────────────────────────────────
function StickyScoreBar({ analysis, score, tone, visible, watched, onWatch }: {
  analysis: AnalyzeResponse; score: number; tone: { bg: string; ink: string }; visible: boolean; watched: boolean; onWatch: () => void;
}) {
  return (
    <div className="anl-sticky" data-visible={visible}>
      <div className="wrap anl-sticky-inner">
        <div className="row gap-12" style={{ minWidth: 0 }}>
          <span className="num anl-sticky-ticker">{analysis.ticker}</span>
          <span className="tiny muted only-desktop anl-sticky-name">{analysis.company}</span>
          {analysis.price != null && <span className="num tiny" style={{ fontWeight: 600 }}>{analysis.currency} {analysis.price.toFixed(2)}</span>}
        </div>
        <div className="row gap-12">
          <span className="num anl-sticky-score" style={{ color: tone.ink, background: tone.bg }}>{score}/10</span>
          <button className={'btn btn-sm ' + (watched ? 'btn-soft' : 'btn-brand')} onClick={onWatch}>
            {watched ? <><Icon name="check" size={14} /> Suivie</> : <><Icon name="plus" size={14} /> Watchlist</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Section cours (SVG via priceHistory) ────────────────────────────────────
function PriceSection({ ticker, currency }: { ticker: string; currency: string }) {
  const [horizon, setHorizon] = useState('5A');
  const [data, setData] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const { years, interval } = HORIZONS[horizon]!;
    api.priceHistory(ticker, years, interval)
      .then(res => { if (!cancelled) setData(res.points.map(p => p.value)); })
      .catch(() => { if (!cancelled) setData([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, horizon]);

  return (
    <Section title="Cours" sub="Évolution du prix sur l'horizon sélectionné"
      right={<div className="seg">{Object.keys(HORIZONS).map(h => (
        <button key={h} type="button" data-active={h === horizon} onClick={() => setHorizon(h)}>{h}</button>
      ))}</div>}>
      <div className="card anl-price-card">
        {loading ? <div className="skel-ui" style={{ height: 240 }} />
          : data && data.length >= 2 ? <PriceChart data={data} currency={currency === 'USD' ? '$' : ''} />
          : <div className="anl-price-empty">Graphique de cours indisponible pour ce symbole.</div>}
      </div>
    </Section>
  );
}

// ─── Skeleton chargement ─────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="fade-in col gap-20 anl-filled">
      <div className="card anl-scorecard">
        <div className="skel-ui" style={{ width: 116, height: 116, borderRadius: '50%' }} />
        <div className="col gap-10 grow">
          <div className="skel-ui" style={{ width: 220, height: 26 }} />
          <div className="skel-ui" style={{ width: 320, height: 16 }} />
          <div className="skel-ui" style={{ width: '70%', height: 14 }} />
          <div className="skel-ui" style={{ width: 170, height: 40, marginTop: 8, borderRadius: 9 }} />
        </div>
      </div>
      <div className="card skel-ui" style={{ height: 240 }} />
      <div className="criteria-grid">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="card skel-ui" style={{ height: 128 }} />)}
      </div>
    </div>
  );
}

// ─── Erreur ──────────────────────────────────────────────────────────────────
function ErrorState({ error, ticker, onRetry }: { error: ApiError; ticker: string; onRetry: () => void }) {
  let title: string, desc: string, icon: 'search' | 'shield' | 'refresh' = 'search';
  if (error.status === 404) { title = `Ticker « ${ticker} » introuvable`; desc = error.details ?? error.userMessage; icon = 'search'; }
  else if (error.status === 429) { title = 'Trop de requêtes'; desc = 'Limite temporaire atteinte. Réessaie dans une minute.'; icon = 'refresh'; }
  else if (error.status === 0) { title = 'Connexion impossible'; desc = 'Impossible de joindre le serveur. Réessaie dans un instant.'; icon = 'refresh'; }
  else if (error.status === 400) { title = 'Ticker invalide'; desc = 'Lettres majuscules, 8 caractères max.'; icon = 'search'; }
  else { title = 'Erreur'; desc = error.userMessage; icon = 'shield'; }
  return (
    <div className="card anl-error fade-up">
      <div className="anl-error-icon"><Icon name={icon} size={26} /></div>
      <h3>{title}</h3>
      <p className="muted">{desc}</p>
      <button className="btn btn-ghost" onClick={onRetry} style={{ marginTop: 6 }}>Nouvelle recherche</button>
    </div>
  );
}

// ─── Vitrine (état vide) — les mieux notées ──────────────────────────────────
function LandingDiscovery({ onPick }: { onPick: (ticker: string) => void }) {
  const [picks, setPicks] = useState<ScreenerTopRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.screener.top({ minRatio: 0.9, minMax: 8, limit: 6 })
      .then(p => { if (!cancelled) { setPicks(p); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  if (loaded && picks.length === 0) return null;
  return (
    <div className="fade-up anl-landing">
      <div className="row gap-8 anl-landing-head">
        <Icon name="star" size={16} style={{ color: 'var(--brand)' }} />
        <span className="kicker">Issu de la veille · les mieux notées</span>
      </div>
      <div className="anl-landing-grid">
        {!loaded
          ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="card skel-ui" style={{ height: 96 }} />)
          : picks.map(p => {
              const s = p.scoreChiffresMax ? Math.round((p.scoreChiffres ?? 0) / p.scoreChiffresMax * 10) : 0;
              return (
                <button key={p.ticker} className="card anl-landing-card" onClick={() => onPick(p.ticker)}>
                  <div className="row between">
                    <div className="col gap-2" style={{ minWidth: 0 }}>
                      <span className="num anl-landing-ticker">{p.ticker}</span>
                      <span className="tiny muted anl-landing-name">{p.name ?? p.ticker}</span>
                    </div>
                    <ScorePill score={s} />
                  </div>
                  {p.pfcfTTM != null && p.pfcfTTM > 0 && (
                    <div className="row between anl-landing-foot">
                      <span className="tiny muted">P/FCF</span>
                      <span className="num tiny" style={{ color: 'var(--ink-2)' }}>{p.pfcfTTM.toFixed(1)}×</span>
                    </div>
                  )}
                </button>
              );
            })}
      </div>
    </div>
  );
}
