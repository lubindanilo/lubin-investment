/**
 * P/FCF historique — calcule la trajectoire du multiple Price / Free Cash Flow
 * d'un ticker dans le temps, pour permettre de voir si l'action est expensive
 * vs son propre historique (mean reversion + signal de timing).
 *
 * Formule :
 *   P/FCF(t) = price(t) × shares(t) / TTM_FCF(t)
 *           = market_cap(t) / TTM_FCF(t)
 *
 * Sources :
 *   - price(t)    : Yahoo /v8/finance/chart (split-adjusté automatiquement par Yahoo)
 *   - shares(t)   : Finnhub /financials-reported quarterly (split-adjusté via yahooSplits)
 *   - FCF(t)      : Finnhub /financials-reported quarterly (sur 4 derniers Q = TTM)
 *
 * Resolution :
 *   - 1Y    → weekly  (~52 points)
 *   - 5Y+   → monthly (~60-240 points)
 *
 * Cas de gap (point omis) :
 *   - TTM_FCF ≤ 0 (FCF négatif : ratio non-pertinent financièrement)
 *   - Pas de quarter récent connu (delta < 6 mois)
 *   - Pas assez de quarters pour calculer TTM (besoin ≥ 4)
 */
import { fetchSplitEvents, splitAdjustWithDiscontinuity } from './yahooSplits.js';
import { getReportedTimeseries } from './finnhubFundamentals.js';
import { yahooLimiter } from '../lib/limiter.js';
import type { TimeseriesPoint } from '@lubin/shared';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Lubin-Investment/0.1';

export interface PfcfHistoryPoint {
  /** YYYY-MM-DD */
  date: string;
  /** Multiple P/FCF (ex 22.5). Toujours > 0 — les points où le calcul n'est pas pertinent sont omis. */
  pfcf: number;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
    error?: { description?: string } | null;
  };
}

/** Récupère les prix historiques (close ajusté splits/dividendes) depuis Yahoo. */
async function fetchPriceHistory(
  ticker: string,
  years: number,
  interval: '1d' | '1wk' | '1mo',
): Promise<TimeseriesPoint[]> {
  return yahooLimiter.schedule(async () => {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - Math.ceil(years * 365.25) * 24 * 3600;
    const url = `${CHART_BASE}/${encodeURIComponent(ticker)}`
      + `?period1=${period1}&period2=${period2}`
      + `&interval=${interval}`
      + `&events=history`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
    const data = (await res.json()) as YahooChartResponse;
    if (data.chart?.error) throw new Error(`Yahoo chart: ${data.chart.error.description}`);
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    // adjclose = prix ajustés des dividendes ET splits → c'est ce qu'on veut
    const closes = result?.indicators?.adjclose?.[0]?.adjclose
                 ?? result?.indicators?.quote?.[0]?.close
                 ?? [];
    const points: TimeseriesPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const v = closes[i];
      if (typeof ts !== 'number' || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      points.push({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        value: v,
      });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return points;
  });
}

/** Calcule la somme TTM (trailing 12 months) à chaque trimestre = sum des 4 derniers Q FCF. */
function rollingTtm(quarterlyFcf: TimeseriesPoint[]): { date: string; ttm: number }[] {
  const sorted = [...quarterlyFcf].sort((a, b) => a.date.localeCompare(b.date));
  const result: { date: string; ttm: number }[] = [];
  for (let i = 3; i < sorted.length; i++) {
    const ttm = sorted[i]!.value + sorted[i-1]!.value + sorted[i-2]!.value + sorted[i-3]!.value;
    result.push({ date: sorted[i]!.date, ttm });
  }
  return result;
}

/**
 * Index : pour une date `t`, retrouve le dernier point de la série dont date ≤ t.
 * Renvoie null si pas de point récent (within `maxStalenessDays`).
 */
function findLatestAsOf<T extends { date: string }>(
  series: T[],
  asOfIso: string,
  maxStalenessDays = 200,
): T | null {
  // Hypothèse : series triée par date croissante.
  // Pour perf on pourrait binary search, mais N max ~50 quarters → linéaire OK.
  let candidate: T | null = null;
  for (const p of series) {
    if (p.date <= asOfIso) candidate = p;
    else break;
  }
  if (!candidate) return null;
  const ageMs = new Date(asOfIso).getTime() - new Date(candidate.date).getTime();
  if (ageMs > maxStalenessDays * 24 * 3600 * 1000) return null;
  return candidate;
}

/**
 * Calcule la timeseries de P/FCF pour un ticker sur une fenêtre donnée.
 *
 * @param ticker  Symbole boursier (en majuscules)
 * @param years   Profondeur de l'historique (1, 5, 10, 20, 50 pour "All")
 */
export async function getPfcfHistory(ticker: string, years: number): Promise<PfcfHistoryPoint[]> {
  // Choix de résolution : 1Y = weekly (52 pts), au-delà = monthly (60-600 pts)
  const interval: '1d' | '1wk' | '1mo' = years <= 1 ? '1wk' : '1mo';

  // Fenêtre FCF : besoin de 1 an supplémentaire pour calculer le TTM du premier point
  const fcfYears = years + 1;

  // Fetch en parallèle : prix, FCF quarterly, shares quarterly, splits
  const [prices, fcfQ, sharesQ, splits] = await Promise.all([
    fetchPriceHistory(ticker, years, interval),
    getReportedTimeseries(ticker, 'fcf', 'quarterly', fcfYears),
    getReportedTimeseries(ticker, 'shares', 'quarterly', fcfYears),
    fetchSplitEvents(ticker),
  ]);

  if (prices.length === 0) {
    console.warn(`[pfcf ${ticker}] aucun prix Yahoo`);
    return [];
  }
  if (fcfQ.length < 4 || sharesQ.length < 4) {
    console.warn(`[pfcf ${ticker}] pas assez de quarters (FCF=${fcfQ.length}, shares=${sharesQ.length})`);
    return [];
  }

  // getReportedTimeseries(metric='shares') applique déjà splitAdjustWithDiscontinuity en interne.
  // On ré-applique malgré tout pour les FCF ? Non — FCF est un montant total, indépendant des splits.
  // Pour shares on bénéficie déjà de la détection discontinuité.
  void splits; // (gardé pour future extension éventuelle, ex: ajustement dividendes)

  const ttmSeries = rollingTtm(fcfQ);

  // Pour chaque prix, on retrouve le quarter TTM et shares correspondants
  const points: PfcfHistoryPoint[] = [];
  for (const p of prices) {
    const ttm = findLatestAsOf(ttmSeries, p.date);
    const sh = findLatestAsOf(sharesQ, p.date);
    if (!ttm || !sh) continue;
    if (ttm.ttm <= 0 || sh.value <= 0) continue;
    const marketCap = p.value * sh.value;
    const pfcf = marketCap / ttm.ttm;
    if (!Number.isFinite(pfcf) || pfcf <= 0) continue;
    points.push({ date: p.date, pfcf: Math.round(pfcf * 100) / 100 });
  }

  console.log(`[pfcf ${ticker}] ${points.length} pts (${interval}) — prices=${prices.length} fcfQ=${fcfQ.length} sharesQ=${sharesQ.length}`);
  return points;
}
