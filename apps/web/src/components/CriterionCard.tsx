import { useState } from 'react';
import type { Criterion } from '@lubin/shared';
import { CRITERION_HISTOGRAMS, CRITERION_LINECHARTS } from '@lubin/shared';
import { HistogramModal } from './HistogramModal.js';
import { PfcfChartModal } from './PfcfChartModal.js';
import { CashRoceChartModal } from './CashRoceChartModal.js';
import { Icon, InfoPop, StatusBadge, toDataStatus } from './ui/primitives.js';
import { CRITERION_BRIEFS } from '../data/criterionBriefs.js';
import './CriterionCard.css';

/** Multiple P/FCF parsé depuis la valeur affichée (pour le ReferenceLine de la modale). */
function extractPfcfMultiple(c: Criterion): number | null {
  const m = c.valeur.match(/^([\d.,]+)\s*×?$/);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function CriterionCard({ c, ticker, currency = 'USD', annualOnly = false }: {
  c: Criterion; ticker?: string; currency?: string; annualOnly?: boolean;
}) {
  const histogramConfig = CRITERION_HISTOGRAMS[c.nom];
  const lineConfig = CRITERION_LINECHARTS[c.nom];
  const chartKind: 'line' | 'histogram' | null = ticker
    ? (lineConfig ? 'line' : (histogramConfig ? 'histogram' : null))
    : null;
  const [open, setOpen] = useState(false);
  const brief = CRITERION_BRIEFS[c.nom];

  return (
    <>
      <div className="crit-card">
        <div className="crit-card-head">
          <span className="crit-card-label">{c.nom}</span>
          <StatusBadge status={toDataStatus(c.statut)} />
        </div>
        <div className="crit-card-vrow">
          <span className="num crit-card-value">{c.valeur}</span>
          <span className="num crit-card-target">cible {c.cible}</span>
        </div>
        <p className="crit-card-note">{c.explication}</p>
        <div className="crit-card-foot">
          {brief
            ? <InfoPop title={c.nom} why={brief.why} calc={brief.how} />
            : <span />}
          {chartKind && (
            <button type="button" className="crit-hist-btn" onClick={() => setOpen(true)}>
              <Icon name="bars" size={13} /> Historique
            </button>
          )}
        </div>
      </div>

      {open && ticker && chartKind === 'histogram' && histogramConfig && (
        <HistogramModal ticker={ticker} criterionName={c.nom} config={histogramConfig} currency={currency} onClose={() => setOpen(false)} />
      )}
      {open && ticker && chartKind === 'line' && lineConfig?.kind === 'pfcf' && (
        <PfcfChartModal ticker={ticker} currentPfcf={extractPfcfMultiple(c)} annualOnly={annualOnly} onClose={() => setOpen(false)} />
      )}
      {open && ticker && chartKind === 'line' && lineConfig?.kind === 'cashRoce' && (
        <CashRoceChartModal ticker={ticker} annualOnly={annualOnly} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function CriteriaGrid({ items, ticker, currency, annualOnly }: {
  items: Criterion[]; ticker?: string; currency?: string; annualOnly?: boolean;
}) {
  return (
    <div className="criteria-grid">
      {items.map((c, i) => (
        <CriterionCard key={i} c={c} ticker={ticker} currency={currency} annualOnly={annualOnly} />
      ))}
    </div>
  );
}
