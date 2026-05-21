/**
 * Service Finnhub `/stock/financials-reported` — extrait les états financiers
 * directement depuis les 10-K / 10-Q SEC. Beaucoup plus profond que Yahoo
 * (16+ années annuelles, 29+ trimestres pour la plupart des US tickers).
 *
 * ⚠ Particularité des 10-Q : les chiffres income statement et cash flow sont
 *   CUMULATIFS YTD (Q3 contient Q1+Q2+Q3). On décumule pour avoir des vrais
 *   trimestres individuels. Les balance sheet items (BS) sont des snapshots
 *   à date, pas cumulatifs.
 */
import { finnhubLimiter } from '../lib/limiter.js';
import { fetchWithRetry } from '../lib/retry.js';
import type { TimeseriesPoint } from '@lubin/shared';
import { fetchSplitEvents, splitAdjustWithDiscontinuity } from './yahooSplits.js';

const BASE = 'https://finnhub.io/api/v1';
const TOKEN = process.env.FINNHUB_API_KEY ?? '';

type Section = 'bs' | 'cf' | 'ic';
type Frequency = 'annual' | 'quarterly';

interface FinnhubReportItem {
  concept: string;
  label?: string;
  unit?: string;
  value: number;
}
interface FinnhubFiling {
  year: number;
  quarter: number;
  startDate: string;
  endDate: string;
  form: '10-K' | '10-Q' | string;
  report: { bs?: FinnhubReportItem[]; cf?: FinnhubReportItem[]; ic?: FinnhubReportItem[] };
}
interface FinnhubReportedResponse {
  data?: FinnhubFiling[];
  error?: string;
}

/**
 * Mapping des métriques (clés haut-niveau utilisées dans l'UI) vers les concepts XBRL US-GAAP.
 * Plusieurs concepts candidats par métrique car les boîtes utilisent des tags différents.
 */
export interface MetricConfig {
  /** Section du rapport (bilan, cash flow, income statement) */
  section: Section;
  /** Concepts XBRL candidats, testés dans l'ordre */
  concepts: string[];
  /**
   * True si la valeur est cumulative YTD dans les 10-Q (résultat net, CA, etc.).
   * False si snapshot à date (cash, dette, actions outstanding).
   */
  cumulative: boolean;
}

export const METRICS: Record<string, MetricConfig> = {
  revenue: {
    section: 'ic',
    concepts: [
      'us-gaap_Revenues',
      'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax',
      'us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax',
      'us-gaap_SalesRevenueNet',
      'us-gaap_SalesRevenueGoodsNet',
    ],
    cumulative: true,
  },
  netIncome: {
    section: 'ic',
    concepts: [
      'us-gaap_NetIncomeLoss',
      'us-gaap_ProfitLoss',
    ],
    cumulative: true,
  },
  operatingIncome: {
    section: 'ic',
    concepts: ['us-gaap_OperatingIncomeLoss'],
    cumulative: true,
  },
  fcf: {
    // FCF = CashFlowFromOperations − CapEx — calculé en aval
    section: 'cf',
    concepts: ['__computed_fcf__'],
    cumulative: true,
  },
  cfo: {
    section: 'cf',
    concepts: [
      'us-gaap_NetCashProvidedByUsedInOperatingActivities',
      'us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    cumulative: true,
  },
  capex: {
    section: 'cf',
    concepts: [
      'us-gaap_PaymentsToAcquirePropertyPlantAndEquipment',
      'us-gaap_PaymentsToAcquireProductiveAssets',
    ],
    cumulative: true,
  },
  shares: {
    section: 'ic',
    concepts: [
      'us-gaap_WeightedAverageNumberOfDilutedSharesOutstanding',
      'us-gaap_WeightedAverageNumberOfSharesOutstandingBasic',
    ],
    cumulative: false, // moyenne pondérée → pas cumulative
  },
  totalDebt: {
    section: 'bs',
    concepts: [
      'us-gaap_LongTermDebt',
      'us-gaap_LongTermDebtNoncurrent',
      'us-gaap_DebtCurrent',
    ],
    cumulative: false,
  },
};

export type MetricKey = keyof typeof METRICS;

async function fetchReported(ticker: string, freq: Frequency): Promise<FinnhubFiling[]> {
  return finnhubLimiter.schedule(async () => {
    const url = `${BASE}/stock/financials-reported?symbol=${ticker}&freq=${freq}&token=${TOKEN}`;
    const r = await fetchWithRetry(url, undefined, { label: `finnhub reported ${freq}`, attempts: 3 });
    const j = await r.json() as FinnhubReportedResponse;
    if (j.error) throw new Error(`Finnhub reported: ${j.error}`);
    return j.data ?? [];
  });
}

function extractValue(filing: FinnhubFiling, cfg: MetricConfig): number | null {
  if (cfg.concepts.includes('__computed_fcf__')) {
    const cfo = extractFirst(filing, 'cf', METRICS.cfo!.concepts);
    const capex = extractFirst(filing, 'cf', METRICS.capex!.concepts);
    if (cfo == null) return null;
    // CapEx est habituellement signé négatif dans les filings (paiements). FCF = CFO + CapEx.
    return cfo + (capex ?? 0);
  }
  return extractFirst(filing, cfg.section, cfg.concepts);
}

function extractFirst(filing: FinnhubFiling, section: Section, concepts: string[]): number | null {
  const items = filing.report?.[section];
  if (!items) return null;
  for (const concept of concepts) {
    const found = items.find(i => i.concept === concept);
    if (found && typeof found.value === 'number' && Number.isFinite(found.value)) return found.value;
  }
  return null;
}

/**
 * Récupère une série temporelle (quarterly ou annual) depuis Finnhub financials-reported.
 *
 * Pour le quarterly + métrique cumulative (revenue, NI, FCF, etc.) :
 *   1. Décumule les Q1/Q2/Q3 YTD pour avoir des valeurs trimestrielles individuelles.
 *   2. Récupère AUSSI les filings annuels (10-K) et calcule Q4 = annuel − Q3 cumulé YTD.
 *      Sans cette étape, on aurait Q1/Q2/Q3 seulement (les 10-Q ne couvrent pas Q4).
 *
 * Pour le quarterly + métrique non-cumulative (shares, dette à instant T) :
 *   Renvoie les valeurs Q1/Q2/Q3 telles quelles. Pas de Q4 dérivé (l'annuel
 *   serait juste une moyenne pondérée FY qui n'est pas comparable à Q4 seul).
 *
 * Pour l'annual : valeurs telles que dans les 10-K.
 */
export async function getReportedTimeseries(
  ticker: string,
  metric: MetricKey,
  freq: Frequency,
  years: number,
): Promise<TimeseriesPoint[]> {
  const cfg = METRICS[metric];
  if (!cfg) return [];
  const cap = Math.max(1, Math.min(years, 50));

  // Pour quarterly + cumulative : fetch en parallèle les deux fréquences pour dériver Q4
  const needAnnualForQ4 = freq === 'quarterly' && cfg.cumulative;
  const [quarterlyFilings, annualFilings] = await Promise.all([
    freq === 'quarterly' ? fetchReported(ticker, 'quarterly') : Promise.resolve([]),
    freq === 'annual' || needAnnualForQ4 ? fetchReported(ticker, 'annual') : Promise.resolve([]),
  ]);

  // Cas simple : annual
  if (freq === 'annual') {
    const points = extractAndPack(annualFilings, cfg);
    return splitAdjustIfNeeded(filterWindow(points, cap), ticker, metric);
  }

  // Cas quarterly
  type Raw = { date: string; value: number; year: number; quarter: number };
  const quarterlyRaw: Raw[] = quarterlyFilings
    .map(f => {
      const value = extractValue(f, cfg);
      if (value == null) return null;
      return { date: f.endDate.slice(0, 10), value, year: f.year, quarter: f.quarter };
    })
    .filter((x): x is Raw => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Décumulation Q1/Q2/Q3 si cumulative.
  //
  // Cas piégeux : si Q1 manque pour une année (ex : changement de ticker FISV→FI en plein
  // milieu de 2023, Finnhub ne renvoie alors que Q2/Q3 sous l'ancien symbol), on ne peut PAS
  // décumuler — la valeur "Q2" est en réalité la valeur YTD = Q1+Q2 actuelle. Si on remontait
  // cette valeur comme si c'était Q2 seul, on aurait des chiffres 2-3× trop hauts (bug constaté
  // sur FISV : Q2 2021 reporté à $7.8B au lieu de $4.0B réel, Q3 2025 à $15.9B au lieu de ~$5B).
  // → On SKIP le point quand on ne peut pas décumuler proprement.
  const points: TimeseriesPoint[] = [];
  const ytdByYear: Record<number, number> = {};
  // Trace la quarter le plus récent vu pour chaque année (pour valider qu'on a la chaîne complète)
  const lastQuarterByYear: Record<number, number> = {};
  let skippedQ: { date: string; quarter: number }[] = [];
  for (const r of quarterlyRaw) {
    if (!cfg.cumulative) {
      points.push({ date: r.date, value: r.value });
      continue;
    }
    if (r.quarter === 1) {
      points.push({ date: r.date, value: r.value });
      ytdByYear[r.year] = r.value;
      lastQuarterByYear[r.year] = 1;
    } else {
      // Pour décumuler Q_n on a besoin du Q_(n-1) YTD de la MÊME année.
      // Si lastQuarterByYear[r.year] !== r.quarter - 1, il manque un quarter intermédiaire
      // (Q1 absent, ou Q1+Q2 absents, etc.) → on ne peut pas décumuler.
      const expectedPrior = r.quarter - 1;
      if (lastQuarterByYear[r.year] !== expectedPrior) {
        skippedQ.push({ date: r.date, quarter: r.quarter });
        continue;
      }
      const priorYtd = ytdByYear[r.year]!;
      points.push({ date: r.date, value: r.value - priorYtd });
      ytdByYear[r.year] = r.value;
      lastQuarterByYear[r.year] = r.quarter;
    }
  }
  if (skippedQ.length > 0) {
    console.warn(`[finnhub fundamentals ${ticker}/${metric}] ${skippedQ.length} Q skipped (impossible à décumuler, Q1 ou intermédiaire manquant) :`, skippedQ.slice(0, 5));
  }

  // Dérivation Q4 : annuel − Q3 YTD (cumulative only)
  if (needAnnualForQ4) {
    let q4Count = 0;
    for (const a of annualFilings) {
      const annualValue = extractValue(a, cfg);
      if (annualValue == null) continue;
      const q3Ytd = ytdByYear[a.year];
      if (q3Ytd == null) continue; // pas de Q3 connu pour cette année → skip
      const q4Date = a.endDate.slice(0, 10);
      // On vérifie qu'on n'a pas déjà ce point (cas rare où un 10-K aurait été parsé comme quarterly)
      if (points.some(p => p.date === q4Date)) continue;
      points.push({ date: q4Date, value: annualValue - q3Ytd });
      q4Count++;
    }
    console.log(`[finnhub fundamentals] ${ticker}/${metric}: ${q4Count} Q4 dérivés du 10-K`);
  }

  points.sort((a, b) => a.date.localeCompare(b.date));
  return splitAdjustIfNeeded(filterWindow(points, cap), ticker, metric);
}

// ═══════════════════════════════════════════════════════════════════════════
// Croissance annualisée par régression log-linéaire (robuste aux outliers)
// ═══════════════════════════════════════════════════════════════════════════
//
// Principe général :
//   1. Fetch les quarterlies
//   2. Calcule un TTM rolling (somme 4Q pour flow, moyenne 4Q pour stock, ratio pour marges)
//   3. Garde les TTM positifs sur la fenêtre (5Y par défaut)
//   4. Régression linéaire de log(TTM) vs temps → slope = taux annualisé en log
//   5. Renvoie exp(slope) - 1 = croissance annualisée
//
// Avantages :
//   - Utilise TOUS les points (20+ TTM) pour estimer la pente, pas seulement les bornes
//   - Robuste face à un quarter ou une année aberrante
//   - Le TTM lisse la saisonnalité intra-année
//
// Helpers privés réutilisés par les 4 calculs :
//   - rollingTtmSum     pour les flows (revenue, fcf, op income)
//   - rollingTtmMean    pour les stocks (shares — point-in-time, moyenné sur 4Q = avg annuel)
//   - regressLogGrowth  régression sur les points TTM

interface TtmPoint { date: string; ts: number; value: number }

function rollingTtmSum(points: TimeseriesPoint[]): TtmPoint[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const out: TtmPoint[] = [];
  for (let i = 3; i < sorted.length; i++) {
    const sum = sorted[i]!.value + sorted[i-1]!.value + sorted[i-2]!.value + sorted[i-3]!.value;
    out.push({ date: sorted[i]!.date, ts: tsOf(sorted[i]!.date), value: sum });
  }
  return out;
}

function rollingTtmMean(points: TimeseriesPoint[]): TtmPoint[] {
  return rollingTtmSum(points).map(p => ({ ...p, value: p.value / 4 }));
}

function tsOf(date: string): number {
  return new Date(date + 'T00:00:00Z').getTime();
}

/**
 * Régression linéaire de log(value) sur t (années depuis t0).
 * Renvoie { rate, n, first, last } pour traçabilité. null si non régressable.
 */
function regressLogGrowth(points: TtmPoint[]): { rate: number; n: number; first: TtmPoint; last: TtmPoint } | null {
  const valid = points.filter(p => p.value > 0);
  if (valid.length < 4) return null;
  const t0 = valid[0]!.ts;
  const xs = valid.map(p => (p.ts - t0) / (365.25 * 24 * 3600 * 1000));
  const ys = valid.map(p => Math.log(p.value));
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  if (den === 0) return null;
  return { rate: Math.exp(num / den) - 1, n, first: valid[0]!, last: valid[valid.length - 1]! };
}

/** Filtre une série de TTM points sur les `windowYears` dernières années (par ts). */
function windowed(points: TtmPoint[], windowYears: number): TtmPoint[] {
  const cutoff = Date.now() - windowYears * 365.25 * 24 * 3600 * 1000;
  return points.filter(p => p.ts >= cutoff);
}

// ─── Croissance revenue 5 ans (TTM revenue + régression) ───────────────────

export async function computeRevenueGrowthFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  const revQ = await getReportedTimeseries(ticker, 'revenue', 'quarterly', windowYears + 1);
  if (revQ.length < 8) return { value: null, reason: `Moins de 8 trimestres revenue (${revQ.length})` };

  const ttm = windowed(rollingTtmSum(revQ), windowYears);
  if (ttm.length < 4) return { value: null, reason: 'Trop peu de TTM dans la fenêtre' };

  const r = regressLogGrowth(ttm);
  if (!r) return { value: null, reason: 'Régression non calculable (TTM ≤ 0 ?)' };
  console.log(`[revGrowthRegress ${ticker}] ${r.n} TTM | ${r.first.date}(${(r.first.value/1e9).toFixed(1)}B) → ${r.last.date}(${(r.last.value/1e9).toFixed(1)}B) → ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

// ─── Évolution actions 5 ans (régression directe sur shares quarterly) ─────

export async function computeSharesGrowthFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  // shares est non-cumulative (point-in-time). Pas besoin de TTM, on régresse direct.
  // splitAdjustWithDiscontinuity dans getReportedTimeseries(metric='shares') gère déjà
  // les splits, on a donc des shares en current-basis comparables d'un Q à l'autre.
  const sharesQ = await getReportedTimeseries(ticker, 'shares', 'quarterly', windowYears + 1);
  if (sharesQ.length < 8) return { value: null, reason: `Moins de 8 trimestres shares (${sharesQ.length})` };

  // Convert TimeseriesPoint → TtmPoint format (juste pour réutiliser regressLogGrowth)
  const points: TtmPoint[] = sharesQ
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(p => ({ date: p.date, ts: tsOf(p.date), value: p.value }));

  const win = windowed(points, windowYears);
  if (win.length < 4) return { value: null, reason: 'Trop peu de shares dans la fenêtre' };

  const r = regressLogGrowth(win);
  if (!r) return { value: null, reason: 'Régression non calculable' };
  console.log(`[sharesGrowthRegress ${ticker}] ${r.n} pts | ${r.first.date}(${(r.first.value/1e6).toFixed(0)}M) → ${r.last.date}(${(r.last.value/1e6).toFixed(0)}M) → ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

// ─── Operating leverage (tendance TTM op margin) ───────────────────────────

export async function computeOperatingMarginTrendFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  // Op margin TTM = TTM(opIncome) / TTM(revenue). On régresse log(margin) sur le temps,
  // slope > 0 → marges en expansion (operating leverage positif).
  const [opQ, revQ] = await Promise.all([
    getReportedTimeseries(ticker, 'operatingIncome', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'revenue', 'quarterly', windowYears + 1),
  ]);
  if (opQ.length < 8 || revQ.length < 8) {
    return { value: null, reason: `Moins de 8 trimestres pour op income (${opQ.length}) ou revenue (${revQ.length})` };
  }

  const opTtm = rollingTtmSum(opQ);
  const revTtm = rollingTtmSum(revQ);
  const revByDate = new Map(revTtm.map(p => [p.date, p.value]));

  // Marge à chaque quarter où on a les 2 TTM
  const marginTtm: TtmPoint[] = [];
  for (const op of opTtm) {
    const rev = revByDate.get(op.date);
    if (rev == null || rev <= 0) continue;
    marginTtm.push({ date: op.date, ts: op.ts, value: op.value / rev });
  }

  const win = windowed(marginTtm, windowYears);
  if (win.length < 4) return { value: null, reason: 'Trop peu de marges TTM dans la fenêtre' };

  const r = regressLogGrowth(win);
  if (!r) return { value: null, reason: 'Régression non calculable (marge ≤ 0 ?)' };
  console.log(`[opLeverageRegress ${ticker}] ${r.n} TTM | ${r.first.date}(${(r.first.value*100).toFixed(1)}%) → ${r.last.date}(${(r.last.value*100).toFixed(1)}%) → margin trend ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

/**
 * Calcule un taux de croissance annualisé du FCF/action sur ~5 ans par
 * régression log-linéaire des TTM trimestriels.
 *
 * Pourquoi pas une CAGR endpoint-based (Y-5 vs Y0) :
 *   - Sensible aux outliers : si Y-5 OU Y0 est une année atypique (one-shot,
 *     spike conjoncturel, etc.), la CAGR mesure surtout le bruit, pas le trend.
 *   - Cas AMZN : Y-5 (2021) = $107B mais 2022 a fait $110B (à peine plus), puis
 *     2023 jump à $137B, 2024 inconnu, 2025 spike à $271B (probablement
 *     anomalie comptable Finnhub) → la CAGR endpoint 2021→2025 dit +26%/an,
 *     mais ça ne reflète pas vraiment la trajectoire.
 *
 * Approche régression :
 *   1. Fetch 6 ans de quarterlies Finnhub (FCF + shares).
 *   2. Pour chaque trimestre où on a 4 quarters précédents : calcule
 *      TTM_FCF (sum 4 derniers Q) / TTM_shares (moyenne 4 derniers Q).
 *   3. Filtre les TTM positifs (log impossible sinon).
 *   4. Garde les 20 derniers TTM (~5 ans).
 *   5. Régression linéaire de log(TTM_fcfPs) sur l'axe temporel (années).
 *   6. Le coefficient = taux de croissance log → exp(slope) - 1 = croissance annualisée.
 *
 * Avantages :
 *   - Utilise TOUS les points pour estimer la pente, pas seulement les bornes.
 *   - Le TTM lisse déjà la saisonnalité intra-année.
 *   - Robuste face à un quarter aberrant.
 */
export async function computeFcfPerShareCagrFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  const [fcfQ, sharesQ] = await Promise.all([
    getReportedTimeseries(ticker, 'fcf', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'shares', 'quarterly', windowYears + 1),
  ]);
  if (fcfQ.length < 8 || sharesQ.length < 8) {
    return { value: null, reason: 'Moins de 8 trimestres disponibles' };
  }

  // TTM FCF = sum 4Q. TTM shares = mean 4Q. Pour le matching shares vs Q4 dérivés
  // de FCF (dates year-12-31 qui n'existent pas dans shares non-cumulative), on
  // utilise un lookup at-or-before.
  const fcfTtm = rollingTtmSum(fcfQ);
  const sharesSorted = [...sharesQ].sort((a, b) => a.date.localeCompare(b.date));
  const sharesAtOrBefore = (date: string): number | null => {
    let c: number | null = null;
    for (const p of sharesSorted) { if (p.date <= date) c = p.value; else break; }
    return c;
  };

  const fcfPsTtm: TtmPoint[] = [];
  for (const f of fcfTtm) {
    const sh = sharesAtOrBefore(f.date);
    if (sh == null || sh <= 0 || f.value <= 0) continue;
    fcfPsTtm.push({ date: f.date, ts: f.ts, value: f.value / sh });
  }
  const win = windowed(fcfPsTtm, windowYears);
  if (win.length < 4) return { value: null, reason: `Trop peu de TTM positifs dans la fenêtre (${win.length})` };

  const r = regressLogGrowth(win);
  if (!r) return { value: null, reason: 'Régression non calculable' };
  console.log(`[fcfPsRegress ${ticker}] ${r.n} TTM | ${r.first.date}(${r.first.value.toFixed(2)}) → ${r.last.date}(${r.last.value.toFixed(2)}) → ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

/**
 * Si la métrique est un share count, on ramène toutes les valeurs en current-basis.
 *
 * Pour Finnhub on utilise un algorithme "discontinuity-based" (≠ Yahoo date-based) :
 * Finnhub fait du restatement automatique des filings publiées POST-split — la 10-Q
 * Q1 publiée juste après un split contient déjà les chiffres post-split, même si le
 * quarter end est avant. Un adjustment date-based double-counterait le facteur.
 *
 * splitAdjustWithDiscontinuity détecte le saut ≈ factor dans la série et n'ajuste que
 * les points avant ce saut. Voir yahooSplits.ts pour le détail de l'algorithme.
 */
async function splitAdjustIfNeeded(
  points: TimeseriesPoint[],
  ticker: string,
  metric: MetricKey,
): Promise<TimeseriesPoint[]> {
  if (metric !== 'shares' || points.length === 0) return points;
  const splits = await fetchSplitEvents(ticker);
  if (splits.length === 0) return points;
  return splitAdjustWithDiscontinuity(points, splits);
}

function extractAndPack(filings: FinnhubFiling[], cfg: MetricConfig): TimeseriesPoint[] {
  return filings
    .map(f => {
      const value = extractValue(f, cfg);
      if (value == null) return null;
      return { date: f.endDate.slice(0, 10), value };
    })
    .filter((x): x is TimeseriesPoint => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function filterWindow(points: TimeseriesPoint[], years: number): TimeseriesPoint[] {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return points.filter(p => p.date >= cutoffIso);
}
