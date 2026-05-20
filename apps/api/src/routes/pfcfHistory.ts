/**
 * GET /api/pfcf-history?ticker=BKNG&years=5
 *   → renvoie la timeseries P/FCF computée
 *
 * Le calcul join price (Yahoo, daily/weekly/monthly selon la fenêtre) avec
 * shares et TTM FCF (Finnhub quarterly + split-adjusté). Cache earnings-based
 * (réutilise le même mécanisme que /api/timeseries).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { getPfcfHistory } from '../services/pfcfHistory.js';
import { getNextEarningsDate, ttlUntilNextEarnings } from '../services/earnings.js';
import * as cache from '../lib/timeseriesCache.js';

export const pfcfHistoryRouter: Router = Router();

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);
const YearsSchema = z.coerce.number().int().min(1).max(50).default(5);

pfcfHistoryRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
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
  // On stocke dans le même cache que timeseries en utilisant un "metric" virtuel "pfcf-history"
  const key = cache.cacheKey(ticker, 'pfcf-history', 'computed', years);

  // 1. Cache hit ?
  const hit = cache.get(key);
  if (hit) {
    res.json({
      ticker,
      years,
      // points sont stockés en TimeseriesPoint mais on les présente en {date, pfcf} pour le client
      points: hit.points.map(p => ({ date: p.date, pfcf: p.value })),
      cached: true,
      ageMs: Date.now() - hit.storedAt,
    });
    return;
  }

  // 2. Fetch + compute
  const startedAt = Date.now();
  const earningsPromise = getNextEarningsDate(ticker);
  const points = await getPfcfHistory(ticker, years);
  const elapsedMs = Date.now() - startedAt;

  // 3. TTL basé sur le prochain earnings — un nouveau Q recalcule TTM_FCF
  const nextEarnings = await earningsPromise;
  const ttlMs = ttlUntilNextEarnings(nextEarnings);
  // Adaptation au cache typé TimeseriesPoint : on stocke pfcf dans value
  cache.set(
    key,
    points.map(p => ({ date: p.date, value: p.pfcf })),
    'finnhub', // source virtuelle, juste pour les logs
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
