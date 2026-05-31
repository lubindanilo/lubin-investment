/**
 * PriceChart — graphique line du cours de bourse maison, utilisé en fallback quand
 * TradingView ne sait pas afficher un ticker (typiquement EU sans préfixe d'exchange).
 *
 * Données via /api/price-history (Yahoo /v8/finance/chart, 20-30 ans de prix mensuel
 * pour les EU + US). Sélecteur 1M / 6M / 1A / 5A / 10A / 20A / All.
 *
 * UX clé : ressemble visuellement à TradingViewChart (mêmes périodes en haut à droite)
 * mais sans dépendre de l'iframe TV qui ne résout pas les symbols EU sans préfixe.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import { api, ApiError } from '../lib/api.js';
import './TradingViewChart.css';

const PERIODS = ['1M', '6M', '1A', '5A', '10A', '20A', 'All'] as const;
type Period = typeof PERIODS[number];

const PERIOD_CONFIG: Record<Period, { years: number; interval: '1d' | '1wk' | '1mo' }> = {
  '1M':  { years: 1,  interval: '1d' },
  '6M':  { years: 1,  interval: '1d' },
  '1A':  { years: 1,  interval: '1wk' },
  '5A':  { years: 5,  interval: '1mo' },
  '10A': { years: 10, interval: '1mo' },
  '20A': { years: 20, interval: '1mo' },
  'All': { years: 50, interval: '1mo' },
};

interface Props {
  ticker: string;
  /** Devise à afficher (CHF, EUR, USD…) — vient d'analysis.currency */
  currency: string;
}

export function PriceChart({ ticker, currency }: Props) {
  const [period, setPeriod] = useState<Period>('5A');
  const [allData, setAllData] = useState<{ date: string; value: number }[] | null>(null);
  const [resolvedSymbol, setResolvedSymbol] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const cfg = PERIOD_CONFIG[period];
    api.priceHistory(ticker, cfg.years, cfg.interval)
      .then(res => {
        if (cancelled) return;
        setAllData(res.points);
        setResolvedSymbol(res.symbol);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof ApiError ? e.userMessage : (e as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ticker, period]);

  // Filtre dynamique pour 1M/6M (utilisent les mêmes données 1Y daily mais on tronque)
  const data = useMemo(() => {
    if (!allData) return [];
    if (period !== '1M' && period !== '6M') return allData;
    const months = period === '1M' ? 1 : 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return allData.filter(p => p.date >= cutoffIso);
  }, [allData, period]);

  const stats = useMemo(() => {
    if (data.length === 0) return null;
    const first = data[0]!.value;
    const last = data[data.length - 1]!.value;
    const change = (last - first) / first;
    const min = Math.min(...data.map(p => p.value));
    const max = Math.max(...data.map(p => p.value));
    return { first, last, change, min, max };
  }, [data]);

  return (
    <div className="chart-section">
      <div className="chart-title">
        <span>
          Cours boursier — {ticker}
          {resolvedSymbol && resolvedSymbol !== ticker && (
            <span className="chart-source-note"> ({resolvedSymbol}, {currency})</span>
          )}
        </span>
        <div className="chart-periods">
          {PERIODS.map(p => (
            <button
              key={p}
              className={`period-btn ${p === period ? 'active' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="chart-state"><span className="spinner" /> Chargement…</div>}
      {error && !loading && <div className="chart-state chart-state-error">Erreur : {error}</div>}

      {!loading && !error && data.length > 0 && (
        <div className="chart-iframe-wrap" style={{ height: 380, padding: '8px 14px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'var(--text3)' }}
                tickFormatter={d => formatTick(d, period)}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text3)' }}
                tickFormatter={v => `${v.toFixed(v < 10 ? 2 : 0)}`}
                width={50}
                domain={['auto', 'auto']}
              />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: 'var(--text2)', fontFamily: 'var(--mono)' }}
                formatter={(v) => [`${Number(v).toFixed(2)} ${currency}`, 'Cours']}
                labelFormatter={d => formatTickFull(String(d))}
              />
              {stats && (
                <ReferenceLine
                  y={stats.first}
                  stroke="var(--text3)"
                  strokeDasharray="3 3"
                  strokeOpacity={0.5}
                />
              )}
              <Line
                type="monotone"
                dataKey="value"
                stroke={stats && stats.change >= 0 ? 'var(--green)' : 'var(--red)'}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {stats && !loading && !error && data.length > 0 && (
        <div className="chart-stats-row">
          <span className="chart-stat">
            <span className="chart-stat-label">Début</span>
            <span className="chart-stat-val">{stats.first.toFixed(2)} {currency}</span>
          </span>
          <span className="chart-stat">
            <span className="chart-stat-label">Fin</span>
            <span className="chart-stat-val">{stats.last.toFixed(2)} {currency}</span>
          </span>
          <span className="chart-stat">
            <span className="chart-stat-label">Variation</span>
            <span className={`chart-stat-val ${stats.change >= 0 ? 'green' : 'red'}`}>
              {stats.change >= 0 ? '+' : ''}{(stats.change * 100).toFixed(1)}%
            </span>
          </span>
          <span className="chart-stat">
            <span className="chart-stat-label">Min / Max</span>
            <span className="chart-stat-val">{stats.min.toFixed(2)} / {stats.max.toFixed(2)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function formatTick(isoDate: string, period: Period): string {
  const d = new Date(isoDate);
  if (period === '1M') return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  if (period === '6M' || period === '1A') return d.toLocaleDateString('fr-FR', { month: 'short' });
  return isoDate.slice(2, 7).replace('-', '/');
}

function formatTickFull(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
