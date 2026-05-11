import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WatchlistEntry } from '@lubin/shared';
import { prisma } from '../db/client.js';
import { getMetric, getProfile2, getQuote } from '../services/finnhub.js';
import { computeDerivedMetrics, buildQuantitativeCriteria } from '../services/derivedMetrics.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { watchlistMutateLimiter } from '../middleware/rateLimit.js';

export const watchlistRouter: Router = Router();

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);

/** Snapshot frais : on n'appelle PAS Yahoo (utile uniquement pour la page Analyse).
 *  shareCagr Finnhub-derived suffit pour le score chiffres affiché dans la ligne tableau. */
async function buildSnapshot(ticker: string): Promise<WatchlistEntry> {
  const [metric, profile, quote] = await Promise.all([
    getMetric(ticker).catch(() => null),
    getProfile2(ticker).catch(() => null),
    getQuote(ticker).catch(() => null),
  ]);
  // yahooShareCagr undefined → fallback Finnhub-derived dans computeDerivedMetrics
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
  };
}

/** Age max d'un snapshot avant qu'il soit considéré "stale" et qu'on le re-fetch. */
const SNAPSHOT_FRESHNESS_MS = 30 * 60 * 1000; // 30 minutes

function isFresh(refreshedAt: Date | null | undefined): boolean {
  if (!refreshedAt) return false;
  return Date.now() - refreshedAt.getTime() < SNAPSHOT_FRESHNESS_MS;
}

watchlistRouter.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const entries = await prisma.watchlistEntry.findMany({ orderBy: { addedAt: 'asc' } });
  const result: WatchlistEntry[] = entries.map(e => {
    const snap = (e.snapshot as WatchlistEntry | null) ?? null;
    return snap ?? { ticker: e.ticker, name: e.ticker, price: null, pfcfTTM: null, scoreChiffres: 0, scoreChiffresMax: 10 };
  });
  res.json(result);
}));

watchlistRouter.post('/', watchlistMutateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.body?.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  const ticker = parse.data;

  const snapshot = await buildSnapshot(ticker);
  await prisma.watchlistEntry.upsert({
    where: { ticker },
    update: { snapshot: snapshot as object, refreshedAt: new Date() },
    create: { ticker, snapshot: snapshot as object, refreshedAt: new Date() },
  });
  res.json(snapshot);
}));

watchlistRouter.delete('/:ticker', watchlistMutateLimiter, asyncHandler(async (req: Request, res: Response) => {
  const parse = TickerSchema.safeParse(req.params.ticker);
  if (!parse.success) throw new ApiError(400, 'ticker invalide');
  await prisma.watchlistEntry.deleteMany({ where: { ticker: parse.data } });
  res.json({ ok: true });
}));

/**
 * POST /api/watchlist/refresh?force=true
 *
 * Sans `force=true` : ne re-fetch que les snapshots > 30 min (les autres restent tels quels).
 * Avec `force=true`   : re-fetch tous les snapshots quoi qu'il arrive.
 *
 * Effet : éviter de saturer Finnhub à chaque ouverture de la page Watchlist
 * quand la donnée est encore fraîche.
 */
watchlistRouter.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  const entries = await prisma.watchlistEntry.findMany();

  let staleCount = 0;
  const snapshots = await Promise.all(
    entries.map(async e => {
      const fallback = (e.snapshot as WatchlistEntry | null) ??
        { ticker: e.ticker, name: e.ticker, price: null, pfcfTTM: null, scoreChiffres: 0, scoreChiffresMax: 10 };
      if (!force && isFresh(e.refreshedAt)) return fallback;
      staleCount++;
      try {
        const snap = await buildSnapshot(e.ticker);
        await prisma.watchlistEntry.update({
          where: { ticker: e.ticker },
          data: { snapshot: snap as object, refreshedAt: new Date() },
        });
        return snap;
      } catch (err) {
        console.warn('[watchlist refresh]', e.ticker, (err as Error).message);
        return fallback;
      }
    })
  );
  console.log(`[watchlist refresh] ${staleCount}/${entries.length} tickers re-fetched (force=${force})`);
  res.json(snapshots);
}));
