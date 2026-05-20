/**
 * Routes d'analyse :
 *   GET  /api/analyze?ticker=MEDP            → analyse complète
 *   POST /api/analyze/revalue                → recalcul valo
 *   POST /api/analyze/refresh-qual           → re-fetch qualitatif (bypass cache)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AnalyzeResponse, ValoParams } from '@lubin/shared';
import { getMetric, getProfile2, getQuote, getCompanyNews } from '../services/finnhub.js';
import { getProfile } from '../services/fmp.js';
import { getSharesHistory, computeSharesCagr, computeFcfPerShareCagr } from '../services/yahoo.js';
import { getEarningsInfo } from '../services/earnings.js';
import { fetchQualitative, type QualitativeResult } from '../services/openai.js';
import { computeDerivedMetrics, buildQuantitativeCriteria, buildValuation, filterNews } from '../services/derivedMetrics.js';
import { prisma } from '../db/client.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { analyzeLimiter } from '../middleware/rateLimit.js';

export const analyzeRouter: Router = Router();

const QUAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);
const ValoParamsSchema = z.object({
  targetReturn: z.number().min(0.01).max(1),
  fcfGrowth: z.number().min(-0.5).max(1),
  targetMultiple: z.number().min(1).max(100),
});

/** Schéma actuel : 10 business + 5 management. Si le cache est plus court, on re-fetch. */
const EXPECTED_BUSINESS = 10;
const EXPECTED_MGMT = 5;

function isCacheCompatible(data: unknown): data is QualitativeResult {
  const d = data as Partial<QualitativeResult> | null;
  return !!d
    && Array.isArray(d.business) && d.business.length >= EXPECTED_BUSINESS
    && Array.isArray(d.management) && d.management.length >= EXPECTED_MGMT;
}

async function loadOrFetchQualitative(
  ticker: string,
  company: string,
  chiffresContext: { nom: string; valeur: string; statut: string }[],
  sbcShareOfFcf: number | null,
  forceRefresh = false,
) {
  if (!forceRefresh) {
    const cached = await prisma.qualitativeCache.findUnique({ where: { ticker } });
    if (cached && Date.now() - cached.updatedAt.getTime() < QUAL_TTL_MS && isCacheCompatible(cached.data)) {
      return { data: cached.data, updatedAt: cached.updatedAt };
    }
    if (cached) console.log(`[cache] ${ticker} obsolète (schéma changé) — re-fetch`);
  }
  const fresh = await fetchQualitative({ ticker, company, chiffresContext, sbcShareOfFcf });
  const upserted = await prisma.qualitativeCache.upsert({
    where: { ticker },
    update: { data: fresh as object },
    create: { ticker, data: fresh as object },
  });
  return { data: fresh, updatedAt: upserted.updatedAt };
}

analyzeRouter.get('/', analyzeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.query.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide', parse.error.flatten());
  const ticker = parse.data;
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  // Mesure le temps de chaque appel externe individuellement
  const timed = <T>(name: string, p: Promise<T>): Promise<T> => {
    const start = Date.now();
    return p.then(
      r => { console.log(`[analyze ${ticker}] ${name} OK in ${Date.now() - start}ms`); return r; },
      e => { console.warn(`[analyze ${ticker}] ${name} FAIL in ${Date.now() - start}ms : ${e.message}`); throw e; },
    );
  };

  console.log(`[analyze ${ticker}] start`);
  const [metric, fhProfile, quote, rawNews, fmpProfile, sharesHistory, earnings] = await Promise.all([
    timed('finnhub metric',    getMetric(ticker)).catch(() => null),
    timed('finnhub profile2',  getProfile2(ticker)).catch(() => null),
    timed('finnhub quote',     getQuote(ticker)).catch(() => null),
    timed('finnhub news',      getCompanyNews(ticker)).catch(() => []),
    timed('fmp profile',       getProfile(ticker)).catch(() => null),
    timed('yahoo shares',      getSharesHistory(ticker)).catch(() => null),
    timed('finnhub earnings',  getEarningsInfo(ticker)).catch(() => ({ next: null, last: null })),
  ]);
  console.log(`[analyze ${ticker}] data layer done in ${ms()}ms`);

  // ─── Vérification de qualité de données ─────────────────────────────
  // Cas 1 : Finnhub a complètement crashé (metric vide ET pas de quote) → 503, retry.
  // Cas 2 : Finnhub répond mais sans fondamentaux (typique tickers non-US comme SIX:COPN) →
  //         on continue avec fundamentalsAvailable=false, le front affichera un bandeau.
  //         L'analyse qualitative GPT reste valide via web search.
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
  const fundamentalsAvailable = hasPrice || hasMetricData;

  const yahooShareCagr = computeSharesCagr(sharesHistory);
  const yahooFcfPerShareCagr = computeFcfPerShareCagr(sharesHistory);
  const metrics = computeDerivedMetrics({ metric, profile: fhProfile, quote, yahooShareCagr, yahooFcfPerShareCagr });
  const company = fhProfile?.name ?? fmpProfile?.companyName ?? ticker;
  const quant = buildQuantitativeCriteria(metrics);

  const chiffresContext = quant.map(c => ({ nom: c.nom, valeur: c.valeur, statut: c.statut }));
  const tGpt = Date.now();
  // Mode dégradé : si GPT échoue (quota, timeout, parsing), on continue avec un placeholder.
  // L'utilisateur voit les chiffres + valo (qui ne dépendent pas de GPT) et un message clair.
  let qual: QualitativeResult = { verdict_direct: '', business: [], management: [] };
  let updatedAt: Date | null = null;
  let qualError: string | null = null;
  try {
    const result = await loadOrFetchQualitative(ticker, company, chiffresContext, metrics.sbcShareOfFcf);
    qual = result.data;
    updatedAt = result.updatedAt;
  } catch (e) {
    const msg = (e as Error).message;
    qualError = /quota|insufficient|429/i.test(msg)
      ? 'Quota OpenAI épuisé — augmente ta limite ou passe sur gpt-4o-mini-search-preview'
      : `Analyse qualitative indisponible : ${msg.slice(0, 120)}`;
    console.warn(`[analyze ${ticker}] GPT failed : ${msg}`);
  }
  console.log(`[analyze ${ticker}] qualitative ${Date.now() - tGpt}ms (total ${ms()}ms)`);

  const histGrowth = metrics.fcfPerShareCagr ?? metrics.revenueCagr;
  const fcfGrowth = histGrowth != null ? Math.max(0.03, Math.min(histGrowth * 0.75, 0.20)) : 0.10;
  const targetMultiple = metrics.pfcfTTM && metrics.pfcfTTM > 0
    ? Math.max(10, Math.min(Math.round(metrics.pfcfTTM * 0.85), 30))
    : 20;
  const valoParams: ValoParams = { targetReturn: 0.15, fcfGrowth, targetMultiple };
  const valuation = buildValuation(metrics, valoParams);

  const criteres = [...quant, ...qual.business, ...qual.management, valuation];
  // Si pas de fondamentaux, les 11 critères "chiffres" + la valorisation sont tous à warn (N/A) —
  // donner un score 17/27 (15 qualitatif passent souvent) est trompeur. On ne note que
  // ce qui est réellement évaluable : exclure les critères dont la valeur est explicitement N/A.
  const evaluables = fundamentalsAvailable
    ? criteres
    : criteres.filter(c => c.valeur !== 'N/A');
  const pass = evaluables.filter(c => c.statut === 'pass').length;
  const warn = evaluables.filter(c => c.statut === 'warn').length;
  const score = pass + Math.round(warn * 0.5);
  const scoreMax = evaluables.length;

  const response: AnalyzeResponse = {
    ticker,
    company,
    price: metrics.price,
    metrics,
    criteres,
    score,
    scoreMax,
    achat: score / scoreMax >= 0.7,
    verdict_direct: qual.verdict_direct,
    news: filterNews(rawNews),
    valuation,
    valoParams,
    qualUpdatedAt: updatedAt?.toISOString() ?? null,
    qualError,
    earnings,
    fundamentalsAvailable,
  };
  res.json(response);
}));

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

analyzeRouter.post('/refresh-qual', analyzeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const tickerParse = TickerSchema.safeParse(req.body?.ticker);
  if (!tickerParse.success) throw new ApiError(400, 'ticker invalide');
  const ticker = tickerParse.data;

  const [metric, profile, quote, sharesHistory] = await Promise.all([
    getMetric(ticker).catch(() => null),
    getProfile2(ticker).catch(() => null),
    getQuote(ticker).catch(() => null),
    getSharesHistory(ticker).catch(() => null),
  ]);
  const yahooShareCagr = computeSharesCagr(sharesHistory);
  const yahooFcfPerShareCagr = computeFcfPerShareCagr(sharesHistory);
  const metrics = computeDerivedMetrics({ metric, profile, quote, yahooShareCagr, yahooFcfPerShareCagr });
  const company = profile?.name ?? ticker;
  const quant = buildQuantitativeCriteria(metrics);
  const chiffresContext = quant.map(c => ({ nom: c.nom, valeur: c.valeur, statut: c.statut }));
  const { data, updatedAt } = await loadOrFetchQualitative(ticker, company, chiffresContext, metrics.sbcShareOfFcf, true);
  res.json({ qualitative: data, qualUpdatedAt: updatedAt.toISOString() });
}));
