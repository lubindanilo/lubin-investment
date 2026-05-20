/**
 * Types partagés entre apps/web (React) et apps/api (Express).
 * Tout ce qui voyage sur le réseau doit être typé ici.
 */

// ─── Critères ──────────────────────────────────────────────────────────────

export type CriterionStatus = 'pass' | 'fail' | 'warn';

export interface Criterion {
  nom: string;
  valeur: string;
  cible: string;
  statut: CriterionStatus;
  explication: string;
}

export type CriteriaCategory = 'chiffres' | 'business' | 'management' | 'valorisation';

// ─── Fondamentaux dérivés ─────────────────────────────────────────────────

export interface DerivedMetrics {
  netMargin: number | null;
  revenueCagr: number | null;
  fcfPerShareCagr: number | null;
  /**
   * CAGR (sur ~4-5 ans) du nombre d'actions en circulation.
   * Négatif = rachats nets (création de valeur), positif = dilution.
   * Source : Yahoo Finance (raw) en primaire, dérivation Finnhub en fallback.
   */
  shareCagr: number | null;
  /** Origine du chiffre, pour transparence côté UI/logs. */
  shareCagrSource: 'yahoo' | 'finnhub-derived' | null;
  fcfMargin: number | null;
  operatingLeverage: boolean | null;
  cashROCE: number | null;
  netDebtFcf: number | null;
  ccr: number | null;
  nwc: number | null;
  nwcCurrentRatio: number | null;
  pfcfTTM: number | null;
  /** Marché capitalisation (USD millions) */
  marketCap: number | null;
  /** Prix action courant (USD) */
  price: number | null;
  /** Part du SBC sur le FCF — alerte si > 0.15 */
  sbcShareOfFcf: number | null;
}

// ─── Valorisation (Buffett-style) ─────────────────────────────────────────

export interface ValoParams {
  /** Toujours 0.15 (rendement annualisé visé verrouillé) */
  targetReturn: number;
  /** Croissance FCF/action projetée 5 ans (en décimal) */
  fcfGrowth: number;
  /** Multiple P/FCF cible dans 5 ans */
  targetMultiple: number;
}

export interface ValuationResult extends Criterion {
  fcfPsNow: number | null;
  currentPfcf: number | null;
  fcfPs5Y: number | null;
  exitValue: number | null;
  buyPrice: number | null;
  currentPrice: number | null;
  discountPct: number | null;
}

// ─── News ─────────────────────────────────────────────────────────────────

export type NewsType = 'rachat' | 'dividende' | 'résultats' | 'M&A' | 'mgmt';

export interface NewsItem {
  titre: string;
  date: string;
  type: NewsType;
  resume: string;
  url: string;
  source: string;
}

// ─── Réponse complète de /api/analyze ──────────────────────────────────────

export interface AnalyzeResponse {
  ticker: string;
  company: string;
  /** Prix actuel (USD) */
  price: number | null;
  metrics: DerivedMetrics;
  criteres: Criterion[];
  /** Score brut (pass + 0.5 × warn) */
  score: number;
  scoreMax: number;
  /** True si score/scoreMax >= 0.7 */
  achat: boolean;
  /** 1-2 phrases percutantes (GPT) */
  verdict_direct: string;
  /** Vraies news Finnhub des 60 derniers jours */
  news: NewsItem[];
  /** Valorisation DCF avec params en input */
  valuation: ValuationResult;
  valoParams: ValoParams;
  /** Timestamp ISO de la dernière mise à jour qualitative (cache) */
  qualUpdatedAt: string | null;
  /** Si défini : message expliquant pourquoi l'analyse qualitative n'a pas pu se faire (quota, timeout…) */
  qualError?: string | null;
  /** Date du prochain + dernier earnings (Finnhub /calendar/earnings) */
  earnings: EarningsInfo;
}

// ─── Watchlist ─────────────────────────────────────────────────────────────

export interface WatchlistEntry {
  ticker: string;
  name: string;
  price: number | null;
  pfcfTTM: number | null;
  scoreChiffres: number;
  scoreChiffresMax: number;
}

// ─── Earnings (calendrier + résultats) ─────────────────────────────────────

export interface EarningsResult {
  /** YYYY-MM-DD */
  date: string;
  quarter: number;
  year: number;
  /** "bmo" (before market open), "amc" (after market close), null si inconnu */
  hour: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  /** epsActual - epsEstimate */
  epsSurprise: number | null;
  /** epsSurprise / |epsEstimate|, en décimal (0.115 = +11.5%) */
  epsSurprisePct: number | null;
  /** En USD millions */
  revenueActual: number | null;
  revenueEstimate: number | null;
  /** revenueSurprise / |revenueEstimate|, en décimal */
  revenueSurprisePct: number | null;
}

export interface EarningsInfo {
  /** Le prochain earnings (dans le futur). Null si pas connu. */
  next: EarningsResult | null;
  /** Le dernier earnings (dans le passé). Null si pas connu. */
  last: EarningsResult | null;
}

// ─── Séries temporelles trimestrielles (histogrammes UI) ───────────────────

export interface TimeseriesPoint {
  date: string;       // YYYY-MM-DD
  value: number;
}

export interface TimeseriesResponse {
  ticker: string;
  metric: string;
  freq: 'quarterly' | 'annual';
  years: number;
  points: TimeseriesPoint[];
}

/** Période disponible dans le sélecteur UI */
export type TimeseriesPeriod = '1Y' | '5Y' | '10Y' | '20Y' | 'All';

export const PERIOD_YEARS: Record<TimeseriesPeriod, number> = {
  '1Y': 1, '5Y': 5, '10Y': 10, '20Y': 20, 'All': 50,
};

/**
 * Mapping nom de critère → métrique Finnhub financials-reported + libellé + format.
 * Seuls les critères listés ici sont cliquables (histogrammable).
 *
 * `metricKey` correspond à une clé du mapping METRICS dans `finnhubFundamentals.ts` côté API.
 */
export type TimeseriesMetricKey = 'revenue' | 'netIncome' | 'operatingIncome' | 'fcf' | 'cfo' | 'shares' | 'totalDebt';

export interface CriterionHistogram {
  metricKey: TimeseriesMetricKey;
  label: string;
  /** Format : 'currency' (montant $), 'count' (nb actions), 'percent' (×100 + %) */
  unit: 'currency' | 'count' | 'percent';
}

export const CRITERION_HISTOGRAMS: Record<string, CriterionHistogram> = {
  'Rentable (marge nette)':            { metricKey: 'netIncome',       label: 'Résultat net trimestriel',         unit: 'currency' },
  'Croissance du CA 5 ans':            { metricKey: 'revenue',         label: 'CA trimestriel',                   unit: 'currency' },
  'Croissance FCF/action 5 ans':       { metricKey: 'fcf',             label: 'Free cash flow trimestriel',       unit: 'currency' },
  "Évolution nombre d'actions 5 ans":  { metricKey: 'shares',          label: 'Actions diluées (moyenne)',        unit: 'count'    },
  'Marge FCF (ajustée SBC)':           { metricKey: 'fcf',             label: 'Free cash flow trimestriel',       unit: 'currency' },
  'Operating leverage':                { metricKey: 'operatingIncome', label: 'Résultat opérationnel trimestriel', unit: 'currency' },
  'Dette nette / FCF':                 { metricKey: 'totalDebt',       label: 'Dette long terme',                 unit: 'currency' },
  'Cash Conversion Rate':              { metricKey: 'fcf',             label: 'Free cash flow trimestriel',       unit: 'currency' },
};

// ─── Auth (user public — pas de password ni hash) ──────────────────────────

export interface PublicUser {
  id: string;
  email: string;
  /** ISO 8601 */
  createdAt: string;
}

// ─── Erreurs API normalisées ───────────────────────────────────────────────

export interface ApiError {
  error: string;
  details?: string;
}
