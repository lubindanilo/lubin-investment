import { useState } from 'react';
import type { Criterion } from '@lubin/shared';
import { CRITERION_HISTOGRAMS, CRITERION_LINECHARTS } from '@lubin/shared';
import { HistogramModal } from './HistogramModal.js';
import { PfcfChartModal } from './PfcfChartModal.js';
import './CriterionCard.css';

const BADGE_LABEL: Record<Criterion['statut'], string> = {
  pass: '✓ OUI',
  fail: '✗ NON',
  warn: '⚠ PARTIEL',
};

/** Récupère le multiple P/FCF si le critère est "P/FCF actuel" — utile pour le ReferenceLine de la modal. */
function extractPfcfMultiple(c: Criterion): number | null {
  // Côté backend on stocke aussi metrics.pfcfTTM ; côté Criterion on a juste "valeur" type "22.5×".
  // On parse la valeur affichée comme fallback.
  const m = c.valeur.match(/^([\d.,]+)\s*×?$/);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function CriterionCard({ c, ticker }: { c: Criterion; ticker?: string }) {
  const histogramConfig = CRITERION_HISTOGRAMS[c.nom];
  const lineConfig = CRITERION_LINECHARTS[c.nom];
  // Un critère ne peut être que d'un seul type (line OU histo) — line gagne s'il y a un conflit.
  const chartKind: 'line' | 'histogram' | null = ticker
    ? (lineConfig ? 'line' : (histogramConfig ? 'histogram' : null))
    : null;
  const clickable = chartKind !== null;
  const [open, setOpen] = useState(false);
  const hintLabel = chartKind === 'line'
    ? lineConfig?.label
    : histogramConfig?.label;

  return (
    <>
      <div
        className={`critere-card ${c.statut} ${clickable ? 'clickable' : ''}`}
        onClick={clickable ? () => setOpen(true) : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }) : undefined}
        title={clickable && hintLabel ? `Voir : ${hintLabel}` : undefined}
      >
        <div className="critere-header">
          <div className="critere-name">{c.nom}</div>
          <div className={`badge ${c.statut}`}>{BADGE_LABEL[c.statut]}</div>
        </div>
        <div className="critere-value">{c.valeur}</div>
        <div className="critere-target">{c.cible}</div>
        <div className="critere-explain">{c.explication}</div>
        {clickable && (
          <div className="critere-hist-hint">
            {chartKind === 'line' ? '📈' : '📊'} cliquer pour voir l'historique
          </div>
        )}
      </div>

      {open && ticker && chartKind === 'histogram' && histogramConfig && (
        <HistogramModal
          ticker={ticker}
          criterionName={c.nom}
          config={histogramConfig}
          onClose={() => setOpen(false)}
        />
      )}

      {open && ticker && chartKind === 'line' && lineConfig?.kind === 'pfcf' && (
        <PfcfChartModal
          ticker={ticker}
          currentPfcf={extractPfcfMultiple(c)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function CriteriaGrid({ items, ticker }: { items: Criterion[]; ticker?: string }) {
  return (
    <div className="criteria-grid">
      {items.map((c, i) => (
        <CriterionCard key={i} c={c} ticker={ticker} />
      ))}
    </div>
  );
}
