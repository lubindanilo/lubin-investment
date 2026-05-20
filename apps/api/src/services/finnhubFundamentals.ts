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
import { fetchSplitEvents, cumulativeSplitFactor } from './yahooSplits.js';

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

  // Décumulation Q1/Q2/Q3 si cumulative
  const points: TimeseriesPoint[] = [];
  const ytdByYear: Record<number, number> = {};
  for (const r of quarterlyRaw) {
    if (!cfg.cumulative) {
      points.push({ date: r.date, value: r.value });
      continue;
    }
    if (r.quarter === 1) {
      points.push({ date: r.date, value: r.value });
      ytdByYear[r.year] = r.value;
    } else {
      const priorYtd = ytdByYear[r.year] ?? 0;
      points.push({ date: r.date, value: r.value - priorYtd });
      ytdByYear[r.year] = r.value;
    }
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

/**
 * Si la métrique est un share count, on ramène toutes les valeurs en current-basis
 * en multipliant chaque point par le facteur cumulatif des splits qui ont eu lieu
 * APRÈS la date du point. Sinon (revenue, debt, etc.), no-op.
 *
 * Les splits sont fournis par Yahoo /v8/finance/chart (universel, gratuit, indépendant
 * de la source de la timeseries elle-même).
 */
async function splitAdjustIfNeeded(
  points: TimeseriesPoint[],
  ticker: string,
  metric: MetricKey,
): Promise<TimeseriesPoint[]> {
  if (metric !== 'shares' || points.length === 0) return points;
  const splits = await fetchSplitEvents(ticker);
  if (splits.length === 0) return points;
  return points.map(p => {
    const asOfTs = Math.floor(new Date(p.date + 'T00:00:00Z').getTime() / 1000);
    return { date: p.date, value: p.value * cumulativeSplitFactor(splits, asOfTs) };
  });
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
