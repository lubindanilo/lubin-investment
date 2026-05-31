import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import type { TimeseriesPeriod, CriterionHistogram, TimeseriesPoint } from '@lubin/shared';
import { PERIOD_YEARS } from '@lubin/shared';
import { api, ApiError } from '../lib/api.js';
import './HistogramModal.css';

const PERIODS: TimeseriesPeriod[] = ['1Y', '5Y', '10Y', '20Y', 'All'];

interface Props {
  ticker: string;
  criterionName: string;
  config: CriterionHistogram;
  /** Devise reporting du ticker (USD, CHF, EUR…) — pour les axes/tooltips des séries currency */
  currency?: string;
  onClose: () => void;
}

export function HistogramModal({ ticker, criterionName, config, currency = 'USD', onClose }: Props) {
  const [period, setPeriod] = useState<TimeseriesPeriod>('5Y');
  const [data, setData] = useState<TimeseriesPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [euAnnualOnly, setEuAnnualOnly] = useState(false);
  const [actualFreq, setActualFreq] = useState<'quarterly' | 'annual'>('quarterly');

  // Demandé : 1Y et 5Y → quarterly. Le backend peut override en annual pour les tickers EU.
  const requestedFreq: 'quarterly' | 'annual' = (period === '1Y' || period === '5Y') ? 'quarterly' : 'annual';

  // Charge la série au changement de période
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.timeseries(ticker, config.metricKey, PERIOD_YEARS[period], requestedFreq)
      .then(res => {
        if (cancelled) return;
        setData(res.points);
        setEuAnnualOnly(res.euAnnualOnly ?? false);
        setActualFreq(res.freq);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof ApiError ? e.userMessage : (e as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, config.metricKey, period, requestedFreq]);

  // Utilise toujours actualFreq (ce que le backend a effectivement servi) pour
  // formater les ticks/tooltips correctement.
  const freq = actualFreq;

  // Échap pour fermer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Détecte les "gaps" dans la série (typiquement causés par un changement de ticker —
   * ex Fiserv FISV → FI mi-2023 — qui partitionne les filings entre 2 symbols).
   * Quarterly : un gap normal entre 2 points = ~90j. On flag à partir de 200j.
   * Annual    : ~365j entre 2 points. On flag à partir de 540j.
   */
  const gaps = useMemo(() => {
    if (!data || data.length < 2) return [];
    const thresholdMs = (freq === 'quarterly' ? 200 : 540) * 24 * 3600 * 1000;
    const out: { from: string; to: string; missingApprox: number }[] = [];
    for (let i = 1; i < data.length; i++) {
      const a = new Date(data[i-1]!.date).getTime();
      const b = new Date(data[i]!.date).getTime();
      const delta = b - a;
      if (delta > thresholdMs) {
        const periodMs = (freq === 'quarterly' ? 91 : 365) * 24 * 3600 * 1000;
        out.push({
          from: data[i-1]!.date,
          to: data[i]!.date,
          missingApprox: Math.round(delta / periodMs) - 1,
        });
      }
    }
    return out;
  }, [data, freq]);

  // Stats : valeur la plus récente, moyenne, CAGR sur la période
  const stats = useMemo(() => {
    if (!data || data.length === 0) return null;
    const latest = data[data.length - 1]!;
    const oldest = data[0]!;
    const values = data.map(p => p.value);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    // CAGR : seulement pour les séries strictement positives ET sans gap (sinon
    // calcul absurde sur 2 segments discontinus — typique des changements de ticker).
    let cagr: number | null = null;
    if (oldest.value > 0 && latest.value > 0 && gaps.length === 0) {
      const years = (new Date(latest.date).getTime() - new Date(oldest.date).getTime()) / (365.25 * 24 * 3600 * 1000);
      if (years >= 1) cagr = Math.pow(latest.value / oldest.value, 1 / years) - 1;
    }
    return { latest, avg, cagr };
  }, [data, gaps]);

  // Insère des "trous" visuels : pour chaque gap détecté, on ajoute des barres
  // fantômes (value=null) aux dates manquantes → recharts laisse un espace vide
  // au lieu de coller deux trimestres distants d'un an (ex AMD, FY2023 manquant).
  // Les stats/gaps restent calculés sur `data` (les vrais points).
  const chartData = useMemo<Array<{ date: string; value: number | null }>>(() => {
    if (!data || data.length === 0) return [];
    if (gaps.length === 0) return data;
    const stepMs = (freq === 'quarterly' ? 91 : 365) * 24 * 3600 * 1000;
    const out: Array<{ date: string; value: number | null }> = [];
    for (let i = 0; i < data.length; i++) {
      out.push(data[i]!);
      const next = data[i + 1];
      if (!next) continue;
      let cursor = new Date(data[i]!.date).getTime();
      const target = new Date(next.date).getTime();
      while (target - cursor > stepMs * 1.5) {
        cursor += stepMs;
        out.push({ date: new Date(cursor).toISOString().slice(0, 10), value: null });
      }
    }
    return out;
  }, [data, gaps, freq]);

  return (
    <div className="hist-overlay" onClick={onClose}>
      <div className="hist-modal" onClick={e => e.stopPropagation()}>
        <header className="hist-header">
          <div>
            <div className="hist-ticker">{ticker}</div>
            <h2 className="hist-title">{config.label}</h2>
            <div className="hist-sub">
              Critère : {criterionName} · {freq === 'quarterly' ? 'données trimestrielles' : 'données annuelles'}
            </div>
          </div>
          <button className="hist-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>

        <div className="hist-periods">
          {euAnnualOnly ? (
            // Tickers EU : Yahoo n'expose que ~4 années annuelles. Les boutons 1Y/5Y/…/All
            // renverraient tous les mêmes 4 points → UX trompeuse. On affiche un tag static.
            <span className="period-static">Données annuelles</span>
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

        {loading && <div className="hist-loading"><span className="spinner" /> Chargement…</div>}

        {error && !loading && (
          <div className="hist-error">Erreur : {error}</div>
        )}

        {!loading && !error && data && data.length === 0 && (
          <div className="hist-error">Aucune donnée trimestrielle disponible pour cette période.</div>
        )}

        {!loading && !error && data && data.length > 0 && (
          <>
            <div className="hist-chart-wrap">
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: 'var(--text3)' }}
                    tickFormatter={d => d.slice(2, 7).replace('-', '/')}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--text3)' }}
                    tickFormatter={v => formatCompact(v, config.unit)}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}
                    formatter={(v) => [formatFull(Number(v), config.unit, currency), config.label]}
                    labelFormatter={d => freq === 'quarterly' ? `Trimestre ${formatQuarter(String(d))}` : `Année ${String(d).slice(0, 4)}`}
                  />
                  <ReferenceLine y={0} stroke="var(--text3)" strokeWidth={1} />
                  <Bar
                    dataKey="value"
                    fill="var(--brand)"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={32}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {stats && (
              <div className="hist-stats">
                <Stat label={freq === 'quarterly' ? 'Dernier trimestre' : 'Dernière année'} value={`${formatFull(stats.latest.value, config.unit, currency)} (${freq === 'quarterly' ? formatQuarter(stats.latest.date) : stats.latest.date.slice(0, 4)})`} />
                <Stat label="Moyenne période" value={formatFull(stats.avg, config.unit, currency)} />
                {stats.cagr !== null && (
                  <Stat label="CAGR sur période" value={(stats.cagr * 100).toFixed(2) + '%/an'} accent={stats.cagr >= 0 ? 'green' : 'red'} />
                )}
                <Stat label={freq === 'quarterly' ? 'Trimestres' : 'Années'} value={String(data.length)} />
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
    <div className="hist-stat">
      <div className="hist-stat-label">{label}</div>
      <div className={`hist-stat-val ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

function formatCompact(v: number, unit: CriterionHistogram['unit']): string {
  if (unit === 'percent') return (v).toFixed(0) + '%';
  if (unit === 'count') {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + 'k';
    return v.toFixed(0);
  }
  // currency / raw : compact $
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(0) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + 'k';
  return v.toFixed(0);
}

function formatFull(v: number, unit: CriterionHistogram['unit'], currency = 'USD'): string {
  if (unit === 'percent') return v.toFixed(2) + '%';
  if (unit === 'count') return v.toLocaleString('fr-FR');
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} ${currency}`;
}

function formatQuarter(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})/);
  if (!m) return isoDate;
  const month = parseInt(m[2]!, 10);
  const q = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';
  return `${q} ${m[1]}`;
}
