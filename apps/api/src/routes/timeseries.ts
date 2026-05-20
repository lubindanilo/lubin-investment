/**
 * GET /api/timeseries?ticker=FI&metric=revenue&freq=quarterly&years=5
 *   → renvoie { ticker, metric, freq, years, points: [{date, value}, ...], source, cached }
 *
 * `metric`  : clé haut-niveau ('revenue', 'netIncome', 'fcf', 'shares', 'totalDebt', etc.)
 * `freq`    : 'quarterly' (défaut) ou 'annual'
 * `years`   : 1, 5, 10, 20, 50 ('All')
 *
 * Stratégie source :
 *   • years ≤ 10 → Yahoo /fundamentals-timeseries (rapide, ~500 KB)
 *                  Fallback Finnhub si Yahoo renvoie < 4 points
 *   • years > 10 → Finnhub /stock/financials-reported direct (historique plus profond)
 *
 * Cache :
 *   • TTL ≈ prochaine date d'earnings du ticker + 1 jour (typique 2-3 mois)
 *   • Fallback 24 h si date d'earnings inconnue
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { getReportedTimeseries, METRICS, type MetricKey } from '../services/finnhubFundamentals.js';
import { getYahooMetricTimeseries } from '../services/yahoo.js';
import { resolveYahooTicker } from '../services/yahooResolve.js';
import { getNextEarningsDate, ttlUntilNextEarnings } from '../services/earnings.js';
import * as cache from '../lib/timeseriesCache.js';

export const timeseriesRouter: Router = Router();

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);
const MetricSchema = z.string().refine((v): v is MetricKey => v in METRICS, { message: 'metric inconnu' });
const FreqSchema = z.enum(['quarterly', 'annual']).default('quarterly');
const YearsSchema = z.coerce.number().int().min(1).max(50).default(5);

/**
 * Yahoo /fundamentals-timeseries plafonne à ~5 points quarterly quelle que soit
 * la fenêtre demandée. Donc utile uniquement pour 1Y quarterly (où on attend 4 pts).
 * Au-delà, on tape Finnhub directement (qui a 10-15 ans d'historique).
 */
const YAHOO_MAX_YEARS_QUARTERLY = 1;

/** Calcule le nombre minimum de points attendus pour valider la source */
function minPointsExpected(freq: 'quarterly' | 'annual', years: number): number {
  if (freq === 'quarterly') return Math.max(Math.floor(years * 3), 3); // 3 trimestres/an minimum
  return Math.max(years - 1, 2);
}

timeseriesRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const t = TickerSchema.safeParse(req.query.ticker);
  const m = MetricSchema.safeParse(req.query.metric);
  const f = FreqSchema.safeParse(req.query.freq ?? 'quarterly');
  const y = YearsSchema.safeParse(req.query.years ?? '5');
  if (!t.success || !m.success || !f.success || !y.success) {
    throw new ApiError(400, 'Paramètres invalides', {
      ticker: t.success ? 'ok' : 'invalid',
      metric: m.success ? 'ok' : `invalid (valeurs possibles : ${Object.keys(METRICS).join(', ')})`,
      freq: f.success ? 'ok' : 'invalid (quarterly | annual)',
      years: y.success ? 'ok' : 'invalid (1-50)',
    });
  }
  const ticker = t.data;
  const metric = m.data;
  const requestedFreq = f.data;
  const years = y.data;

  // ─── 1. Résout le ticker pour décider de la source ─────────────
  // Optimisation : on tape le cache de resolveYahooTicker (24h) — pas un nouvel appel
  // sauf si premier hit pour ce ticker.
  const resolved = await resolveYahooTicker(ticker).catch(() => null);
  const isEuTicker = !!resolved && resolved.symbol !== ticker;

  // Pour les tickers EU, Yahoo n'expose QUE l'annuel (4 ans max) — pas de quarterly.
  // On override le freq demandé par le client pour ne pas servir des séries vides.
  const effectiveFreq: 'quarterly' | 'annual' = isEuTicker ? 'annual' : requestedFreq;
  const effectiveYears = isEuTicker ? Math.max(years, 4) : years;
  const key = cache.cacheKey(ticker, metric, effectiveFreq, effectiveYears);

  // ─── 2. Cache hit ? ────────────────────────────────────────────
  const hit = cache.get(key);
  if (hit) {
    res.json({
      ticker,
      metric,
      freq: effectiveFreq,
      years: effectiveYears,
      points: hit.points,
      source: hit.source,
      cached: true,
      ageMs: Date.now() - hit.storedAt,
      euAnnualOnly: isEuTicker,
    });
    return;
  }

  // ─── 3. Cache miss : on fetch + on calcule le TTL en parallèle ──
  const earningsPromise = getNextEarningsDate(ticker);
  const startedAt = Date.now();

  // Décide la source :
  //   • EU ticker            → Yahoo annual (seule donnée dispo)
  //   • US quarterly 1Y      → Yahoo (rapide, exact, 4 pts)
  //   • US tout le reste     → Finnhub
  let points = [] as Awaited<ReturnType<typeof getReportedTimeseries>>;
  let source: 'yahoo' | 'finnhub' = 'finnhub';
  const minPoints = minPointsExpected(effectiveFreq, effectiveYears);

  if (isEuTicker) {
    // Yahoo annual via le symbol résolu. Le mapping METRIC_TO_YAHOO pointe sur quarterly*,
    // on doit donc taper directement le type annuel correspondant.
    const annualType = mapMetricToYahooAnnual(metric);
    if (annualType && resolved) {
      const { getQuarterlyTimeseries } = await import('../services/yahoo.js');
      // getQuarterlyTimeseries valide que le type commence par "quarterly" → on contourne
      // en utilisant le helper de bas niveau via le mapping annuel.
      points = await fetchYahooAnnual(resolved.symbol, annualType, effectiveYears);
      // getQuarterlyTimeseries n'est utilisé que comme fallback si on a besoin de partage de code
      void getQuarterlyTimeseries;
      source = 'yahoo';
    }
  } else {
    const useYahooPrimary = requestedFreq === 'quarterly' && years <= YAHOO_MAX_YEARS_QUARTERLY;
    if (useYahooPrimary) {
      points = await getYahooMetricTimeseries(ticker, metric, years);
      source = 'yahoo';
      if (points.length < minPoints) {
        console.log(`[timeseries ${ticker}/${metric}] Yahoo a renvoyé ${points.length} pts (< ${minPoints} attendus) → fallback Finnhub`);
        points = await getReportedTimeseries(ticker, metric, requestedFreq, years);
        source = 'finnhub';
      }
    } else {
      points = await getReportedTimeseries(ticker, metric, requestedFreq, years);
      source = 'finnhub';
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[timeseries ${ticker}/${metric}] ${source}${isEuTicker ? '/EU' : ''} OK ${points.length} pts en ${elapsedMs}ms`);

  // ─── 4. Calcule le TTL basé sur les earnings ───────────────────
  const nextEarnings = await earningsPromise.catch(() => null);
  const ttlMs = ttlUntilNextEarnings(nextEarnings);
  cache.set(key, points, source, ttlMs);

  res.json({
    ticker,
    metric,
    freq: effectiveFreq,
    years: effectiveYears,
    points,
    source,
    cached: false,
    fetchedInMs: elapsedMs,
    cacheTtlHours: Math.round(ttlMs / 3_600_000),
    nextEarnings,
    euAnnualOnly: isEuTicker,
  });
}));

/** Mappe une clé high-level (revenue, fcf…) vers le type annuel Yahoo équivalent. */
function mapMetricToYahooAnnual(metric: MetricKey): string | null {
  const map: Record<string, string> = {
    revenue:         'annualTotalRevenue',
    netIncome:       'annualNetIncome',
    operatingIncome: 'annualOperatingIncome',
    fcf:             'annualFreeCashFlow',
    cfo:             'annualOperatingCashFlow',
    capex:           'annualCapitalExpenditure',
    shares:          'annualDilutedAverageShares',
    totalDebt:       'annualTotalDebt',
  };
  return map[metric] ?? null;
}

/**
 * Helper bas niveau pour fetch un type annuel Yahoo sur un symbol arbitraire (ex "COPN.SW").
 * Distinct de getQuarterlyTimeseries qui n'accepte que les types "quarterly*" par sécurité.
 */
async function fetchYahooAnnual(
  symbol: string,
  type: string,
  years: number,
): Promise<Array<{ date: string; value: number }>> {
  const BASE = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Lubin-Investment/0.1';
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - Math.max(years + 1, 5) * 365 * 24 * 3600;
  const url = `${BASE}/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}&period1=${period1}&period2=${period2}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`[yahoo annual ${symbol}/${type}] HTTP ${res.status}`);
      return [];
    }
    const data = await res.json() as {
      timeseries?: { result?: Array<Record<string, unknown> & { meta?: { type?: string[] } }> }
    };
    const result = data.timeseries?.result?.find(r => r.meta?.type?.includes(type));
    const rows = (result?.[type] as Array<{ asOfDate?: string; reportedValue?: { raw?: number } }> | undefined) ?? [];
    return rows
      .map(row => {
        const date = row.asOfDate;
        const val = row.reportedValue?.raw;
        if (!date || typeof val !== 'number') return null;
        return { date, value: val };
      })
      .filter((x): x is { date: string; value: number } => x !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.warn(`[yahoo annual ${symbol}/${type}] échec :`, (e as Error).message);
    return [];
  }
}
