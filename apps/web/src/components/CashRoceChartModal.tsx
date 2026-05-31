/**
 * CashRoceChartModal — graphique line montrant l'évolution du Cash ROCE
 * d'un ticker dans le temps. Cliquable depuis le critère "Cash ROCE".
 *
 * Formule (cohérente avec derivedMetrics.ts / yahooFundamentals.ts) :
 *   cashROCE(t) = FCF_adj_TTM(t) / (equity(t) + total_debt(t))
 *
 * UX miroir de PfcfChartModal — sélecteur de période, stats, médiane, seuil 15 %.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import type { TimeseriesPeriod, CashRoceHistoryPoint } from '@lubin/shared';
import { PERIOD_YEARS } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import './CashRoceChartModal.css';

const PERIODS: TimeseriesPeriod[] = ['1Y', '5Y', '10Y', '20Y', 'All'];

/** Seuil pass/fail visualisé sur le chart — cohérent avec buildQuantitativeCriteria. */
const THRESHOLD = 0.15;

interface Props {
  ticker: string;
  /** True si le ticker n'a que des données annuelles (EU + ADRs étrangers) →
   *  ~4 points annuels max, le sélecteur de période n'a plus de sens. */
  annualOnly?: boolean;
  onClose: () => void;
}

export function CashRoceChartModal({ ticker, annualOnly = false, onClose }: Props) {
  const [period, setPeriod] = useState<TimeseriesPeriod>('5Y');
  const [data, setData] = useState<CashRoceHistoryPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.cashRoceHistory(ticker, PERIOD_YEARS[period])
      .then(res => { if (!cancelled) setData(res.points); })
      .catch(e => {
        if (!cancelled) setError(e instanceof ApiError ? e.userMessage : (e as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, period]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stats = useMemo(() => {
    if (!data || data.length === 0) return null;
    const values = data.map(p => p.cashRoce).filter(v => Number.isFinite(v) && v > 0);
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const latest = data[data.length - 1]!.cashRoce;
    // Combien de quarters/années ≥ seuil — signal de constance qualitative
    const aboveThreshold = values.filter(v => v >= THRESHOLD).length;
    const pctAbove = (aboveThreshold / values.length) * 100;
    return { median, min, max, latest, pctAbove, aboveThreshold, n: values.length };
  }, [data]);

  return (
    <div className="croce-overlay" onClick={onClose}>
      <div className="croce-modal" onClick={e => e.stopPropagation()}>
        <header className="croce-header">
          <div>
            <div className="croce-ticker">{ticker}</div>
            <h2 className="croce-title">Évolution du Cash ROCE</h2>
            <div className="croce-sub">
              Formule : FCF (ajusté SBC) ÷ (Assets − CurLiab − Goodwill − Cash excédentaire) — Bettin/Mauboussin. Cash excédentaire = max(0, cash − 2 % × revenue).
            </div>
          </div>
          <button className="croce-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <div className="croce-periods">
          {annualOnly ? (
            <span className="period-static">Annuel (max disponible pour ce ticker)</span>
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

        {loading && <div className="croce-loading"><span className="spinner" /> Chargement…</div>}

        {error && !loading && (
          <div className="croce-error">Erreur : {error}</div>
        )}

        {!loading && !error && data && data.length === 0 && (
          <div className="croce-error">
            Pas assez d'historique pour calculer le Cash ROCE sur cette période
            (besoin de FCF positif + capital employé positif sur ≥ 4 trimestres / 2 exercices).
          </div>
        )}

        {!loading && !error && data && data.length > 0 && (
          <>
            <div className="croce-chart-wrap">
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
                    tickFormatter={v => (v * 100).toFixed(0) + '%'}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}
                    formatter={(v) => [(Number(v) * 100).toFixed(2) + '%', 'Cash ROCE']}
                    labelFormatter={d => formatDateFull(String(d))}
                  />
                  {/* Seuil pass/fail à 15 % */}
                  <ReferenceLine
                    y={THRESHOLD}
                    stroke="var(--text3)"
                    strokeDasharray="4 4"
                    label={{ value: 'seuil 15 %', position: 'right', fontSize: 10, fill: 'var(--text3)' }}
                  />
                  {/* Médiane historique pour signal mean-reversion */}
                  {stats && (
                    <ReferenceLine
                      y={stats.median}
                      stroke="var(--brand)"
                      strokeDasharray="2 4"
                      strokeOpacity={0.5}
                      label={{ value: `médiane ${(stats.median * 100).toFixed(1)}%`, position: 'insideTopRight', fontSize: 10, fill: 'var(--brand)' }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="cashRoce"
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
              <div className="croce-stats">
                <Stat
                  label={annualOnly ? 'Dernière clôture' : 'Actuel (TTM)'}
                  value={(stats.latest * 100).toFixed(1) + '%'}
                  accent={stats.latest >= THRESHOLD ? 'green' : 'red'}
                />
                <Stat label="Médiane période" value={(stats.median * 100).toFixed(1) + '%'} />
                <Stat label="Min / Max" value={`${(stats.min * 100).toFixed(1)}% / ${(stats.max * 100).toFixed(1)}%`} />
                <Stat
                  label="Quarters ≥ 15 %"
                  value={`${stats.aboveThreshold}/${stats.n} (${stats.pctAbove.toFixed(0)}%)`}
                  accent={stats.pctAbove >= 70 ? 'green' : stats.pctAbove >= 40 ? undefined : 'red'}
                />
                <Stat label="Points" value={String(data.length)} />
              </div>
            )}

            {stats && (
              <div className="croce-help">
                {stats.pctAbove >= 80
                  ? `Cash ROCE durablement au-dessus de 15 % (${stats.aboveThreshold}/${stats.n} périodes) — création de valeur opérationnelle constante.`
                  : stats.pctAbove >= 40
                    ? `Cash ROCE au-dessus du seuil sur ${stats.aboveThreshold}/${stats.n} périodes — qualité moyenne, à surveiller.`
                    : `Cash ROCE rarement au-dessus de 15 % (${stats.aboveThreshold}/${stats.n} périodes) — création de valeur opérationnelle faible.`}
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
    <div className="croce-stat">
      <div className="croce-stat-label">{label}</div>
      <div className={`croce-stat-val ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

function formatDateTick(isoDate: string, period: TimeseriesPeriod): string {
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
