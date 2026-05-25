/**
 * Cash ROCE historique — trajectoire du Cash ROCE Bettin/Mauboussin dans le temps.
 *
 * Formule :
 *   cashROCE(t) = FCF_adj_TTM(t) / (TotalAssets(t) − CurrentLiabilities(t) − Goodwill(t))
 *
 * Sources :
 *   - US (Finnhub quarterly) : TTM rolling FCF_adj + snapshot Assets/CurLiab/Goodwill par quarter
 *   - EU + ADRs étrangers (Yahoo annual) : FCF / (Assets − CurLiab − Goodwill) par exercice
 *
 * Cas filtrés (point omis, pas de fallback) :
 *   - FCF_adj_TTM ≤ 0 (entreprise pas profitable cash → ROCE non-pertinent)
 *   - CE ≤ 0 (goodwill > capital productif → ratio non-pertinent)
 *
 * Cohérence avec le single-point : la formule est identique à celle utilisée par
 * derivedMetrics.ts (US Finnhub) et yahooFundamentals.ts (EU). Le dernier point
 * du graphique = la valeur affichée dans le critère.
 */
import { getAdjustedFcfTtmSeries, getCapitalEmployedSeries, computeExcessCash } from './finnhubFundamentals.js';
import { resolveYahooTicker } from './yahooResolve.js';
import { yahooLimiter } from '../lib/limiter.js';
import type { TimeseriesPoint } from '@lubin/shared';

const TIMESERIES_BASE = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Lubin-Investment/0.1';

export interface CashRoceHistoryPoint {
  /** YYYY-MM-DD — fin de quarter (US) ou fin de FY (EU) */
  date: string;
  /** Ratio Cash ROCE (ex 0.225 pour 22.5 %). Toujours > 0 — points dégénérés omis. */
  cashRoce: number;
}

/**
 * Index : pour une date `t`, retrouve le dernier point ≤ t. Null si trop ancien.
 * (Helper local — duplicate de pfcfHistory pour découpler.)
 */
function findLatestAsOf<T extends { date: string }>(
  series: T[],
  asOfIso: string,
  maxStalenessDays = 200,
): T | null {
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
 * Calcule la timeseries Cash ROCE pour un ticker.
 *
 * @param ticker  Symbole boursier (ex BKNG, MEDP, NESN.SW)
 * @param years   Profondeur (1, 5, 10, 20, 50)
 */
export async function getCashRoceHistory(ticker: string, years: number): Promise<CashRoceHistoryPoint[]> {
  // Route US/EU selon résolution Yahoo (même logique que pfcfHistory.ts)
  const resolved = await resolveYahooTicker(ticker).catch(() => null);
  const isEuTicker = !!resolved && resolved.symbol !== ticker;

  if (isEuTicker && resolved) {
    return getCashRoceHistoryAnnualYahoo(resolved.symbol, years);
  }

  const usResult = await getCashRoceHistoryUs(ticker, years);
  if (usResult.length === 0) {
    console.log(`[cashRoce ${ticker}] Finnhub vide → fallback annual Yahoo (probable ADR étranger)`);
    return getCashRoceHistoryAnnualYahoo(resolved?.symbol ?? ticker, years);
  }
  return usResult;
}

/** Path US : Finnhub quarterly. Join FCF_adj_TTM par quarter avec equity+debt par quarter. */
async function getCashRoceHistoryUs(ticker: string, years: number): Promise<CashRoceHistoryPoint[]> {
  // FCF a besoin d'1 an supplémentaire pour calculer le TTM du premier point
  const [fcfTtmSeries, ceSeries] = await Promise.all([
    getAdjustedFcfTtmSeries(ticker, years + 1),
    getCapitalEmployedSeries(ticker, years + 1),
  ]);

  if (fcfTtmSeries.length === 0 || ceSeries.length === 0) {
    console.warn(`[cashRoce ${ticker}] US insuffisant (fcfTtm=${fcfTtmSeries.length}, ce=${ceSeries.length})`);
    return [];
  }

  // Cutoff de la fenêtre demandée
  const cutoffMs = Date.now() - years * 365.25 * 24 * 3600 * 1000;

  const points: CashRoceHistoryPoint[] = [];
  // On itère sur la série FCF_TTM (granularité quarterly) et joint avec le capital employé
  // au quarter le plus proche (snapshot point-in-time).
  for (const fcfPoint of fcfTtmSeries) {
    if (fcfPoint.ts < cutoffMs) continue;
    if (fcfPoint.value <= 0) continue; // FCF négatif → ROCE non pertinent
    const ce = findLatestAsOf(ceSeries, fcfPoint.date);
    if (!ce) continue;
    const ratio = fcfPoint.value / ce.value;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    points.push({ date: fcfPoint.date, cashRoce: Math.round(ratio * 10000) / 10000 });
  }

  console.log(`[cashRoce ${ticker}] US ${points.length} pts — fcfTtm=${fcfTtmSeries.length} ce=${ceSeries.length}`);
  return points;
}

/**
 * Path "annual Yahoo" — utilisé pour :
 *   1. Tickers européens (NESN.SW, MC.PA, COPN.SW…)
 *   2. ADRs étrangers cotés US (ASML, NSRGY, TSM…) qui filent en 20-F annuel
 *
 * Formule annuelle :
 *   cashROCE(N) = FCF(N) / (Assets(N) − CurLiab(N) − Goodwill(N) − ExcessCash(N))
 *   où ExcessCash(N) = max(0, cash(N) − 2% × revenue(N))
 *
 * Cohérent avec yahooFundamentals.ts (snapshot) et derivedMetrics.ts.
 */
async function getCashRoceHistoryAnnualYahoo(yahooSymbol: string, years: number): Promise<CashRoceHistoryPoint[]> {
  const [fcf, assets, curLiab, goodwill, cashSti, cashOnly, revenue] = await Promise.all([
    fetchYahooAnnualBasic(yahooSymbol, 'annualFreeCashFlow'),
    fetchYahooAnnualBasic(yahooSymbol, 'annualTotalAssets'),
    fetchYahooAnnualBasic(yahooSymbol, 'annualCurrentLiabilities'),
    fetchYahooAnnualBasic(yahooSymbol, 'annualGoodwill'),
    fetchYahooAnnualBasic(yahooSymbol, 'annualCashAndShortTermInvestments'),
    fetchYahooAnnualBasic(yahooSymbol, 'annualCashAndCashEquivalents'),
    fetchYahooAnnualBasic(yahooSymbol, 'annualTotalRevenue'),
  ]);
  if (fcf.length === 0 || assets.length === 0 || curLiab.length === 0) {
    console.warn(`[cashRoce ${yahooSymbol}] EU pas assez de données (fcf=${fcf.length}, assets=${assets.length}, curLiab=${curLiab.length})`);
    return [];
  }
  // Préférence : cash+STI agrégé. Fallback : cash seul.
  const cash = cashSti.length > 0 ? cashSti : cashOnly;

  const cutoffMs = Date.now() - years * 365.25 * 24 * 3600 * 1000;

  const assetsByYear = new Map<string, number>();
  const curLiabByYear = new Map<string, number>();
  const goodwillByYear = new Map<string, number>();
  const cashByYear = new Map<string, number>();
  const revenueByYear = new Map<string, number>();
  for (const p of assets) assetsByYear.set(p.date.slice(0, 4), p.value);
  for (const p of curLiab) curLiabByYear.set(p.date.slice(0, 4), p.value);
  for (const p of goodwill) goodwillByYear.set(p.date.slice(0, 4), p.value);
  for (const p of cash) cashByYear.set(p.date.slice(0, 4), p.value);
  for (const p of revenue) revenueByYear.set(p.date.slice(0, 4), p.value);

  const points: CashRoceHistoryPoint[] = [];
  for (const p of fcf) {
    const ts = new Date(p.date + 'T00:00:00Z').getTime();
    if (ts < cutoffMs) continue;
    if (p.value <= 0) continue;
    const yr = p.date.slice(0, 4);
    const a = assetsByYear.get(yr);
    const cl = curLiabByYear.get(yr);
    if (a == null || cl == null) continue;
    const gw = goodwillByYear.get(yr) ?? 0;
    const ch = cashByYear.get(yr) ?? 0;
    const rev = revenueByYear.get(yr) ?? null;
    const excess = computeExcessCash(ch, rev);
    // Strict d'abord, fallback sans excess sinon (cohérent avec le snapshot Finnhub)
    const ceStrict = a - cl - gw - excess;
    let ce: number;
    if (ceStrict > 0) {
      ce = ceStrict;
    } else {
      const ceNoExcess = a - cl - gw;
      if (ceNoExcess <= 0) continue; // sur-acquisition → skip
      ce = ceNoExcess;
    }
    const ratio = p.value / ce;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    points.push({ date: p.date, cashRoce: Math.round(ratio * 10000) / 10000 });
  }

  points.sort((a, b) => a.date.localeCompare(b.date));

  console.log(`[cashRoce ${yahooSymbol}] EU ${points.length} pts annual — fcf=${fcf.length} assets=${assets.length} curLiab=${curLiab.length} goodwill=${goodwill.length} cash=${cash.length} rev=${revenue.length}`);
  return points;
}

/** Helper bas-niveau (clone de pfcfHistory.fetchYahooAnnualBasic). */
async function fetchYahooAnnualBasic(symbol: string, type: string): Promise<Array<{ date: string; value: number }>> {
  return yahooLimiter.schedule(async () => {
    const now = Math.floor(Date.now() / 1000);
    const url = `${TIMESERIES_BASE}/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}&period1=${now - 10 * 365 * 86400}&period2=${now}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) return [];
      const data = await res.json() as { timeseries?: { result?: Array<Record<string, unknown> & { meta?: { type?: string[] } }> } };
      const result = data.timeseries?.result?.find(r => r.meta?.type?.includes(type));
      const rows = (result?.[type] as Array<{ asOfDate?: string; reportedValue?: { raw?: number } }> | undefined) ?? [];
      return rows
        .map(r => (r.asOfDate && typeof r.reportedValue?.raw === 'number')
          ? { date: r.asOfDate, value: r.reportedValue.raw }
          : null)
        .filter((x): x is { date: string; value: number } => x !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch {
      return [];
    }
  });
}

// Type re-export pour faciliter l'usage par les routes/tests
export type { TimeseriesPoint };
