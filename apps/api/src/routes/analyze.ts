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
import { getMetric, getQuote } from '../services/finnhub.js';
import { loadQuantData } from '../services/quantSnapshot.js';
import { fetchBusinessAnalysis, fetchManagementAnalysis } from '../services/openai.js';
import { computeDerivedMetrics, buildQuantitativeCriteria, buildPfcfCriterion, buildValuation, filterNews } from '../services/derivedMetrics.js';
import { writeCachedSnapshot, type CachedQuantSnapshot } from '../services/quantCache.js';
import { prisma } from '../db/client.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { analyzeLimiter } from '../middleware/rateLimit.js';
import { optionalAuth } from '../middleware/auth.js';

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
 * Wrapper local : convertit "Finnhub complètement vide" en ApiError 503 pour la
 * route analyze (qui veut retourner une erreur HTTP claire), alors que d'autres
 * callers (watchlist) gèrent ce cas en silence avec un fallback emptyEntry.
 */
async function loadQuantDataOrThrow(ticker: string) {
  const data = await loadQuantData(ticker);
  if (data.finnhubCompletelyEmpty && !data.fundamentalsAvailable) {
    throw new ApiError(
      503,
      'Données fondamentales indisponibles',
      `Finnhub n'a pas répondu pour ${ticker}. Vérifie la clé API ou réessaie dans 1 minute (rate limit).`,
    );
  }
  return data;
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

analyzeRouter.get('/', analyzeLimiter, optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.query.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide', parse.error.flatten());
  const ticker = parse.data;

  const quant = await loadQuantDataOrThrow(ticker);

  // Lecture des 2 caches qualitatifs + appartenance watchlist (si connecté) en parallèle.
  // L'appartenance est calculée ici côté serveur (source unique) → le front n'a pas à
  // refetch la watchlist séparément, ce qui éliminait les faux "Ajouter" quand ce 2e
  // fetch échouait/traînait.
  const userId = req.user?.userId;
  const [businessRow, managementRow, watchlistRow] = await Promise.all([
    prisma.businessAnalysis.findUnique({ where: { ticker } }),
    prisma.managementAnalysis.findUnique({ where: { ticker } }),
    userId
      ? prisma.watchlistEntry.findUnique({ where: { userId_ticker: { userId, ticker } } })
      : Promise.resolve(null),
  ]);

  const business = businessRow && isBusinessCacheValid(businessRow.business) ? businessRow.business : null;
  const management = managementRow && isManagementCacheValid(managementRow.management) ? managementRow.management : null;

  const response = buildResponse({
    ticker,
    quant,
    business,
    verdictDirect: businessRow?.verdictDirect ?? null,
    management,
    businessCachedAt: business ? businessRow!.createdAt : null,
    managementCachedAt: management ? managementRow!.updatedAt : null,
  });
  if (userId) response.inWatchlist = watchlistRow != null;

  // ⚠ SINGLE SOURCE OF TRUTH : on persiste le résultat dans le cache global
  // TickerQuantSnapshot. La watchlist le lira tel quel → impossible que les 2 vues
  // divergent. Le score affiché en watchlist = exactement le score calculé ici.
  await persistQuantCache(ticker, quant, response);

  res.json(response);
}));

/**
 * Écrit dans le cache global TickerQuantSnapshot le résultat du compute quant.
 * Appelé à chaque GET /api/analyze pour garder la watchlist alignée.
 *
 * Notes :
 * - On extrait les chiffres uniquement (les 10 premiers du tableau criteres) pour le
 *   recompute du score watchlist. Pas le qualitatif (business + management) qui n'est
 *   PAS utilisé par la watchlist.
 * - adjFcfTtm + sharesOutstanding sont extraits du quant brut pour le recompute P/FCF
 *   live de la watchlist (price live × shares / adjFcfTtm).
 */
async function persistQuantCache(
  ticker: string,
  quant: Awaited<ReturnType<typeof loadQuantData>>,
  response: AnalyzeResponse,
) {
  const chiffres = response.criteres.slice(0, 10);
  // Le score chiffres = même formule que côté watchlist (pass + round(warn × 0.5)).
  // On filtre N/A pour le path Yahoo, comme buildSnapshot le faisait.
  const evaluable = quant.fundamentalsSource === 'yahoo'
    ? chiffres.filter(c => c.valeur !== 'N/A')
    : chiffres;
  const pass = evaluable.filter(c => c.statut === 'pass').length;
  const warn = evaluable.filter(c => c.statut === 'warn').length;

  // Extraction shares + adjFcfTtm pour le live recompute P/FCF
  let adjFcfTtm: number | null = null;
  let sharesOutstanding: number | null = null;
  if (quant.fundamentalsSource === 'finnhub' && quant.rawFhFcfAdj && quant.rawFhCapEmp) {
    adjFcfTtm = quant.rawFhFcfAdj.ttmFcfAdj;
    sharesOutstanding = quant.rawFhCapEmp.sharesLatest;
  } else if (quant.fundamentalsSource === 'yahoo') {
    const m = quant.metrics;
    sharesOutstanding = (m.marketCap != null && m.price != null && m.price > 0)
      ? m.marketCap / m.price : null;
    adjFcfTtm = (m.marketCap != null && m.pfcfTTM != null && m.pfcfTTM > 0)
      ? m.marketCap / m.pfcfTTM : null;
  }

  const snapshot: CachedQuantSnapshot = {
    ticker,
    company: quant.company,
    currency: quant.currency,
    fundamentalsSource: quant.fundamentalsSource,
    fundamentalsAvailable: quant.fundamentalsAvailable,
    yahooSymbol: quant.yahooSymbol,
    metrics: quant.metrics,
    chiffres,
    scoreChiffres: pass + Math.round(warn * 0.5),
    scoreChiffresMax: evaluable.length,
    adjFcfTtm,
    sharesOutstanding,
  };
  await writeCachedSnapshot(ticker, snapshot).catch(err => {
    console.warn(`[analyze ${ticker}] échec persistance cache : ${err.message}`);
  });
}

// ─── POST /api/analyze/qualitative ─────────────────────────────────────────
// Génère ce qui manque (business + management si absents). Renvoie la réponse complète.
// C'est le SEUL endroit où on déclenche un appel GPT (à part /refresh-management).

analyzeRouter.post('/qualitative', analyzeLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.body?.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  const ticker = parse.data;

  const quant = await loadQuantDataOrThrow(ticker);
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

  const quant = await loadQuantDataOrThrow(ticker);
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
