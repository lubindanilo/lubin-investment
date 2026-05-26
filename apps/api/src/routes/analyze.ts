/**
 * Routes d'analyse :
 *   GET  /api/analyze?ticker=MEDP             → quant + qualitative IF cached (PAS d'appel GPT auto)
 *   POST /api/analyze/qualitative             → génère ce qui manque (business si absent + management si absent)
 *   POST /api/analyze/refresh-management      → force GPT call pour management uniquement
 *   POST /api/analyze/revalue                 → recalcul valorisation avec inputs custom
 *
 * Architecture cache :
 *   - BusinessAnalysis  : lifetime cache, jamais regénéré automatiquement
 *   - ManagementAnalysis : refreshable via bouton dédié (CEO/CFO peuvent changer)
 *   - Tout GET /api/analyze ne déclenche JAMAIS d'appel GPT — seuls les POST le font
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AnalyzeResponse, ValoParams, Criterion } from '@lubin/shared';
import { getMetric, getProfile2, getQuote, getCompanyNews } from '../services/finnhub.js';
import { getSharesHistory, computeSharesCagr, computeFcfPerShareCagr } from '../services/yahoo.js';
import {
  computeFcfPerShareCagrFromQuarterlies,
  computeRevenueGrowthFromQuarterlies,
  computeSharesGrowthFromQuarterlies,
  computeOperatingMarginTrendFromQuarterlies,
  computeAdjustedFcfTtm,
  computeCapitalEmployedSnapshot,
} from '../services/finnhubFundamentals.js';
import { resolveYahooTicker } from '../services/yahooResolve.js';
import { getYahooFundamentals } from '../services/yahooFundamentals.js';
import { getEarningsInfo } from '../services/earnings.js';
import { fetchBusinessAnalysis, fetchManagementAnalysis } from '../services/openai.js';
import { computeDerivedMetrics, buildQuantitativeCriteria, buildPfcfCriterion, buildValuation, filterNews } from '../services/derivedMetrics.js';
import { prisma } from '../db/client.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { analyzeLimiter } from '../middleware/rateLimit.js';

export const analyzeRouter: Router = Router();

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);
const ValoParamsSchema = z.object({
  targetReturn: z.number().min(0.01).max(1),
  fcfGrowth: z.number().min(-0.5).max(1),
  targetMultiple: z.number().min(1).max(100),
});

const EXPECTED_BUSINESS = 10;
const EXPECTED_MGMT = 5;

/**
 * Vérifie qu'une donnée stockée en cache business correspond au schéma actuel (10 critères).
 * Si le schéma a évolué (ex passage de 8 → 10 critères), on considère que c'est obsolète.
 */
function isBusinessCacheValid(data: unknown): data is Criterion[] {
  return Array.isArray(data) && data.length >= EXPECTED_BUSINESS;
}
function isManagementCacheValid(data: unknown): data is Criterion[] {
  return Array.isArray(data) && data.length >= EXPECTED_MGMT;
}

/**
 * Helper : récupère les bases nécessaires (metric, profile, quote, shares, earnings)
 * via Finnhub + Yahoo fallback. Renvoie un blob unique utilisable par GET /analyze
 * et POST /analyze/qualitative (qui en a besoin pour reconstruire le contexte).
 */
async function loadQuantData(ticker: string) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  const timed = <T>(name: string, p: Promise<T>): Promise<T> => {
    const start = Date.now();
    return p.then(
      r => { console.log(`[analyze ${ticker}] ${name} OK in ${Date.now() - start}ms`); return r; },
      e => { console.warn(`[analyze ${ticker}] ${name} FAIL in ${Date.now() - start}ms : ${e.message}`); throw e; },
    );
  };

  console.log(`[analyze ${ticker}] start`);
  // 6 sources en parallèle — FMP retiré (redondant : Finnhub profile2 + Yahoo longName suffisent pour le nom de société).
  const [metric, fhProfile, quote, rawNews, sharesHistory, earnings] = await Promise.all([
    timed('finnhub metric',    getMetric(ticker)).catch(() => null),
    timed('finnhub profile2',  getProfile2(ticker)).catch(() => null),
    timed('finnhub quote',     getQuote(ticker)).catch(() => null),
    timed('finnhub news',      getCompanyNews(ticker)).catch(() => []),
    timed('yahoo shares',      getSharesHistory(ticker)).catch(() => null),
    timed('finnhub earnings',  getEarningsInfo(ticker)).catch(() => ({ next: null, last: null })),
  ]);
  console.log(`[analyze ${ticker}] data layer done in ${ms()}ms`);

  const metricEmpty = !metric || !metric.metric || Object.keys(metric.metric).length === 0;
  if (metricEmpty && !quote) {
    throw new ApiError(
      503,
      'Données fondamentales indisponibles',
      `Finnhub n'a pas répondu pour ${ticker}. Vérifie la clé API ou réessaie dans 1 minute (rate limit).`,
    );
  }
  const hasPrice = !!quote?.c && quote.c > 0;
  const hasMetricData = !metricEmpty;
  const finnhubUsable = hasPrice || hasMetricData;

  let fundamentalsSource: 'finnhub' | 'yahoo' | null = null;
  let currency = 'USD';
  let yahooSymbol: string | undefined;
  let metrics;
  let companyFromSource: string | null = null;

  if (finnhubUsable) {
    fundamentalsSource = 'finnhub';
    // 5 calculs en parallèle via les quarterlies Finnhub :
    //   - FCF/action 5Y (régression sur TTM FCF_adj / TTM_shares)
    //   - Croissance CA 5Y (régression sur TTM_revenue)
    //   - Évolution actions 5Y (régression sur shares quarterly split-adj)
    //   - Operating leverage (pente du TTM op margin)
    //   - FCF_adj actuel (CFO_TTM − SBC_TTM + CapEx_TTM) → utilisé pour pfcfTTM, fcfMargin,
    //     cashROCE, netDebtFcf, ccr — toute la chaîne FCF est désormais SBC-ajustée.
    const [fhFcfPs, fhRev, fhShares, fhOpLev, fhFcfAdj, fhCapEmp] = await Promise.all([
      timed('fh fcfPs regress',  computeFcfPerShareCagrFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh rev regress',    computeRevenueGrowthFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh shares regress', computeSharesGrowthFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh opLev regress',  computeOperatingMarginTrendFromQuarterlies(ticker, 5)).catch(() => ({ value: null as number | null, reason: 'Erreur calcul' as string | undefined })),
      timed('fh fcfAdj ttm',     computeAdjustedFcfTtm(ticker)).catch(() => ({ ttmFcfAdj: null as number | null, ttmCfo: null, ttmSbc: null, ttmCapex: null, sbcShareOfFcf: null, asOf: null })),
      timed('fh capEmp',         computeCapitalEmployedSnapshot(ticker)).catch(() => ({ totalAssets: null as number | null, currentLiabilities: null as number | null, currentAssets: null as number | null, goodwill: null as number | null, equity: null as number | null, totalDebt: null as number | null, totalCash: null as number | null, revenueTtm: null as number | null, netIncomeTtm: null as number | null, sharesLatest: null as number | null, excessCash: null as number | null, formulaUsed: null as 'strict' | 'no-excess-fallback' | 'no-goodwill-fallback' | 'financial-equity' | null, capitalEmployed: null as number | null, asOf: null, reason: 'Erreur fetch capital employé' as string | undefined })),
    ]);

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
    // précomputed mais /financials-reported renvoie 0 filing (les boîtes filent du
    // 20-F annuel à la SEC, pas du 10-Q). Symptôme : fhFcfAdj et fhCapEmp sont tous
    // les deux null. → bascule sur Yahoo annual pour les fondamentaux (cohérent avec
    // les tickers EU purs).
    const finnhubFinancialsEmpty = fhFcfAdj.ttmFcfAdj == null && fhCapEmp.capitalEmployed == null;
    if (finnhubFinancialsEmpty) {
      console.log(`[analyze ${ticker}] Finnhub /financials-reported vide (probable ADR étranger) → bascule Yahoo annual pour les fondamentaux`);
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
        // FCF_adj (TTM CFO − SBC + CapEx) — utilisé pour pfcfTTM, fcfMargin, cashROCE,
        // netDebtFcf, ccr. Si null, on retombe sur les ratios précomputed Finnhub bruts.
        adjFcfTtm: fhFcfAdj.ttmFcfAdj,
        sbcShareOfFcf: fhFcfAdj.sbcShareOfFcf,
        // Capital employé Bettin/Mauboussin (snapshot dernier Q) → dénominateur Cash ROCE.
        capitalEmployed: fhCapEmp.capitalEmployed,
        capitalEmployedReason: fhCapEmp.reason,
        capitalEmployedFormula: fhCapEmp.formulaUsed,
        // Fallbacks robustesse pour quand /stock/metric flake (BKNG cas constaté).
        // Ces 7 champs viennent du même fetch CapitalEmployedSnapshot — pas de surcoût.
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
    console.log(`[analyze ${ticker}] Finnhub vide → fallback Yahoo`);
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
        metrics = computeDerivedMetrics({ metric, profile: fhProfile, quote, yahooShareCagr: null, yahooFcfPerShareCagr: null });
      }
    } else {
      metrics = computeDerivedMetrics({ metric, profile: fhProfile, quote, yahooShareCagr: null, yahooFcfPerShareCagr: null });
    }
  }

  const fundamentalsAvailable = fundamentalsSource !== null;
  const company = companyFromSource ?? fhProfile?.name ?? ticker;

  return {
    metrics, company, fundamentalsAvailable, fundamentalsSource, currency, yahooSymbol,
    rawNews, earnings,
  };
}

/**
 * Construit la réponse AnalyzeResponse à partir du quant + des qualitatives (optionnels).
 * Si `business`/`management` sont null, le score est calculé uniquement sur les critères
 * disponibles (chiffres + valorisation).
 */
function buildResponse(args: {
  ticker: string;
  quant: Awaited<ReturnType<typeof loadQuantData>>;
  business: Criterion[] | null;
  verdictDirect: string | null;
  management: Criterion[] | null;
  businessCachedAt: Date | null;
  managementCachedAt: Date | null;
}): AnalyzeResponse {
  const { ticker, quant, business, verdictDirect, management, businessCachedAt, managementCachedAt } = args;
  const { metrics, company, fundamentalsAvailable, fundamentalsSource, currency, yahooSymbol, rawNews, earnings } = quant;

  const chiffres = buildQuantitativeCriteria(metrics);     // 10 critères qualité
  const pfcfCriterion = buildPfcfCriterion(metrics);       // P/FCF actuel — affiché en valorisation

  const histGrowth = metrics.fcfPerShareCagr ?? metrics.revenueCagr;
  const fcfGrowth = histGrowth != null ? Math.max(0.03, Math.min(histGrowth * 0.75, 0.20)) : 0.10;
  const targetMultiple = metrics.pfcfTTM && metrics.pfcfTTM > 0
    ? Math.max(10, Math.min(Math.round(metrics.pfcfTTM * 0.85), 30))
    : 20;
  const valoParams: ValoParams = { targetReturn: 0.15, fcfGrowth, targetMultiple };
  const valuation = buildValuation(metrics, valoParams);   // Buy price Buffett-style

  // Ordre du tableau criteres :
  //   [0..9]    : chiffres (10)
  //   [10..19]  : business (10, ou vide si pas encore généré)
  //   [20..24]  : management (5, ou vide si pas encore généré)
  //   [25, 26]  : valorisation = [P/FCF actuel, Buy price]
  //
  // ⚠ Le score (et son max) n'inclut PAS la valorisation : une boîte exceptionnelle
  // reste exceptionnelle même surévaluée — elle est juste pas encore au bon prix.
  // Score max = 10 + 10 + 5 = 25 (ou 10 si qualitatif pas encore généré).
  const valuationBlock = [pfcfCriterion, valuation];
  const criteres = [
    ...chiffres,
    ...(business ?? []),
    ...(management ?? []),
    ...valuationBlock,
  ];
  const scoringCandidates = [...chiffres, ...(business ?? []), ...(management ?? [])];
  const evaluables = fundamentalsAvailable
    ? scoringCandidates
    : scoringCandidates.filter(c => c.valeur !== 'N/A');
  const pass = evaluables.filter(c => c.statut === 'pass').length;
  const warn = evaluables.filter(c => c.statut === 'warn').length;
  const score = pass + Math.round(warn * 0.5);
  const scoreMax = evaluables.length;

  return {
    ticker,
    company,
    price: metrics.price,
    metrics,
    criteres,
    score,
    scoreMax,
    achat: scoreMax > 0 && score / scoreMax >= 0.7,
    verdict_direct: verdictDirect ?? '',
    news: filterNews(rawNews),
    valuation,
    valoParams,
    businessCachedAt: businessCachedAt?.toISOString() ?? null,
    managementCachedAt: managementCachedAt?.toISOString() ?? null,
    qualitativeAvailable: business != null && management != null,
    earnings,
    fundamentalsAvailable,
    fundamentalsSource,
    currency,
    yahooSymbol,
  };
}

// ─── GET /api/analyze ──────────────────────────────────────────────────────
// Lit cache business + cache management. Ne fait JAMAIS d'appel GPT.
// Si l'un des deux n'est pas en cache, on renvoie quand même la réponse — le front
// affichera le bouton "Générer l'analyse qualitative".

analyzeRouter.get('/', analyzeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.query.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide', parse.error.flatten());
  const ticker = parse.data;

  const quant = await loadQuantData(ticker);

  // Lecture des 2 caches qualitatifs en parallèle (gratuit, pas d'API call GPT)
  const [businessRow, managementRow] = await Promise.all([
    prisma.businessAnalysis.findUnique({ where: { ticker } }),
    prisma.managementAnalysis.findUnique({ where: { ticker } }),
  ]);

  const business = businessRow && isBusinessCacheValid(businessRow.business) ? businessRow.business : null;
  const management = managementRow && isManagementCacheValid(managementRow.management) ? managementRow.management : null;

  res.json(buildResponse({
    ticker,
    quant,
    business,
    verdictDirect: businessRow?.verdictDirect ?? null,
    management,
    businessCachedAt: business ? businessRow!.createdAt : null,
    managementCachedAt: management ? managementRow!.updatedAt : null,
  }));
}));

// ─── POST /api/analyze/qualitative ─────────────────────────────────────────
// Génère ce qui manque (business + management si absents). Renvoie la réponse complète.
// C'est le SEUL endroit où on déclenche un appel GPT (à part /refresh-management).

analyzeRouter.post('/qualitative', analyzeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.body?.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  const ticker = parse.data;

  const quant = await loadQuantData(ticker);
  const company = quant.company;
  const chiffres = buildQuantitativeCriteria(quant.metrics);
  const chiffresContext = chiffres.map(c => ({ nom: c.nom, valeur: c.valeur, statut: c.statut }));

  // Lecture initiale du cache
  const [existingBiz, existingMgmt] = await Promise.all([
    prisma.businessAnalysis.findUnique({ where: { ticker } }),
    prisma.managementAnalysis.findUnique({ where: { ticker } }),
  ]);

  // Génère le business UNIQUEMENT s'il est absent ou schéma obsolète.
  // Le business est cache À VIE — pas de TTL, pas de regen automatique.
  let business: Criterion[];
  let verdictDirect: string;
  let businessCachedAt: Date;
  if (existingBiz && isBusinessCacheValid(existingBiz.business)) {
    business = existingBiz.business;
    verdictDirect = existingBiz.verdictDirect;
    businessCachedAt = existingBiz.createdAt;
    console.log(`[analyze ${ticker}] business cache hit (${businessCachedAt.toISOString().slice(0, 10)})`);
  } else {
    console.log(`[analyze ${ticker}] business cache miss → GPT call`);
    const fresh = await fetchBusinessAnalysis({ ticker, company, chiffresContext, sbcShareOfFcf: quant.metrics.sbcShareOfFcf });
    const upserted = await prisma.businessAnalysis.upsert({
      where: { ticker },
      update: { business: fresh.business as object, verdictDirect: fresh.verdict_direct },
      create: { ticker, business: fresh.business as object, verdictDirect: fresh.verdict_direct },
    });
    business = fresh.business;
    verdictDirect = fresh.verdict_direct;
    businessCachedAt = upserted.createdAt;
  }

  // Génère le management UNIQUEMENT s'il est absent.
  // Le management est cache jusqu'à refresh explicite via /refresh-management.
  let management: Criterion[];
  let managementCachedAt: Date;
  if (existingMgmt && isManagementCacheValid(existingMgmt.management)) {
    management = existingMgmt.management;
    managementCachedAt = existingMgmt.updatedAt;
    console.log(`[analyze ${ticker}] management cache hit (${managementCachedAt.toISOString().slice(0, 10)})`);
  } else {
    console.log(`[analyze ${ticker}] management cache miss → GPT call`);
    const fresh = await fetchManagementAnalysis({ ticker, company, chiffresContext, sbcShareOfFcf: quant.metrics.sbcShareOfFcf });
    const upserted = await prisma.managementAnalysis.upsert({
      where: { ticker },
      update: { management: fresh.management as object },
      create: { ticker, management: fresh.management as object },
    });
    management = fresh.management;
    managementCachedAt = upserted.updatedAt;
  }

  res.json(buildResponse({
    ticker, quant, business, verdictDirect, management, businessCachedAt, managementCachedAt,
  }));
}));

// ─── POST /api/analyze/refresh-management ──────────────────────────────────
// Force un GPT call POUR LE MANAGEMENT UNIQUEMENT. Le business reste intouchable.
// Cas d'usage : CEO part, CFO scandale, nouveau président — l'utilisateur sait
// quand il y a un changement, déclenche un refresh.

analyzeRouter.post('/refresh-management', analyzeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.body?.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  const ticker = parse.data;

  const quant = await loadQuantData(ticker);
  const chiffres = buildQuantitativeCriteria(quant.metrics);
  const chiffresContext = chiffres.map(c => ({ nom: c.nom, valeur: c.valeur, statut: c.statut }));

  console.log(`[analyze ${ticker}] refresh-management forced → GPT call`);
  const fresh = await fetchManagementAnalysis({ ticker, company: quant.company, chiffresContext, sbcShareOfFcf: quant.metrics.sbcShareOfFcf });
  const upserted = await prisma.managementAnalysis.upsert({
    where: { ticker },
    update: { management: fresh.management as object },
    create: { ticker, management: fresh.management as object },
  });

  // On lit aussi business pour pouvoir reconstruire la response complète
  const businessRow = await prisma.businessAnalysis.findUnique({ where: { ticker } });
  const business = businessRow && isBusinessCacheValid(businessRow.business) ? businessRow.business : null;

  res.json(buildResponse({
    ticker,
    quant,
    business,
    verdictDirect: businessRow?.verdictDirect ?? null,
    management: fresh.management,
    businessCachedAt: business ? businessRow!.createdAt : null,
    managementCachedAt: upserted.updatedAt,
  }));
}));

// ─── POST /api/analyze/revalue ─────────────────────────────────────────────
// Recalcul de la valorisation avec inputs custom (slider UI). Pas de GPT.

analyzeRouter.post('/revalue', asyncHandler(async (req: Request, res: Response) => {
  const tickerParse = TickerSchema.safeParse(req.body?.ticker);
  const paramsParse = ValoParamsSchema.safeParse(req.body?.params);
  if (!tickerParse.success || !paramsParse.success) throw new ApiError(400, 'payload invalide');

  const [metric, quote] = await Promise.all([
    getMetric(tickerParse.data).catch(() => null),
    getQuote(tickerParse.data).catch(() => null),
  ]);
  const metrics = computeDerivedMetrics({ metric, profile: null, quote });
  const valuation = buildValuation(metrics, { ...paramsParse.data, targetReturn: 0.15 });
  res.json({ valuation, metrics });
}));
