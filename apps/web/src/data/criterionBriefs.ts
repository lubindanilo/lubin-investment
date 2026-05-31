/**
 * Explications courtes par critère : pourquoi c'est important pour investir + comment
 * on le calcule/évalue. Affichées via l'icône « i » sur chaque carte critère.
 *
 * Les noms doivent correspondre EXACTEMENT aux libellés produits côté backend
 * (derivedMetrics pour les chiffres, prompts GPT pour business/management).
 */
export interface CriterionBrief {
  why: string;
  how: string;
}

export const CRITERION_BRIEFS: Record<string, CriterionBrief> = {
  // ── Chiffres (10) + valorisation ──────────────────────────────────────────
  'Rentable (marge nette)': {
    why: "Une marge nette positive prouve que l'entreprise gagne réellement de l'argent une fois toutes ses charges payées — la base de tout investissement de qualité.",
    how: "Bénéfice net ÷ chiffre d'affaires (sur 12 mois glissants). Repère : > 5 % = bon, ≤ 0 = en perte.",
  },
  'Croissance du CA 5 ans': {
    why: "Un chiffre d'affaires qui grandit dans la durée est le moteur de la création de valeur — sans croissance, difficile de composer.",
    how: "Tendance (régression) du chiffre d'affaires glissant sur ~5 ans. Repère : > 10 %/an = bon.",
  },
  'Croissance FCF/action 5 ans': {
    why: "Le free cash flow PAR ACTION est ce qui enrichit vraiment l'actionnaire : il tient compte de la dilution (création d'actions). Une boîte peut croître tout en diluant — ici on regarde ce qui te revient.",
    how: "Tendance du FCF ajusté (cash libre moins rémunération en actions) divisé par le nombre d'actions, sur 5 ans. Repère : > 10 %/an = bon.",
  },
  'Marge FCF (ajustée SBC)': {
    why: "Mesure combien de cash réellement libre chaque euro de vente génère, APRÈS avoir compté la rémunération en actions (souvent cachée). C'est le cash qui peut être rendu ou réinvesti.",
    how: "(Flux d'exploitation − rémunération en actions − investissements) ÷ chiffre d'affaires. Repère : > 10 % = bon.",
  },
  'Operating leverage': {
    why: "Des marges qui s'améliorent quand le chiffre d'affaires monte révèlent un avantage d'échelle : la boîte devient plus rentable en grandissant.",
    how: "Pente de la marge opérationnelle (sur 12 mois glissants) au fil de ~5 ans. Croissante = bon.",
  },
  'Cash ROCE': {
    why: "Rentabilité du capital réellement employé — le cœur de la qualité d'un business (approche Buffett/Bettin-Mauboussin). Au-dessus du coût du capital (~8-10 %), la boîte crée de la richesse ; en dessous, elle en détruit.",
    how: "FCF ajusté ÷ (actifs − passifs courants − goodwill − cash excédentaire). Repère : > 15 % = bon, > 25 % = excellent.",
  },
  'Dette nette / FCF': {
    why: "Indique combien d'années de cash libre il faudrait pour rembourser la dette — un bon proxy du risque financier et de la fragilité en cas de retournement.",
    how: "(Dette totale − trésorerie) ÷ FCF. Repère : < 3 = sain, > 5 = tendu.",
  },
  'Cash Conversion Rate': {
    why: "Vérifie que les bénéfices comptables se transforment bien en vrai cash. Un écart durable signale des bénéfices « de papier » (créances, stocks qui gonflent…).",
    how: "Rapport entre bénéfice et cash généré (dérivé du PER et du P/FCF). Repère : > 1 = le cash suit (ou dépasse) le bénéfice.",
  },
  'Current Ratio': {
    why: "Capacité à honorer ses dettes à court terme avec ses actifs court terme — un indicateur simple de solidité du bilan et de risque de liquidité.",
    how: "Actifs courants ÷ passifs courants. Repère : > 1,5 = confortable, < 1 = à surveiller.",
  },
  'P/FCF actuel': {
    why: "Le prix payé pour 1 € de cash libre annuel : la mesure de valorisation la plus parlante. Une excellente entreprise payée trop cher reste un mauvais investissement au mauvais moment.",
    how: "Capitalisation boursière ÷ FCF (12 mois glissants). Repère : < 25× = raisonnable, > 35× = cher.",
  },
  'Valorisation': {
    why: "Donne un prix d'achat indicatif pour viser un rendement cible : le bon « timing d'entrée ». Ce critère n'entre PAS dans la note qualité — une bonne boîte le reste, juste pas encore au bon prix.",
    how: "Actualisation du cash futur (DCF) selon le rendement visé, l'hypothèse de croissance et le multiple de sortie.",
  },

  // ── Business model (10) — évalué par IA + recherche web ─────────────────────
  'Non dépendant des matières premières': {
    why: "Une entreprise exposée aux matières premières subit des prix qu'elle ne contrôle pas : marges volatiles et imprévisibles.",
    how: "Évalué par IA (recherche web) : poids des intrants volatils dans le modèle économique.",
  },
  'Non dépendant des taux d\'intérêts': {
    why: "Une forte sensibilité aux taux rend les résultats erratiques et dépendants de la macro plutôt que du business lui-même.",
    how: "Évalué par IA : exposition aux taux (endettement, secteur financier/immobilier).",
  },
  'Non dépendant du gouvernement': {
    why: "Dépendre de subventions, de commandes publiques ou d'une réglementation favorable est un risque exogène hors du contrôle de la boîte.",
    how: "Évalué par IA : part du chiffre d'affaires liée au public ou fortement régulée.",
  },
  'Marché en croissance': {
    why: "Un marché final qui grandit porte l'entreprise même sans gagner de parts — un vent de dos durable.",
    how: "Évalué par IA : dynamique du marché adressable (TAM) et de la demande.",
  },
  'Asset light': {
    why: "Peu de capital nécessaire pour fonctionner = plus de cash libre et un ROCE élevé. Les meilleurs modèles sont peu gourmands en actifs.",
    how: "Évalué par IA : intensité en investissements (CapEx) et en actifs immobilisés.",
  },
  'Moat': {
    why: "Une barrière à l'entrée (moat) protège les marges et la part de marché dans la durée. Sans moat, la concurrence érode la rentabilité.",
    how: "Évalué par IA : présence d'un avantage parmi 4 types (coûts de transfert, échelle, marque, effet réseau).",
  },
  'Revenus prévisibles': {
    why: "Des revenus récurrents (abonnements, contrats) donnent visibilité et résilience — bien plus robustes que des ventes ponctuelles.",
    how: "Évalué par IA : part de récurrence, contrats long terme, taux de rétention.",
  },
  'Clientèle diversifiée': {
    why: "Dépendre d'un gros client crée un risque de concentration : sa perte peut faire vaciller toute l'entreprise.",
    how: "Évalué par IA : poids du principal client (cible < 15 % du chiffre d'affaires).",
  },
  'Croissance organique': {
    why: "Une croissance interne est plus saine et plus rentable qu'une croissance achetée par acquisitions, souvent destructrice de valeur.",
    how: "Évalué par IA : part de la croissance venant de l'activité vs des fusions-acquisitions.",
  },
  'Gagne des parts de marché': {
    why: "Gagner des parts face aux concurrents est la preuve concrète d'un avantage compétitif réel et actif.",
    how: "Évalué par IA : évolution de la part de marché vs les concurrents.",
  },

  // ── Management (5) — évalué par IA + recherche web ──────────────────────────
  'Allocation capital': {
    why: "Un dirigeant qui alloue bien le capital (rachats au bon prix, M&A créatrices, dividendes mesurés) compose la valeur pour l'actionnaire.",
    how: "Évalué par IA : historique d'allocation du capital et qualité des décisions.",
  },
  'CEO ancienneté': {
    why: "Un dirigeant installé — idéalement fondateur — pense long terme et porte la culture de l'entreprise.",
    how: "Évalué par IA : ancienneté du CEO et statut de fondateur (cible > 5 ans).",
  },
  'CEO transparence': {
    why: "Une communication droite, sans scandale ni embellissement, protège l'actionnaire et signale un management de confiance.",
    how: "Évalué par IA : historique de gouvernance, scandales éventuels, franchise de la communication.",
  },
  'CEO skin in the game': {
    why: "Un dirigeant qui détient une part significative de son patrimoine en actions est aligné avec toi : il gagne et perd avec l'actionnaire.",
    how: "Évalué par IA : part du capital / du patrimoine du CEO investie dans la société.",
  },
  'Rachats opportunistes': {
    why: "Racheter ses propres actions quand elles sont bon marché (et pas au sommet) crée de la valeur. Le timing révèle la discipline du management.",
    how: "Évalué par IA : timing des rachats d'actions par rapport au cycle de valorisation.",
  },
};
