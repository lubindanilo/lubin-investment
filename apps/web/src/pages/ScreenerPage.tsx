import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ScreenerTopRow, ScreenerStats } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import { Icon, ScorePill } from '../components/ui/primitives.js';
import './ScreenerPage.css';

const SCORE_OPTS = [4, 6, 8, 9, 10];
const PFCF_MAX = 50; // valeur haute = "pas de filtre P/FCF"

type SortCol = 'score' | 'pfcf';
interface SortState { col: SortCol; dir: 'asc' | 'desc' }

function ratioOf(r: ScreenerTopRow) { return r.scoreChiffresMax ? (r.scoreChiffres ?? 0) / r.scoreChiffresMax : 0; }
function formatEarnings(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function ScreenerPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ScreenerTopRow[]>([]);
  const [stats, setStats] = useState<ScreenerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minScore, setMinScore] = useState(6);
  const [maxPfcf, setMaxPfcf] = useState(PFCF_MAX);
  const [sort, setSort] = useState<SortState>({ col: 'score', dir: 'desc' });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [top, st] = await Promise.all([
        api.screener.top({ minRatio: minScore / 10, maxPfcf: maxPfcf >= PFCF_MAX ? undefined : maxPfcf, minMax: 8, limit: 300 }),
        api.screener.stats(),
      ]);
      setRows(top); setStats(st);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : (e as Error).message);
    } finally { setLoading(false); }
  }, [minScore, maxPfcf]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = sort.col === 'score' ? ratioOf(a) : (a.pfcfTTM ?? Infinity);
      const bv = sort.col === 'score' ? ratioOf(b) : (b.pfcfTTM ?? Infinity);
      return (av - bv) * dir;
    });
  }, [rows, sort]);

  const progress = stats && stats.total > 0 ? Math.round(((stats.scored + stats.nodata + stats.error) / stats.total) * 100) : 0;

  const SortTh = ({ label, col }: { label: string; col: SortCol }) => {
    const active = sort.col === col;
    return (
      <th className="sortable num-cell" onClick={() => setSort({ col, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
          {label}<span style={{ opacity: active ? 1 : 0.25 }}><Icon name={active && sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={11} stroke={2.4} /></span>
        </span>
      </th>
    );
  };

  return (
    <div className="scr">
      <div className="wrap-wide scr-wrap">
        <div className="scr-head">
          <div className="col gap-4">
            <h1 className="scr-title">Screener</h1>
            <p className="muted" style={{ fontSize: 14 }}>Les meilleures notes de l'univers, triées par la veille. Les 10/10 en tête.</p>
          </div>
          {stats && (
            <div className="col gap-6 scr-progress">
              <div className="row between wide">
                <span className="tiny muted" style={{ fontWeight: 600 }}>Veille de l'univers</span>
                <span className="num tiny" style={{ fontWeight: 700, color: progress >= 100 ? 'var(--good)' : 'var(--brand-ink)' }}>{progress >= 100 ? 'À jour' : progress + ' %'}</span>
              </div>
              <div className="scr-progress-track"><div className="scr-progress-fill" style={{ width: `${progress}%`, background: progress >= 100 ? 'var(--good)' : 'var(--brand)' }} /></div>
              <span className="tiny muted num">{stats.scored.toLocaleString('fr-FR')} / {stats.total.toLocaleString('fr-FR')} titres notés</span>
            </div>
          )}
        </div>

        {/* Filtres */}
        <div className="card scr-filters">
          <div className="row gap-8"><Icon name="filter" size={15} style={{ color: 'var(--ink-3)' }} /><span className="tiny scr-filter-kicker">Filtres</span></div>
          <div className="row gap-12">
            <span className="label">Note minimale</span>
            <div className="seg">{SCORE_OPTS.map(s => <button key={s} type="button" data-active={minScore === s} onClick={() => setMinScore(s)}>{s}{s < 10 ? '+' : ''}</button>)}</div>
          </div>
          <div className="row gap-12 scr-pfcf-filter">
            <span className="label" style={{ whiteSpace: 'nowrap' }}>P/FCF max</span>
            <input type="range" min={10} max={PFCF_MAX} value={maxPfcf} onChange={e => setMaxPfcf(+e.target.value)} style={{ flex: 1, accentColor: 'var(--brand)' }} />
            <span className="num tiny" style={{ fontWeight: 700, color: 'var(--brand-ink)', minWidth: 36 }}>{maxPfcf >= PFCF_MAX ? '∞' : maxPfcf + '×'}</span>
          </div>
          <span className="tiny muted" style={{ marginLeft: 'auto' }}>{sorted.length} résultats</span>
        </div>

        {error && <div className="card scr-msg">{error}</div>}

        {loading ? (
          <div className="card skel-ui" style={{ height: 320 }} />
        ) : sorted.length === 0 ? (
          <div className="card scr-empty">
            <h3>Aucune entreprise au-dessus de ce seuil</h3>
            <p className="muted">La veille note l'univers progressivement — reviens plus tard, ou baisse le seuil.</p>
          </div>
        ) : (
          <div className="card scroll-x" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Société</th>
                  <SortTh label="Note" col="score" />
                  <SortTh label="P/FCF" col="pfcf" />
                  <th style={{ textAlign: 'right' }}>Prochains résultats</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(r => (
                  <tr key={r.ticker} onClick={() => navigate(`/analyse/${r.ticker}`)}>
                    <td style={{ maxWidth: 360 }}>
                      <div className="tbl-soc">
                        <span className="num tbl-soc-ticker">{r.ticker}</span>
                        <span className="tbl-soc-name">{r.name ?? r.ticker}</span>
                      </div>
                    </td>
                    <td className="num-cell"><ScorePill score={Math.round(ratioOf(r) * 10)} /></td>
                    <td className="num-cell num" style={{ fontWeight: 600 }}>{r.pfcfTTM != null && r.pfcfTTM > 0 ? r.pfcfTTM.toFixed(1) + '×' : '—'}</td>
                    <td className="num-cell num" style={{ color: 'var(--ink-2)' }}>{formatEarnings(r.nextEarningsDate)}</td>
                    <td className="num-cell" style={{ width: 40 }}><span style={{ color: 'var(--ink-4)' }}><Icon name="chevronR" size={16} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ height: 50 }} />
      </div>
    </div>
  );
}
