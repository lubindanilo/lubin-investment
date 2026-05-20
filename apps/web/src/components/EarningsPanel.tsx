import type { EarningsInfo, EarningsResult } from '@lubin/shared';
import './EarningsPanel.css';

/**
 * Affiche le dernier et le prochain earnings d'un ticker :
 *   - Date Q + année
 *   - EPS surprise (vs estimate)
 *   - Revenue surprise (vs estimate)
 *   - Lien externe vers transcripts Seeking Alpha (pas d'API gratuite pour le transcript brut)
 */
export function EarningsPanel({ ticker, earnings }: { ticker: string; earnings: EarningsInfo }) {
  const { next, last } = earnings;
  if (!next && !last) return null;  // pas de données → on n'affiche rien

  const seekingAlpha = `https://seekingalpha.com/symbol/${ticker}/earnings/transcripts`;

  return (
    <div className="earnings-panel">
      <div className="earnings-title">
        <span>📅 Earnings — {ticker}</span>
        <a
          href={seekingAlpha}
          target="_blank"
          rel="noopener noreferrer"
          className="earnings-transcript-link"
        >
          Voir le transcript du dernier call ↗
        </a>
      </div>
      <div className="earnings-grid">
        {last && <EarningsCard label="Dernier rapport" e={last} />}
        {next && <EarningsCard label="Prochain rapport" e={next} isFuture />}
      </div>
    </div>
  );
}

function EarningsCard({ label, e, isFuture = false }: { label: string; e: EarningsResult; isFuture?: boolean }) {
  const dateFmt = new Date(e.date + 'T12:00:00Z').toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const epsBeat = e.epsSurprise != null ? e.epsSurprise > 0 : null;
  const revBeat = e.revenueSurprisePct != null ? e.revenueSurprisePct > 0 : null;

  return (
    <div className="earnings-card">
      <div className="earnings-card-label">{label}</div>
      <div className="earnings-card-date">
        Q{e.quarter} {e.year} <span className="earnings-card-day">· {dateFmt}{e.hour ? ` ${e.hour === 'bmo' ? 'avant ouverture' : e.hour === 'amc' ? 'après clôture' : ''}` : ''}</span>
      </div>
      {isFuture ? (
        <div className="earnings-card-info">
          <Field label="EPS attendu" value={e.epsEstimate != null ? e.epsEstimate.toFixed(2) + ' $' : '–'} />
          <Field label="CA attendu" value={e.revenueEstimate != null ? formatRevenue(e.revenueEstimate) : '–'} />
        </div>
      ) : (
        <div className="earnings-card-info">
          <Field
            label="EPS"
            value={e.epsActual != null ? `${e.epsActual.toFixed(2)} $` : '–'}
            sub={
              e.epsEstimate != null && e.epsSurprisePct != null
                ? `vs ${e.epsEstimate.toFixed(2)} (${formatPct(e.epsSurprisePct)})`
                : undefined
            }
            color={epsBeat == null ? undefined : epsBeat ? 'green' : 'red'}
          />
          <Field
            label="Revenue"
            value={e.revenueActual != null ? formatRevenue(e.revenueActual) : '–'}
            sub={
              e.revenueEstimate != null && e.revenueSurprisePct != null
                ? `vs ${formatRevenue(e.revenueEstimate)} (${formatPct(e.revenueSurprisePct)})`
                : undefined
            }
            color={revBeat == null ? undefined : revBeat ? 'green' : 'red'}
          />
        </div>
      )}
    </div>
  );
}

function Field({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: 'green' | 'red' }) {
  return (
    <div className="earnings-field">
      <div className="earnings-field-label">{label}</div>
      <div className={`earnings-field-value ${color ?? ''}`}>{value}</div>
      {sub && <div className="earnings-field-sub">{sub}</div>}
    </div>
  );
}

function formatRevenue(amount: number): string {
  // Finnhub renvoie le revenue en USD (pas millions). Affichage : M ou B selon taille.
  const abs = Math.abs(amount);
  if (abs >= 1e9) return (amount / 1e9).toFixed(2) + ' B$';
  if (abs >= 1e6) return (amount / 1e6).toFixed(0) + ' M$';
  return amount.toFixed(0) + ' $';
}

function formatPct(p: number): string {
  const sign = p >= 0 ? '+' : '';
  return `${sign}${(p * 100).toFixed(1)}%`;
}
