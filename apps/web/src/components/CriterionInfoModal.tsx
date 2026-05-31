/**
 * CriterionInfoModal — explication courte d'un critère (pourquoi c'est important pour
 * investir + comment on le calcule), accessible via l'icône « i » sur chaque carte.
 *
 * Le contenu vient de CRITERION_BRIEFS (data/criterionBriefs.ts). Couvre tous les critères
 * (chiffres, business model, management, valorisation).
 */
import { useEffect } from 'react';
import { CRITERION_BRIEFS } from '../data/criterionBriefs.js';
import './CriterionInfoModal.css';

/** True si une explication existe pour ce critère (l'icône « i » s'affiche alors). */
export function hasInfoGuide(criterionName: string): boolean {
  return criterionName in CRITERION_BRIEFS;
}

interface Props {
  criterionName: string;
  onClose: () => void;
}

export function CriterionInfoModal({ criterionName, onClose }: Props) {
  const brief = CRITERION_BRIEFS[criterionName];

  // Échap ferme la modal (cohérent avec les autres modales du projet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!brief) return null;

  return (
    <div className="info-overlay" onClick={onClose}>
      <div className="info-modal" onClick={e => e.stopPropagation()}>
        <header className="info-header">
          <h2 className="info-title">{criterionName}</h2>
          <button className="info-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="info-body">
          <div className="info-brief">
            <div className="info-brief-label">Pourquoi c'est important</div>
            <p className="info-brief-text">{brief.why}</p>
          </div>
          <div className="info-brief">
            <div className="info-brief-label">Comment on le mesure</div>
            <p className="info-brief-text">{brief.how}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
