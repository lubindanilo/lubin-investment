/**
 * CriterionInfoModal — modale d'interprétation verbale pour un critère.
 *
 * Affiche un guide pédagogique attaché à un critère (échelle d'interprétation,
 * exemples concrets, pièges classiques) — accessible via l'icône ⓘ sur la carte.
 *
 * Architecture : `CRITERION_INFO_GUIDES` est un registry mapping nom du critère →
 * contenu JSX. Ajouter une entrée ici suffit à activer l'icône info sur la carte.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import './CriterionInfoModal.css';

interface RoceRow {
  range: string;
  verdict: string;
  examples: string;
  tone: 'fail' | 'warn' | 'pass-light' | 'pass' | 'pass-strong' | 'pass-elite' | 'pass-extreme';
}

const CASH_ROCE_TABLE: RoceRow[] = [
  {
    range: '< 5 %',
    verdict: 'Destruction de valeur — sous le coût du capital (WACC ~8-10 %). La boîte serait plus rentable en plaçant son capital en obligations.',
    examples: 'Constructeurs auto en crise, sidérurgie déclinante, retail en perte de vitesse',
    tone: 'fail',
  },
  {
    range: '5-10 %',
    verdict: 'Médiocre — la boîte produit du cash mais à peine plus que le risque pris. Pas de création de richesse pour l\'actionnaire long terme.',
    examples: 'Compagnies aériennes, télécoms matures, banques régionales',
    tone: 'warn',
  },
  {
    range: '10-15 %',
    verdict: 'Honnête — couvre le WACC. Pas exceptionnel, mais pas destructeur.',
    examples: 'Industriels classiques, utilities, grande consommation banale',
    tone: 'pass-light',
  },
  {
    range: '15-25 %',
    verdict: 'Bon — seuil Buffett/Bettin. Création de valeur réelle si maintenable. À 20 % et 100 % de réinvestissement, le capital double tous les 4 ans.',
    examples: 'Coca-Cola, Procter & Gamble, Nestlé, LVMH',
    tone: 'pass',
  },
  {
    range: '25-50 %',
    verdict: 'Excellent — franchise solide avec barrières à l\'entrée. Le marché va probablement payer cher.',
    examples: 'Apple, Microsoft, Visa, Mastercard, Hermès',
    tone: 'pass-strong',
  },
  {
    range: '> 50 %',
    verdict: 'Exceptionnel — modèle asset-light dominant (peu de capital nécessaire pour générer du cash).',
    examples: 'ASML, S&P Global, Moody\'s, Adobe',
    tone: 'pass-elite',
  },
  {
    range: '> 100 %',
    verdict: 'Quasi sans capital — le ratio devient presque une non-information. La boîte produit plus de cash en un an qu\'il n\'a fallu de capital pour la lancer.',
    examples: 'BKNG, MEDP (modèles plateforme/services purs)',
    tone: 'pass-extreme',
  },
];

const CashRoceGuide = (): ReactNode => (
  <>
    <p className="info-lead">
      Pour chaque <strong>1 €</strong> de capital opérationnel immobilisé (= ce qu'il a fallu mettre dans la boîte pour qu'elle tourne, hors trésorerie excédentaire), elle génère <strong>X €</strong> de cash libre par an.
    </p>
    <p className="info-para">
      Concrètement, <strong>Cash ROCE = 25 %</strong> signifie : "à chaque dollar investi dans les opérations, la boîte ressort 25 cents de cash net par an, après avoir payé la SBC."
    </p>

    <h3 className="info-section-title">Formule (Bettin / Mauboussin / Damodaran)</h3>
    <div className="info-formula">
      <code>
        Cash ROCE = FCF ajusté SBC ÷ (Total Assets − Current Liabilities − Goodwill − Cash excédentaire)
      </code>
      <div className="info-formula-sub">
        avec <strong>Cash excédentaire</strong> = max(0, cash total − 2 % × revenue TTM)
      </div>
    </div>
    <ul className="info-list info-list-formula">
      <li><strong>FCF ajusté SBC</strong> = CFO − |CapEx| − Stock-Based Compensation. On soustrait la SBC car c'est une dilution réelle des actionnaires, même si elle ne sort pas en cash.</li>
      <li><strong>Current Liabilities</strong> exclues du dénominateur : ce sont les dettes opérationnelles non-rémunérées (fournisseurs, deferred revenue, accruals). Du financement gratuit, pas du capital qu'il faut faire fructifier.</li>
      <li><strong>Goodwill</strong> exclu : les primes payées sur acquisitions traînent au bilan mais ne sont pas du capital productif. Permet de mesurer le retour sur le capital <em>organique</em>, sans favoriser les boîtes acquisitives.</li>
      <li><strong>Cash excédentaire</strong> exclu : la trésorerie au-delà de 2 % du CA (règle Damodaran) dort en T-Bills, ce n'est pas du capital investi dans les ops.</li>
    </ul>

    <h3 className="info-section-title">Fallback "ultra-cash-rich"</h3>
    <p className="info-para">
      Pour certaines boîtes asset-light (BKNG, MEDP…), le cash excédentaire dépasse le capital opérationnel net. La soustraction rendrait le dénominateur négatif et le ratio mathématiquement absurde. Dans ce cas, on retombe automatiquement sur la formule classique <strong>sans soustraction d'excess cash</strong> :
    </p>
    <div className="info-formula">
      <code>
        Cash ROCE (fallback) = FCF ajusté SBC ÷ (Total Assets − Current Liabilities − Goodwill)
      </code>
    </div>
    <p className="info-para">
      C'est la formule Bettin / Mauboussin classique. La carte critère mentionne explicitement quand le fallback est utilisé — pas de fallback caché.
    </p>

    <h3 className="info-section-title">Échelle d'interprétation pratique</h3>
    <table className="info-table">
      <thead>
        <tr>
          <th>Cash ROCE</th>
          <th>Verdict</th>
          <th>Exemples typiques</th>
        </tr>
      </thead>
      <tbody>
        {CASH_ROCE_TABLE.map(row => (
          <tr key={row.range} className={`info-row-${row.tone}`}>
            <td className="info-range">{row.range}</td>
            <td className="info-verdict">{row.verdict}</td>
            <td className="info-examples">{row.examples}</td>
          </tr>
        ))}
      </tbody>
    </table>

    <h3 className="info-section-title">Ce que le ROCE ne te dit PAS</h3>
    <ul className="info-list">
      <li><strong>Si le business est cher.</strong> Une boîte à 50 % ROCE peut être surévaluée à 80× FCF. Toujours croiser avec le P/FCF.</li>
      <li><strong>Si le ROCE est durable.</strong> Le ROCE actuel reflète le passé. Une moat qui s'effrite → ROCE qui se compresse demain. Regarder la trajectoire dans le graphique.</li>
      <li><strong>Combien la boîte peut réinvestir à ce ROCE.</strong> Une boîte de niche peut saturer son marché et ne redéployer que 30 % de son FCF. Le reste retourne aux actionnaires (bon mais pas du compounding pur).</li>
      <li><strong>Le risque financier.</strong> Croiser avec Dette nette / FCF.</li>
    </ul>
  </>
);

export const CRITERION_INFO_GUIDES: Record<string, () => ReactNode> = {
  'Cash ROCE': CashRoceGuide,
};

export function hasInfoGuide(criterionName: string): boolean {
  return criterionName in CRITERION_INFO_GUIDES;
}

interface Props {
  criterionName: string;
  onClose: () => void;
}

export function CriterionInfoModal({ criterionName, onClose }: Props) {
  const Guide = CRITERION_INFO_GUIDES[criterionName];

  // Échap ferme la modal (cohérent avec les autres modales du projet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!Guide) return null;

  return (
    <div className="info-overlay" onClick={onClose}>
      <div className="info-modal" onClick={e => e.stopPropagation()}>
        <header className="info-header">
          <div>
            <div className="info-tag">Guide</div>
            <h2 className="info-title">{criterionName} — comment lire la valeur</h2>
          </div>
          <button className="info-close" onClick={onClose} aria-label="Fermer">×</button>
        </header>
        <div className="info-body">
          <Guide />
        </div>
      </div>
    </div>
  );
}
