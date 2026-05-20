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
import { resolveYahooTicker } from '../services/yahooResolve.js';
import { getYahooFundamentals } from '../services/yahooFundamentals.js';
import { getEarningsInfo } from '../services/earnings.js';
import { fetchBusinessAnalysis, fetchManagementAnalysis } from '../services/openai.js';
import { computeDerivedMetrics, buildQuantitativeCriteria, buildValuation, filterNews } from '../services/derivedMetrics.js';
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
    const yahooShareCagr = computeSharesCagr(sharesHistory);
    const yahooFcfPerShareCagr = computeFcfPerShareCagr(sharesHistory);
    metrics = computeDerivedMetrics({ metric, profile: fhProfile, quote, yahooShareCagr, yahooFcfPerShareCagr });
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

  const chiffres = buildQuantitativeCriteria(metrics);

  const histGrowth = metrics.fcfPerShareCagr ?? metrics.revenueCagr;
  const fcfGrowth = histGrowth != null ? Math.max(0.03, Math.min(histGrowth * 0.75, 0.20)) : 0.10;
  const targetMultiple = metrics.pfcfTTM && metrics.pfcfTTM > 0
    ? Math.max(10, Math.min(Math.round(metrics.pfcfTTM * 0.85), 30))
    : 20;
  const valoParams: ValoParams = { targetReturn: 0.15, fcfGrowth, targetMultiple };
  const valuation = buildValuation(metrics, valoParams);

  // Si business/management ne sont pas (encore) cachés, on les omet du tableau de critères.
  // Le front affichera un CTA "Générer l'analyse qualitative" à leur place.
  const criteres = [
    ...chiffres,
    ...(business ?? []),
    ...(management ?? []),
    valuation,
  ];
  const evaluables = fundamentalsAvailable
    ? criteres
    : criteres.filter(c => c.valeur !== 'N/A');
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
