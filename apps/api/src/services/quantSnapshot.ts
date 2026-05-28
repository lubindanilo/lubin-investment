/**
 * loadQuantData — service partagé qui calcule TOUS les fondamentaux d'un ticker.
 *
 * Source UNIQUE de vérité pour les 2 routes qui ont besoin du quant :
 *   - /api/analyze       → analyse complète (chiffres + valuation)
 *   - /api/watchlist     → snapshot pour la liste (mêmes chiffres → même score)
 *
 * Avant cette extraction, watchlist.ts avait sa propre `buildSnapshot` qui zappait
 * les 4 régressions TTM (FCF/share, revenue, shares, op margin). Conséquence :
 * computeDerivedMetrics tombait sur les ratios précomputed Finnhub qui diffèrent
 * légèrement → score divergent entre watchlist et analyze (ex BKNG 9/10 vs 10/10).
 *
 * Avec ce service partagé : impossible de diverger, c'est mathématique.
 */
import { getMetric, getProfile2, getQuote, getCompanyNews, type FinnhubNewsItem } from './finnhub.js';
import { getSharesHistory, computeSharesCagr, computeFcfPerShareCagr, getEarningsInfoYahoo } from './yahoo.js';
import {
  computeFcfPerShareCagrFromQuarterlies,
  computeRevenueGrowthFromQuarterlies,
  computeSharesGrowthFromQuarterlies,
  computeOperatingMarginTrendFromQuarterlies,
  computeAdjustedFcfTtm,
  computeCapitalEmployedSnapshot,
  type AdjustedFcfResult,
  type CapitalEmployedSnapshot,
} from './finnhubFundamentals.js';
import { resolveYahooTicker } from './yahooResolve.js';
import { getYahooFundamentals } from './yahooFundamentals.js';
import { getEarningsInfo } from './earnings.js';
import type { EarningsInfo } from '@lubin/shared';
import { computeDerivedMetrics } from './derivedMetrics.js';
import type { DerivedMetrics } from '@lubin/shared';

export interface QuantData {
  metrics: DerivedMetrics;
  company: string;
  fundamentalsAvailable: boolean;
  fundamentalsSource: 'finnhub' | 'yahoo' | null;
  currency: string;
  yahooSymbol?: string;
  rawNews: FinnhubNewsItem[];
  earnings: EarningsInfo;
  /** True si Finnhub n'a renvoyé NI metric NI quote (ticker complètement inconnu).
   *  Le caller (analyze) peut alors throw 503 ; watchlist peut renvoyer emptyEntry. */
  finnhubCompletelyEmpty: boolean;
  // Données brutes que certains callers veulent persister (cf. watchlist live P/FCF)
  rawFhFcfAdj: AdjustedFcfResult | null;
  rawFhCapEmp: CapitalEmployedSnapshot | null;
}

export interface LoadQuantOptions {
  /** Skip getCompanyNews — économise 1 call Finnhub. Default: true (inclus). */
  includeNews?: boolean;
  /** Skip getEarningsInfo — économise 1 call Finnhub. Default: true (inclus). */
  includeEarnings?: boolean;
  /** Logs verbeux. Default: true. */
  log?: boolean;
}

export async function loadQuantData(ticker: string, opts: LoadQuantOptions = {}): Promise<QuantData> {
  const { includeNews = true, includeEarnings = true, log = true } = opts;
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  const timed = <T>(name: string, p: Promise<T>): Promise<T> => {
    if (!log) return p;
    const start = Date.now();
    return p.then(
      r => { console.log(`[quant ${ticker}] ${name} OK in ${Date.now() - start}ms`); return r; },
      e => { console.warn(`[quant ${ticker}] ${name} FAIL in ${Date.now() - start}ms : ${e.message}`); throw e; },
    );
  };

  if (log) console.log(`[quant ${ticker}] start`);
  // Tous les fetches "data layer" en parallèle. Les optionnels (news, earnings) sont
  // remplacés par des Promise.resolve si exclus pour économiser des calls Finnhub.
  const [metric, fhProfile, quote, rawNews, sharesHistory, earnings] = await Promise.all([
    timed('finnhub metric',    getMetric(ticker)).catch(() => null),
    timed('finnhub profile2',  getProfile2(ticker)).catch(() => null),
    timed('finnhub quote',     getQuote(ticker)).catch(() => null),
    includeNews
      ? timed('finnhub news',    getCompanyNews(ticker)).catch(() => [] as FinnhubNewsItem[])
      : Promise.resolve([] as FinnhubNewsItem[]),
    timed('yahoo shares',      getSharesHistory(ticker)).catch(() => null),
    includeEarnings
      ? timed('finnhub earnings', getEarningsInfo(ticker)).catch(() => ({ next: null, last: null } as EarningsInfo))
      : Promise.resolve({ next: null, last: null } as EarningsInfo),
  ]);
  if (log) console.log(`[quant ${ticker}] data layer done in ${ms()}ms`);

  const metricEmpty = !metric || !metric.metric || Object.keys(metric.metric).length === 0;
  const hasPrice = !!quote?.c && quote.c > 0;
  const hasMetricData = !metricEmpty;
  const finnhubCompletelyEmpty = metricEmpty && !quote;
  const finnhubUsable = hasPrice || hasMetricData;

  let fundamentalsSource: 'finnhub' | 'yahoo' | null = null;
  let currency = 'USD';
  let yahooSymbol: string | undefined;
  let metrics: DerivedMetrics | undefined;
  let companyFromSource: string | null = null;
  let rawFhFcfAdj: AdjustedFcfResult | null = null;
  let rawFhCapEmp: CapitalEmployedSnapshot | null = null;

  if (finnhubUsable) {
    fundamentalsSource = 'finnhub';
    // 5 calculs en parallèle via les quarterlies Finnhub :
    //   - FCF/action 5Y (régression sur TTM FCF_adj / TTM_shares)
    //   - Croissance CA 5Y (régression sur TTM_revenue)
    //   - Évolution actions 5Y (régression sur shares quarterly split-adj)
    //   - Operating leverage (pente du TTM op margin)
    //   - FCF_adj actuel (CFO_TTM − SBC_TTM + CapEx_TTM)
    const [fhFcfPs, fhRev, fhShares, fhOpLev, fhFcfAdj, fhCapEmp] = await Promise.all([
      timed('fh fcfPs regress',  computeFcfPerShareCagrFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh rev regress',    computeRevenueGrowthFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh shares regress', computeSharesGrowthFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh opLev regress',  computeOperatingMarginTrendFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh fcfAdj ttm',     computeAdjustedFcfTtm(ticker)).catch(() => ({ ttmFcfAdj: null as number | null, ttmCfo: null, ttmSbc: null, ttmCapex: null, sbcShareOfFcf: null, asOf: null } as AdjustedFcfResult)),
      timed('fh capEmp',         computeCapitalEmployedSnapshot(ticker)).catch(() => ({ totalAssets: null, currentLiabilities: null, currentAssets: null, goodwill: null, equity: null, totalDebt: null, totalCash: null, revenueTtm: null, netIncomeTtm: null, sharesLatest: null, excessCash: null, formulaUsed: null, capitalEmployed: null, asOf: null, reason: 'Erreur fetch capital employé' } as CapitalEmployedSnapshot)),
    ]);
    rawFhFcfAdj = fhFcfAdj;
    rawFhCapEmp = fhCapEmp;

    // FCF/action : fallback Yahoo si Finnhub quarterly KO (ADRs étrangers)
    let fcfPsCagrValue = fhFcfPs.value;
    let fcfPsCagrReason = fhFcfPs.reason;
    if (fcfPsCagrValue == null) {
      const yahooResult = computeFcfPerShareCagr(sharesHistory);
      if (yahooResult.value != null) {
        fcfPsCagrValue = yahooResult.value;
        fcfPsCagrReason = undefined;
      }
    }

    // Shares growth : fallback Yahoo annual si Finnhub quarterly KO
    let sharesCagrValue = fhShares.value;
    let sharesCagrReason = fhShares.reason;
    if (sharesCagrValue == null) {
      const yahooShareCagr = computeSharesCagr(sharesHistory);
      if (yahooShareCagr != null) {
        sharesCagrValue = yahooShareCagr;
        sharesCagrReason = undefined;
      }
    }

    // ADRs étrangers (ASML, NSRGY, TSM…) : Finnhub /stock/metric expose des ratios
    // précomputed mais /financials-reported renvoie 0 filing → fhFcfAdj et fhCapEmp
    // sont tous les deux null. Bascule sur Yahoo annual.
    const finnhubFinancialsEmpty = fhFcfAdj.ttmFcfAdj == null && fhCapEmp.capitalEmployed == null;
    if (finnhubFinancialsEmpty) {
      if (log) console.log(`[quant ${ticker}] Finnhub /financials-reported vide (probable ADR étranger) → Yahoo annual`);
      const resolved = await timed('yahoo resolve', resolveYahooTicker(ticker)).catch(() => null);
      if (resolved) {
        yahooSymbol = resolved.symbol;
        currency = resolved.currency;
        companyFromSource = resolved.longName ?? null;
        const yfund = await timed('yahoo fundamentals (ADR)', getYahooFundamentals(resolved.symbol, resolved.price, resolved.currency, resolved.longName ?? null)).catch(() => null);
        if (yfund) {
          fundamentalsSource = 'yahoo';
          metrics = yfund.metrics;
        }
      }
    }

    if (!metrics) {
      metrics = computeDerivedMetrics({
        metric, profile: fhProfile, quote,
        yahooShareCagr: sharesCagrValue,
        yahooFcfPerShareCagr: fcfPsCagrValue,
        yahooFcfPerShareCagrReason: fcfPsCagrReason,
        revenueGrowthOverride: fhRev.value,
        revenueGrowthOverrideReason: fhRev.reason,
        sharesGrowthReason: sharesCagrReason,
        opMarginTrend: fhOpLev.value,
        opMarginTrendReason: fhOpLev.reason,
        adjFcfTtm: fhFcfAdj.ttmFcfAdj,
        sbcShareOfFcf: fhFcfAdj.sbcShareOfFcf,
        capitalEmployed: fhCapEmp.capitalEmployed,
        capitalEmployedReason: fhCapEmp.reason,
        capitalEmployedFormula: fhCapEmp.formulaUsed,
        // Fallbacks robustesse pour quand /stock/metric flake
        revenueTtm: fhCapEmp.revenueTtm,
        netIncomeTtm: fhCapEmp.netIncomeTtm,
        sharesLatest: fhCapEmp.sharesLatest,
        currentAssetsSnapshot: fhCapEmp.currentAssets,
        currentLiabilitiesSnapshot: fhCapEmp.currentLiabilities,
        totalDebtSnapshot: fhCapEmp.totalDebt,
        totalCashSnapshot: fhCapEmp.totalCash,
      });
    }
  } else {
    if (log) console.log(`[quant ${ticker}] Finnhub vide → fallback Yahoo pur`);
    const resolved = await timed('yahoo resolve', resolveYahooTicker(ticker)).catch(() => null);
    if (resolved) {
      yahooSymbol = resolved.symbol;
      currency = resolved.currency;
      companyFromSource = resolved.longName ?? null;
      const yfund = await timed('yahoo fundamentals', getYahooFundamentals(resolved.symbol, resolved.price, resolved.currency, resolved.longName ?? null)).catch(() => null);
      if (yfund) {
        fundamentalsSource = 'yahoo';
        metrics = yfund.metrics;
      } else {
        metrics = computeDerivedMetrics({ metric, profile: fhProfile, quote });
      }
    } else {
      metrics = computeDerivedMetrics({ metric, profile: fhProfile, quote });
    }
  }

  const fundamentalsAvailable = fundamentalsSource !== null;
  const company = companyFromSource ?? fhProfile?.name ?? ticker;

  // Fallback earnings Yahoo : Finnhub /calendar/earnings est US-only. Pour les titres
  // EU/non-US (résolus en yahooSymbol au-dessus), il renvoie vide → on récupère les
  // earnings via Yahoo quoteSummary. On ne le fait que si Finnhub n'a rien donné, pour
  // ne pas dépenser un call Yahoo sur les US où Finnhub est meilleur (revenue inclus).
  let earningsInfo = earnings;
  if (includeEarnings && !earningsInfo.next && !earningsInfo.last && yahooSymbol) {
    const yEarn = await timed('yahoo earnings', getEarningsInfoYahoo(yahooSymbol)).catch(() => null);
    if (yEarn && (yEarn.next || yEarn.last)) earningsInfo = yEarn;
  }

  return {
    metrics, company, fundamentalsAvailable, fundamentalsSource, currency, yahooSymbol,
    rawNews, earnings: earningsInfo, finnhubCompletelyEmpty,
    rawFhFcfAdj, rawFhCapEmp,
  };
}
