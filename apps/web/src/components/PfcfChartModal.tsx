/**
 * PfcfChartModal — graphique line (≠ histogramme) montrant l'évolution du P/FCF
 * d'un ticker dans le temps. Cliquable depuis le critère "P/FCF actuel".
 *
 * Le P/FCF est calculé côté API par join (price × shares / TTM_FCF). Les points
 * où le ratio n'est pas pertinent (FCF négatif, données manquantes) sont déjà
 * filtrés par l'API — donc la ligne aura des "gaps" naturels là où le FCF était négatif.
 *
 * UX miroir de HistogramModal :
 *   - Sélecteur de période 1Y / 5Y / 10Y / 20Y / All
 *   - Stats récapitulatifs (latest, médiane, min, max, percentile actuel)
 *   - Référence visuelle à la médiane historique (signal mean-reversion)
 */
import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import type { TimeseriesPeriod, PfcfHistoryPoint } from '@lubin/shared';
import { PERIOD_YEARS } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import './PfcfChartModal.css';

const PERIODS: TimeseriesPeriod[] = ['1Y', '5Y', '10Y', '20Y', 'All'];

interface Props {
  ticker: string;
  currentPfcf: number | null;
  /** True si le ticker n'a que des données annuelles (EU + ADRs étrangers comme ASML, NSRGY) →
   *  ~4 points annuels max, le sélecteur de période n'a plus de sens. */
  annualOnly?: boolean;
  onClose: () => void;
}

export function PfcfChartModal({ ticker, currentPfcf, annualOnly = false, onClose }: Props) {
  const [period, setPeriod] = useState<TimeseriesPeriod>('5Y');
  const [data, setData] = useState<PfcfHistoryPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Charge la série à chaque changement de période
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pfcfHistory(ticker, PERIOD_YEARS[period])
      .then(res => { if (!cancelled) setData(res.points); })
      .catch(e => {
        if (!cancelled) setError(e instanceof ApiError ? e.userMessage : (e as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, period]);

  // Échap ferme la modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Stats : médiane, min, max, percentile du niveau actuel
  const stats = useMemo(() => {
    if (!data || data.length === 0) return null;
    const values = data.map(p => p.pfcf).filter(v => Number.isFinite(v) && v > 0);
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const latest = data[data.length - 1]!.pfcf;
    // Percentile : où se situe `latest` dans la distribution historique
    let belowOrEqual = 0;
    for (const v of sorted) if (v <= latest) belowOrEqual++;
    const percentile = (belowOrEqual / sorted.length) * 100;
    return { median, min, max, latest, percentile };
  }, [data]);

  return (
    <div className="pfcf-overlay" onClick={onClose}>
      <div className="pfcf-modal" onClick={e => e.stopPropagation()}>
        <header className="pfcf-header">
          <div>
            <div className="pfcf-ticker">{ticker}</div>
            <h2 className="pfcf-title">Évolution du P/FCF dans le temps</h2>
            <div className="pfcf-sub">
              Calculé : prix × actions ÷ FCF (TTM) — source Yahoo + Finnhub
            </div>
          </div>
          <button className="pfcf-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <div className="pfcf-periods">
          {annualOnly ? (
            <span className="period-static">4 ans annuels (max disponible pour ce ticker)</span>
          ) : (
            PERIODS.map(p => (
              <button
                key={p}
                className={`period-btn ${p === period ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {p}
              </button>
            ))
          )}
        </div>

        {loading && <div className="pfcf-loading"><span className="spinner" /> Chargement…</div>}

        {error && !loading && (
          <div className="pfcf-error">Erreur : {error}</div>
        )}

        {!loading && !error && data && data.length === 0 && (
          <div className="pfcf-error">Pas assez d'historique pour calculer le P/FCF sur cette période.</div>
        )}

        {!loading && !error && data && data.length > 0 && (
          <>
            <div className="pfcf-chart-wrap">
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: 'var(--text3)' }}
                    tickFormatter={d => formatDateTick(d, period)}
                    interval="preserveStartEnd"
                    minTickGap={32}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--text3)' }}
                    tickFormatter={v => v.toFixed(0) + '×'}
                    width={42}
                  />
                  <Tooltip
                    contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text2)', fontFamily: 'IBM Plex Mono, monospace' }}
                    formatter={(v) => [Number(v).toFixed(2) + '×', 'P/FCF']}
                    labelFormatter={d => formatDateFull(String(d))}
                  />
                  {/* Médiane historique → repère mean-reversion */}
                  {stats && (
                    <ReferenceLine
                      y={stats.median}
                      stroke="var(--text3)"
                      strokeDasharray="4 4"
                      label={{ value: `médiane ${stats.median.toFixed(1)}×`, position: 'right', fontSize: 10, fill: 'var(--text3)' }}
                    />
                  )}
                  {/* Niveau actuel → reference forte si fourni séparément (souvent ≈ dernier point) */}
                  {currentPfcf != null && (
                    <ReferenceLine
                      y={currentPfcf}
                      stroke="var(--brand)"
                      strokeDasharray="2 4"
                      strokeOpacity={0.5}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="pfcf"
                    stroke="var(--brand)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: 'var(--brand)' }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {stats && (
              <div className="pfcf-stats">
                <Stat
                  label={annualOnly ? 'Dernière clôture annuelle' : 'Actuel'}
                  value={`${stats.latest.toFixed(1)}×`}
                  accent={stats.latest < stats.median ? 'green' : 'red'}
                />
                <Stat label="Médiane période" value={`${stats.median.toFixed(1)}×`} />
                <Stat label="Min / Max" value={`${stats.min.toFixed(1)}× / ${stats.max.toFixed(1)}×`} />
                <Stat
                  label="Percentile"
                  value={`${stats.percentile.toFixed(0)}e`}
                  accent={stats.percentile < 30 ? 'green' : stats.percentile > 70 ? 'red' : undefined}
                />
                <Stat label="Points" value={String(data.length)} />
              </div>
            )}

            {stats && (
              <div className="pfcf-help">
                {stats.latest < stats.median
                  ? `Le dernier multiple (${stats.latest.toFixed(1)}×) est sous la médiane historique (${stats.median.toFixed(1)}×) — valorisation relative attractive.`
                  : `Le dernier multiple (${stats.latest.toFixed(1)}×) est au-dessus de la médiane historique (${stats.median.toFixed(1)}×) — valorisation tendue vs son propre passé.`}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'red' }) {
  return (
    <div className="pfcf-stat">
      <div className="pfcf-stat-label">{label}</div>
      <div className={`pfcf-stat-val ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

function formatDateTick(isoDate: string, period: TimeseriesPeriod): string {
  // 1Y : MMM 'YY (court) ; 5Y+ : MM/YY
  if (period === '1Y') {
    const d = new Date(isoDate);
    return d.toLocaleDateString('fr-FR', { month: 'short' });
  }
  return isoDate.slice(2, 7).replace('-', '/');
}

function formatDateFull(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
