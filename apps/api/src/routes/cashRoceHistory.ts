/**
 * GET /api/cash-roce-history?ticker=BKNG&years=5
 *   → renvoie la timeseries Cash ROCE = FCF_adj / (Equity + Debt)
 *
 * Calcul join FCF_adj_TTM (Finnhub quarterly, rolling) avec equity + totalDebt
 * snapshot par quarter (Finnhub financials-reported). EU/ADRs : annual Yahoo.
 * Cache earnings-based (réutilise timeseriesCache, comme pfcfHistory).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { getCashRoceHistory } from '../services/cashRoceHistory.js';
import { getNextEarningsDate, ttlUntilNextEarnings } from '../services/earnings.js';
import * as cache from '../lib/timeseriesCache.js';

export const cashRoceHistoryRouter: Router = Router();

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-]{1,15}$/);
const YearsSchema = z.coerce.number().int().min(1).max(50).default(5);

cashRoceHistoryRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const t = TickerSchema.safeParse(req.query.ticker);
  const y = YearsSchema.safeParse(req.query.years ?? '5');
  if (!t.success || !y.success) {
    throw new ApiError(400, 'Paramètres invalides', {
      ticker: t.success ? 'ok' : 'invalid',
      years: y.success ? 'ok' : 'invalid (1-50)',
    });
  }
  const ticker = t.data;
  const years = y.data;
  // Cache key dédié — namespace différent de pfcf-history pour éviter collisions
  const key = cache.cacheKey(ticker, 'cash-roce-history', 'computed', years);

  const hit = cache.get(key);
  if (hit) {
    res.json({
      ticker,
      years,
      points: hit.points.map(p => ({ date: p.date, cashRoce: p.value })),
      cached: true,
      ageMs: Date.now() - hit.storedAt,
    });
    return;
  }

  const startedAt = Date.now();
  const earningsPromise = getNextEarningsDate(ticker);
  const points = await getCashRoceHistory(ticker, years);
  const elapsedMs = Date.now() - startedAt;

  const nextEarnings = await earningsPromise;
  const ttlMs = ttlUntilNextEarnings(nextEarnings);
  cache.set(
    key,
    points.map(p => ({ date: p.date, value: p.cashRoce })),
    'finnhub',
    ttlMs,
  );

  res.json({
    ticker,
    years,
    points,
    cached: false,
    fetchedInMs: elapsedMs,
    cacheTtlHours: Math.round(ttlMs / 3_600_000),
  });
}));
