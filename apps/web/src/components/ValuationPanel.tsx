import { useState } from 'react';
import type { AnalyzeResponse, ValoParams, ValuationResult } from '@lubin/shared';
import { api } from '../lib/api.js';
import { CriteriaGrid } from './CriterionCard.js';
import './ValuationPanel.css';

export function ValuationPanel({ analysis, onValuationChanged }: {
  analysis: AnalyzeResponse;
  onValuationChanged: (v: ValuationResult, params: ValoParams) => void;
}) {
  const [fcfGrowth, setFcfGrowth] = useState((analysis.valoParams.fcfGrowth * 100).toFixed(1));
  const [targetMultiple, setTargetMultiple] = useState(String(analysis.valoParams.targetMultiple));
  const [loading, setLoading] = useState(false);

  const raw = analysis.valuation;

  async function recompute() {
    setLoading(true);
    try {
      const next: ValoParams = {
        targetReturn: 0.15,
        fcfGrowth: parseFloat(fcfGrowth) / 100,
        targetMultiple: parseFloat(targetMultiple),
      };
      const { valuation } = await api.revalue(analysis.ticker, next);
      onValuationChanged(valuation, next);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <CriteriaGrid items={[raw]} ticker={analysis.ticker} />
      <div className="valo-panel">
        <div className="valo-header">
          <div className="valo-title">⚙ Paramètres de valorisation</div>
          <div className="valo-fixed">rendement visé : <span className="valo-fixed-val">15 %/an (fixe)</span></div>
        </div>
        {raw.currentPrice != null && raw.fcfPsNow != null && raw.buyPrice != null && (
          <div className="valo-stats">
            <Stat label="Prix actuel" value={`${raw.currentPrice.toFixed(2)} ${analysis.currency}`} />
            <Stat label="FCF/action TTM" value={`${raw.fcfPsNow.toFixed(2)} ${analysis.currency}`} />
            <Stat label="P/FCF actuel" value={`${raw.currentPfcf?.toFixed(1) ?? 'N/A'}×`} accent="brand" />
            <Stat
              label="Prix d'achat cible"
              value={`${raw.buyPrice.toFixed(2)} ${analysis.currency}`}
              accent={(raw.discountPct ?? 0) >= 0 ? 'green' : 'red'}
            />
          </div>
        )}
        <div className="valo-form">
          <Field label="Croissance FCF/action projetée (%/an)" value={fcfGrowth} onChange={setFcfGrowth} step="0.5" />
          <Field label="Multiple P/FCF cible dans 5 ans (×)" value={targetMultiple} onChange={setTargetMultiple} step="1" />
        </div>
        <button className="btn-primary valo-recompute" onClick={recompute} disabled={loading}>
          {loading ? <><span className="spinner" /> Recalcul…</> : 'Recalculer la valorisation'}
        </button>
      </div>
    </>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'green' | 'red' | 'brand' }) {
  return (
    <div>
      <div className="valo-stat-label">{label.toUpperCase()}</div>
      <div className={`valo-stat-val ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

function Field({ label, value, onChange, step }: { label: string; value: string; onChange: (v: string) => void; step: string }) {
  return (
    <div className="valo-field">
      <label>{label}</label>
      <input type="number" step={step} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
