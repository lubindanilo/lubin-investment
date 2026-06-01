/**
 * GET /api/price-history?ticker=X&years=N&interval=1d|1wk|1mo
 *   → renvoie [{ date, value }, ...] des prix close ajustés (split + dividend)
 *
 * Utilité : pour les tickers que TradingView ne sait pas afficher sans préfixe d'exchange
 * (ex SIX:COPN, XPAR:MC), on bypass TV et on dessine un Recharts LineChart maison
 * avec les vrais prix Yahoo. Yahoo /v8/finance/chart donne 20-30 ans de prix EU gratuit.
 *
 * Cache 6h — les prix changent quotidiennement mais on n'a pas besoin de granularité
 * intra-day pour un graphique long terme.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { resolveYahooTicker } from '../services/yahooResolve.js';
import { yahooLimiter } from '../lib/limiter.js';

export const priceHistoryRouter: Router = Router();

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-]{1,15}$/);
const YearsSchema = z.coerce.number().int().min(1).max(50).default(5);
const IntervalSchema = z.enum(['1d', '1wk', '1mo']).default('1mo');

interface CacheEntry { points: { date: string; value: number }[]; symbol: string; currency: string; cachedAt: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Lubin-Investment/0.1';

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      meta?: { currency?: string };
      indicators?: {
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
    error?: { description?: string } | null;
  };
}

priceHistoryRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const t = TickerSchema.safeParse(req.query.ticker);
  const y = YearsSchema.safeParse(req.query.years ?? '5');
  const i = IntervalSchema.safeParse(req.query.interval ?? '1mo');
  if (!t.success || !y.success || !i.success) {
    throw new ApiError(400, 'Paramètres invalides', {
      ticker: t.success ? 'ok' : 'invalid',
      years: y.success ? 'ok' : 'invalid (1-50)',
      interval: i.success ? 'ok' : 'invalid (1d | 1wk | 1mo)',
    });
  }
  const ticker = t.data;
  const years = y.data;
  const interval = i.data;

  const cacheKey = `${ticker}|${years}|${interval}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    res.json({
      ticker,
      symbol: hit.symbol,
      currency: hit.currency,
      years,
      interval,
      points: hit.points,
      cached: true,
      ageMs: Date.now() - hit.cachedAt,
    });
    return;
  }

  // Résolution Yahoo (cache 24h interne) — gère les suffixes EU automatiquement
  const resolved = await resolveYahooTicker(ticker);
  if (!resolved) {
    throw new ApiError(404, `Ticker ${ticker} introuvable sur Yahoo`);
  }

  const points = await fetchYahooPrices(resolved.symbol, years, interval);
  cache.set(cacheKey, {
    points,
    symbol: resolved.symbol,
    currency: resolved.currency,
    cachedAt: Date.now(),
  });

  res.json({
    ticker,
    symbol: resolved.symbol,
    currency: resolved.currency,
    years,
    interval,
    points,
    cached: false,
  });
}));

/** Récupère prix close ajusté (split + dividend) depuis Yahoo /v8/finance/chart. */
async function fetchYahooPrices(symbol: string, years: number, interval: string): Promise<{ date: string; value: number }[]> {
  return yahooLimiter.schedule(async () => {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - Math.ceil(years * 365.25) * 24 * 3600;
    const url = `${CHART_BASE}/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=history`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);
    const data = (await res.json()) as YahooChart;
    if (data.chart?.error) throw new Error(data.chart.error.description ?? 'Yahoo chart error');
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.adjclose?.[0]?.adjclose
                 ?? result?.indicators?.quote?.[0]?.close
                 ?? [];
    const points: { date: string; value: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const v = closes[i];
      if (typeof ts !== 'number' || typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      points.push({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        value: v,
      });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return points;
  });
}
