import { useState } from 'react';
import type { Criterion } from '@lubin/shared';
import { CRITERION_HISTOGRAMS } from '@lubin/shared';
import { HistogramModal } from './HistogramModal.js';
import './CriterionCard.css';

const BADGE_LABEL: Record<Criterion['statut'], string> = {
  pass: '✓ OUI',
  fail: '✗ NON',
  warn: '⚠ PARTIEL',
};

export function CriterionCard({ c, ticker }: { c: Criterion; ticker?: string }) {
  const histogramConfig = CRITERION_HISTOGRAMS[c.nom];
  const clickable = Boolean(ticker && histogramConfig);
  const [open, setOpen] = useState(false);

  return (
    <>
      <div
        className={`critere-card ${c.statut} ${clickable ? 'clickable' : ''}`}
        onClick={clickable ? () => setOpen(true) : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }) : undefined}
        title={clickable ? `Voir l'évolution trimestrielle — ${histogramConfig!.label}` : undefined}
      >
        <div className="critere-header">
          <div className="critere-name">{c.nom}</div>
          <div className={`badge ${c.statut}`}>{BADGE_LABEL[c.statut]}</div>
        </div>
        <div className="critere-value">{c.valeur}</div>
        <div className="critere-target">{c.cible}</div>
        <div className="critere-explain">{c.explication}</div>
        {clickable && <div className="critere-hist-hint">📊 cliquer pour voir l'historique</div>}
      </div>

      {open && ticker && histogramConfig && (
        <HistogramModal
          ticker={ticker}
          criterionName={c.nom}
          config={histogramConfig}
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
