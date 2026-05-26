import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WatchlistEntry } from '@lubin/shared';
import { prisma } from '../db/client.js';
import { getMetric, getProfile2, getQuote } from '../services/finnhub.js';
import { computeAdjustedFcfTtm, computeCapitalEmployedSnapshot } from '../services/finnhubFundamentals.js';
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
 * IMPORTANT — cohérence avec /api/analyze :
 *   - On fetch adjFcfTtm + capitalEmployedSnapshot comme analyze.ts pour que le pfcfTTM
 *     affiché en watchlist soit le pfcfTTM SBC-AJUSTÉ (mcap / FCF_adj) et pas la valeur
 *     raw Finnhub (pfcfShareTTM, non ajustée). Sans ça, watchlist montrait 9.9 pour
 *     ADBE et analyze montrait 11.2 → divergence visible par l'utilisateur.
 *   - On détecte aussi le pattern ADR (Finnhub /financials-reported vide pour ASML/NSRGY)
 *     et on bascule sur Yahoo, comme analyze.ts.
 *
 * Stratégie :
 *   1. Finnhub d'abord (rapide, complet pour les US)
 *   2. Si Finnhub /financials-reported vide OU pas de quote → fallback Yahoo
 */
async function buildSnapshot(ticker: string): Promise<WatchlistEntry> {
  const [metric, profile, quote, fhFcfAdj, fhCapEmp] = await Promise.all([
    getMetric(ticker).catch(() => null),
    getProfile2(ticker).catch(() => null),
    getQuote(ticker).catch(() => null),
    computeAdjustedFcfTtm(ticker).catch(() => ({ ttmFcfAdj: null, ttmCfo: null, ttmSbc: null, ttmCapex: null, sbcShareOfFcf: null, asOf: null } as Awaited<ReturnType<typeof computeAdjustedFcfTtm>>)),
    computeCapitalEmployedSnapshot(ticker).catch(() => ({ totalAssets: null, currentLiabilities: null, goodwill: null, equity: null, totalDebt: null, totalCash: null, revenueTtm: null, excessCash: null, formulaUsed: null, capitalEmployed: null, asOf: null } as Awaited<ReturnType<typeof computeCapitalEmployedSnapshot>>)),
  ]);

  const metricEmpty = !metric || !metric.metric || Object.keys(metric.metric).length === 0;
  const hasPrice = !!quote?.c && quote.c > 0;
  const finnhubUsable = hasPrice || !metricEmpty;
  // ADR pattern : /stock/metric répond mais /financials-reported est vide → utiliser Yahoo
  const finnhubFinancialsEmpty = fhFcfAdj.ttmFcfAdj == null && fhCapEmp.capitalEmployed == null;

  if (finnhubUsable && !finnhubFinancialsEmpty) {
    // Path US standard : pfcfTTM est calculé par computeDerivedMetrics à partir de
    // adjFcfTtm (mcap × 1e6 / FCF_adj). Mêmes inputs que analyze.ts → mêmes outputs.
    const m = computeDerivedMetrics({
      metric, profile, quote,
      adjFcfTtm: fhFcfAdj.ttmFcfAdj,
      sbcShareOfFcf: fhFcfAdj.sbcShareOfFcf,
      capitalEmployed: fhCapEmp.capitalEmployed,
      capitalEmployedReason: fhCapEmp.reason,
      capitalEmployedFormula: fhCapEmp.formulaUsed,
    });
    const quant = buildQuantitativeCriteria(m);  // 10 chiffres (P/FCF est désormais à part)
    const pass = quant.filter(c => c.statut === 'pass').length;
    const warn = quant.filter(c => c.statut === 'warn').length;
    return {
      ticker,
      name: profile?.name ?? ticker,
      price: m.price,
      pfcfTTM: m.pfcfTTM,
      scoreChiffres: pass + Math.round(warn * 0.5),
      scoreChiffresMax: quant.length,  // 10
      currency: 'USD',
      source: 'finnhub',
    };
  }

  // Path Yahoo : EU purs (NESN.SW, MC.PA…) OU ADRs étrangers (ASML, NSRGY, TSM…)
  const resolved = await resolveYahooTicker(ticker).catch(() => null);
  if (resolved) {
    const yfund = await getYahooFundamentals(resolved.symbol, resolved.price, resolved.currency, resolved.longName ?? null).catch(() => null);
    if (yfund) {
      const quant = buildQuantitativeCriteria(yfund.metrics);
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
/** Version actuelle du schéma de snapshot. Bump à chaque changement de structure pour
 *  forcer le re-fetch des snapshots stockés en DB (ils auront un schéma différent).
 *
 *  Actuel : score sur 10 chiffres (P/FCF sorti). Avant : score sur 11. */
const SNAPSHOT_SCHEMA_SCORE_MAX = 10;
function isFresh(refreshedAt: Date | null | undefined, snap: WatchlistEntry | null): boolean {
  if (!refreshedAt) return false;
  if (Date.now() - refreshedAt.getTime() >= SNAPSHOT_FRESHNESS_MS) return false;
  // Schema check : si le snap existant a un scoreChiffresMax différent de la version
  // actuelle (et que la source est connue, donc c'est un vrai snapshot pas un fallback
  // vide), on le considère comme stale pour forcer un re-build avec le nouveau format.
  if (snap && snap.source && snap.scoreChiffresMax !== SNAPSHOT_SCHEMA_SCORE_MAX && snap.scoreChiffresMax > 0) {
    return false;
  }
  return true;
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
      const existing = (e.snapshot as WatchlistEntry | null);
      const fallback = existing ?? emptyEntry(e.ticker);
      if (!force && isFresh(e.refreshedAt, existing)) return fallback;
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
