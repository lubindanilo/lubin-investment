/**
 * ValuationBlock — prix d'achat conseillé (DCF simplifié sur 5 ans), calculé en direct
 * côté client à partir de 3 hypothèses ajustables. Jugé séparément de la note de qualité.
 *
 *   futureFCF = fcfParAction × (1 + croissance)^5
 *   exitPrice = futureFCF × multipleSortie
 *   buyPrice  = exitPrice / (1 + rendementVisé)^5
 */
import { useState } from 'react';
import { Icon } from './primitives.js';
import './ValuationBlock.css';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function Slider({ label, value, set, min, max, step, suffix }: {
  label: string; value: number; set: (v: number) => void; min: number; max: number; step: number; suffix: string;
}) {
  return (
    <div className="col gap-6">
      <div className="row between">
        <span className="label">{label}</span>
        <span className="num valb-slider-val">{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => set(parseFloat(e.target.value))} className="valb-range" />
    </div>
  );
}

export function ValuationBlock({ price, pfcfTTM, currency = 'USD', valoParams }: {
  price: number | null;
  pfcfTTM: number | null;
  currency?: string;
  valoParams?: { targetReturn: number; fcfGrowth: number; targetMultiple: number };
}) {
  const fcfPerShare = price != null && pfcfTTM != null && pfcfTTM > 0 ? price / pfcfTTM : null;
  const [growth, setGrowth] = useState(() => clamp(Math.round((valoParams?.fcfGrowth ?? 0.1) * 100), 0, 30));
  const [exitMult, setExitMult] = useState(() => clamp(Math.round(valoParams?.targetMultiple ?? 20), 8, 40));
  const [ret, setRet] = useState(() => clamp(Math.round((valoParams?.targetReturn ?? 0.15) * 100), 6, 20));

  const sym = currency === 'USD' ? '$' : `${currency} `;

  if (fcfPerShare == null || price == null) {
    return (
      <div className="card valb" style={{ padding: 22 }}>
        <span className="muted" style={{ fontSize: 14 }}>Valorisation indisponible (FCF par action non calculable pour ce titre).</span>
      </div>
    );
  }

  const years = 5;
  const futureFcf = fcfPerShare * Math.pow(1 + growth / 100, years);
  const buyPrice = (futureFcf * exitMult) / Math.pow(1 + ret / 100, years);
  const upside = ((buyPrice - price) / price) * 100;
  const cheap = price <= buyPrice;

  return (
    <div className="card valb">
      <div className="valb-left">
        <div className="row gap-8 valb-kicker-row">
          <Icon name="scale" size={16} style={{ color: 'var(--ink-3)' }} />
          <span className="valb-kicker">Hypothèses</span>
        </div>
        <div className="col gap-18">
          <Slider label="Croissance attendue (FCF/an)" value={growth} set={setGrowth} min={0} max={30} step={1} suffix=" %" />
          <Slider label="Multiple de sortie (P/FCF)" value={exitMult} set={setExitMult} min={8} max={40} step={1} suffix="×" />
          <Slider label="Rendement annuel visé" value={ret} set={setRet} min={6} max={20} step={1} suffix=" %" />
        </div>
      </div>
      <div className="valb-right">
        <span className="valb-kicker">Prix d'achat conseillé</span>
        <div className="num valb-price">{sym}{buyPrice.toFixed(0)}</div>
        <div className="row gap-8 valb-current">
          <span className="tiny muted">Cours actuel</span>
          <span className="num tiny" style={{ fontWeight: 600 }}>{sym}{price.toFixed(2)}</span>
        </div>
        <div className={'valb-badge ' + (cheap ? 'valb-badge-good' : 'valb-badge-bad')}>
          {cheap ? 'Sous le prix conseillé' : 'Au-dessus du prix conseillé'} · {upside >= 0 ? '+' : ''}{upside.toFixed(0)} %
        </div>
        <p className="tiny muted valb-note">Jugé <b style={{ color: 'var(--ink-2)' }}>séparément</b> de la note de qualité. Le prix conseillé est le cours d'entrée pour viser votre rendement.</p>
      </div>
    </div>
  );
}
