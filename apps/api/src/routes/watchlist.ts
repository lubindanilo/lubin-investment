import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WatchlistEntry } from '@lubin/shared';
import { prisma } from '../db/client.js';
import { getMetric, getProfile2, getQuote } from '../services/finnhub.js';
import { resolveYahooTicker } from '../services/yahooResolve.js';
import { getYahooFundamentals } from '../services/yahooFundamentals.js';
import { computeDerivedMetrics, buildQuantitativeCriteria } from '../services/derivedMetrics.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { watchlistMutateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';

export const watchlistRouter: Router = Router();

// Toutes les routes ci-dessous nécessitent un user authentifié.
watchlistRouter.use(requireAuth);

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);

/**
 * Construit le snapshot d'un ticker (prix, P/FCF, score, devise) pour affichage en watchlist.
 *
 * Stratégie identique à /api/analyze (loadQuantData) pour rester cohérent :
 *   1. Finnhub d'abord (rapide, complet pour les US)
 *   2. Si Finnhub vide ET résolution Yahoo trouve un symbol → fallback Yahoo (EU + ADRs étrangers)
 *
 * Avant ce fix : COPN, NESN, MC.PA etc. retournaient price=null pfcfTTM=null score=6/11
 * (les 11 critères tous en 'warn' → round(11×0.5) = 6) → affichage "0.00$ N/A 6/11".
 */
async function buildSnapshot(ticker: string): Promise<WatchlistEntry> {
  const [metric, profile, quote] = await Promise.all([
    getMetric(ticker).catch(() => null),
    getProfile2(ticker).catch(() => null),
    getQuote(ticker).catch(() => null),
  ]);

  const metricEmpty = !metric || !metric.metric || Object.keys(metric.metric).length === 0;
  const hasPrice = !!quote?.c && quote.c > 0;
  const finnhubUsable = hasPrice || !metricEmpty;

  if (finnhubUsable) {
    const m = computeDerivedMetrics({ metric, profile, quote });
    const quant = buildQuantitativeCriteria(m);
    const pass = quant.filter(c => c.statut === 'pass').length;
    const warn = quant.filter(c => c.statut === 'warn').length;
    return {
      ticker,
      name: profile?.name ?? ticker,
      price: m.price,
      pfcfTTM: m.pfcfTTM,
      scoreChiffres: pass + Math.round(warn * 0.5),
      scoreChiffresMax: quant.length,
      currency: 'USD',
      source: 'finnhub',
    };
  }

  // Finnhub vide → fallback Yahoo (tickers EU + ADRs étrangers)
  const resolved = await resolveYahooTicker(ticker).catch(() => null);
  if (resolved) {
    const yfund = await getYahooFundamentals(resolved.symbol, resolved.price, resolved.currency, resolved.longName ?? null).catch(() => null);
    if (yfund) {
      const quant = buildQuantitativeCriteria(yfund.metrics);
      // Score honnête : exclut les critères N/A du dénominateur (sinon score gonflé artificiellement)
      const evaluable = quant.filter(c => c.valeur !== 'N/A');
      const pass = evaluable.filter(c => c.statut === 'pass').length;
      const warn = evaluable.filter(c => c.statut === 'warn').length;
      return {
        ticker,
        name: resolved.longName ?? ticker,
        price: yfund.metrics.price,
        pfcfTTM: yfund.metrics.pfcfTTM,
        scoreChiffres: pass + Math.round(warn * 0.5),
        scoreChiffresMax: evaluable.length,
        currency: yfund.currency,
        source: 'yahoo',
      };
    }
    // Yahoo a résolu mais fundamentals indispos (rare) — au moins on a le prix + nom
    return {
      ticker,
      name: resolved.longName ?? ticker,
      price: resolved.price,
      pfcfTTM: null,
      scoreChiffres: 0,
      scoreChiffresMax: 0,
      currency: resolved.currency,
      source: 'yahoo',
    };
  }

  // Ni Finnhub ni Yahoo → snapshot "indisponible" minimal
  return {
    ticker,
    name: ticker,
    price: null,
    pfcfTTM: null,
    scoreChiffres: 0,
    scoreChiffresMax: 0,
    currency: 'USD',
    source: null,
  };
}

const SNAPSHOT_FRESHNESS_MS = 30 * 60 * 1000;
function isFresh(refreshedAt: Date | null | undefined): boolean {
  if (!refreshedAt) return false;
  return Date.now() - refreshedAt.getTime() < SNAPSHOT_FRESHNESS_MS;
}

/** Fallback de présentation pour les lignes sans snapshot DB. */
function emptyEntry(ticker: string): WatchlistEntry {
  return {
    ticker, name: ticker, price: null, pfcfTTM: null,
    scoreChiffres: 0, scoreChiffresMax: 0,
    currency: 'USD', source: null,
  };
}

watchlistRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const entries = await prisma.watchlistEntry.findMany({
    where: { userId },
    orderBy: { addedAt: 'asc' },
  });
  const result: WatchlistEntry[] = entries.map(e => {
    const snap = (e.snapshot as WatchlistEntry | null) ?? null;
    return snap ?? emptyEntry(e.ticker);
  });
  res.json(result);
}));

watchlistRouter.post('/', watchlistMutateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parse = TickerSchema.safeParse(req.body?.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  const ticker = parse.data;

  const snapshot = await buildSnapshot(ticker);
  await prisma.watchlistEntry.upsert({
    where: { userId_ticker: { userId, ticker } },
    update: { snapshot: snapshot as object, refreshedAt: new Date() },
    create: { userId, ticker, snapshot: snapshot as object, refreshedAt: new Date() },
  });
  res.json(snapshot);
}));

watchlistRouter.delete('/:ticker', watchlistMutateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parse = TickerSchema.safeParse(req.params.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  await prisma.watchlistEntry.deleteMany({ where: { userId, ticker: parse.data } });
  res.json({ ok: true });
}));

/**
 * POST /api/watchlist/refresh?force=true
 * - Sans force : skip les snapshots < 30 min (économise Finnhub + Yahoo)
 * - Avec force : tout re-fetch
 */
watchlistRouter.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const force = req.query.force === 'true';
  const entries = await prisma.watchlistEntry.findMany({ where: { userId } });

  let staleCount = 0;
  const snapshots = await Promise.all(
    entries.map(async e => {
      const fallback = (e.snapshot as WatchlistEntry | null) ?? emptyEntry(e.ticker);
      if (!force && isFresh(e.refreshedAt)) return fallback;
      staleCount++;
      try {
        const snap = await buildSnapshot(e.ticker);
        await prisma.watchlistEntry.update({
          where: { userId_ticker: { userId, ticker: e.ticker } },
          data: { snapshot: snap as object, refreshedAt: new Date() },
        });
        return snap;
      } catch (err) {
        console.warn('[watchlist refresh]', e.ticker, (err as Error).message);
        return fallback;
      }
    })
  );
  console.log(`[watchlist refresh user=${userId.slice(0, 8)}] ${staleCount}/${entries.length} re-fetched (force=${force})`);
  res.json(snapshots);
}));
