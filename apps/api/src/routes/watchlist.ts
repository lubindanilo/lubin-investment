import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { WatchlistEntry } from '@lubin/shared';
import { prisma } from '../db/client.js';
import { getQuote } from '../services/finnhub.js';
import { loadQuantData } from '../services/quantSnapshot.js';
import { buildQuantitativeCriteria } from '../services/derivedMetrics.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { watchlistMutateLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';

export const watchlistRouter: Router = Router();

// Toutes les routes ci-dessous nécessitent un user authentifié.
watchlistRouter.use(requireAuth);

const TickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z.\-]{1,8}$/);

/**
 * Construit le snapshot d'un ticker pour la watchlist.
 *
 * IMPORTANT — partage de loadQuantData avec /api/analyze :
 *   Les deux routes appellent EXACTEMENT le même `loadQuantData()` du service partagé.
 *   Conséquence : mêmes inputs → mêmes outputs → impossibilité mathématique de diverger
 *   sur le score chiffres ou le pfcfTTM. Fini le bug "BKNG 9/10 watchlist vs 10/10 analyze".
 *
 * Options : on skip news + earnings (pas affichés en watchlist) pour économiser 2 calls
 * Finnhub par snapshot rebuild.
 */
async function buildSnapshot(ticker: string): Promise<WatchlistEntry> {
  const data = await loadQuantData(ticker, { includeNews: false, includeEarnings: false, log: false });

  // Cas "Finnhub complètement vide ET Yahoo n'a pas pu résoudre" → emptyEntry-like
  if (!data.fundamentalsAvailable) {
    return {
      ticker,
      name: data.company,
      price: data.metrics.price,
      pfcfTTM: null,
      scoreChiffres: 0,
      scoreChiffresMax: 0,
      currency: data.currency,
      source: data.fundamentalsSource,
    };
  }

  const m = data.metrics;
  const quant = buildQuantitativeCriteria(m);
  // Pour le path Yahoo on filtre les N/A (pas tous les critères calculables sans Finnhub)
  // Pour le path Finnhub on garde tout (10 critères évalués).
  const evaluable = data.fundamentalsSource === 'yahoo'
    ? quant.filter(c => c.valeur !== 'N/A')
    : quant;
  const pass = evaluable.filter(c => c.statut === 'pass').length;
  const warn = evaluable.filter(c => c.statut === 'warn').length;

  // Champs internes pour le recompute P/FCF live à chaque GET (cf. enrichWithLivePrice).
  // - Path Finnhub : adjFcfTtm + sharesLatest viennent directement des fetchs raw.
  // - Path Yahoo : on déduit shares = marketCap / price et adjFcfTtm = marketCap / pfcfTTM
  //   depuis les valeurs déjà calculées par getYahooFundamentals.
  let adjFcfTtm: number | null = null;
  let sharesOutstanding: number | null = null;
  if (data.fundamentalsSource === 'finnhub' && data.rawFhFcfAdj && data.rawFhCapEmp) {
    adjFcfTtm = data.rawFhFcfAdj.ttmFcfAdj;
    sharesOutstanding = data.rawFhCapEmp.sharesLatest;
  } else if (data.fundamentalsSource === 'yahoo') {
    sharesOutstanding = (m.marketCap != null && m.price != null && m.price > 0)
      ? m.marketCap / m.price : null;
    adjFcfTtm = (m.marketCap != null && m.pfcfTTM != null && m.pfcfTTM > 0)
      ? m.marketCap / m.pfcfTTM : null;
  }

  return {
    ticker,
    name: data.company,
    price: m.price,
    pfcfTTM: m.pfcfTTM,
    scoreChiffres: pass + Math.round(warn * 0.5),
    scoreChiffresMax: evaluable.length,
    currency: data.currency,
    source: data.fundamentalsSource,
    adjFcfTtm,
    sharesOutstanding,
  };
}

const SNAPSHOT_FRESHNESS_MS = 30 * 60 * 1000;
/** Version actuelle du schéma de snapshot. Bump à chaque changement de structure pour
 *  forcer le re-fetch des snapshots stockés en DB (ils auront un schéma différent).
 *
 *  Actuel : score sur 10 chiffres (P/FCF sorti). Avant : score sur 11. */
const SNAPSHOT_SCHEMA_SCORE_MAX = 10;

/** Détecte les snapshots stockés avec un ancien schéma (avant un refactor). */
function hasOutdatedSchema(snap: WatchlistEntry | null): boolean {
  if (!snap || !snap.source || snap.scoreChiffresMax <= 0) return false;
  if (snap.scoreChiffresMax !== SNAPSHOT_SCHEMA_SCORE_MAX) return true;
  // adjFcfTtm + sharesOutstanding requis pour le live P/FCF — si absent, snapshot
  // pré-live-price → marquer obsolète pour qu'un rebuild les peuple.
  if (snap.adjFcfTtm === undefined || snap.sharesOutstanding === undefined) return true;
  return false;
}

function isFresh(refreshedAt: Date | null | undefined, snap: WatchlistEntry | null): boolean {
  if (!refreshedAt) return false;
  if (Date.now() - refreshedAt.getTime() >= SNAPSHOT_FRESHNESS_MS) return false;
  // Schema check : si le snap existant a un schéma obsolète, considéré stale même
  // si time-fresh — il faut le re-build pour avoir le nouveau format.
  if (hasOutdatedSchema(snap)) return false;
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

/**
 * Recalcule pfcfTTM en live = (price × sharesOutstanding) / adjFcfTtm.
 * `adjFcfTtm` et `sharesOutstanding` viennent du snapshot DB (quasi-statiques entre
 * earnings) ; `price` est fetché en temps réel via Finnhub /quote. Si quote échoue
 * ou si l'une des 2 valeurs statiques manque, on garde la valeur DB (stale acceptée).
 *
 * Coût : 1 appel /quote par ticker. Finnhub /quote = ~100-300 ms par appel,
 * parallélisé pour toute la watchlist via Promise.all + finnhubLimiter.
 */
async function enrichWithLivePrice(snapshots: WatchlistEntry[]): Promise<WatchlistEntry[]> {
  return Promise.all(
    snapshots.map(async snap => {
      if (!snap.source || snap.adjFcfTtm == null || snap.sharesOutstanding == null) {
        return snap; // pas assez d'info pour recompute, on garde la valeur DB
      }
      try {
        const q = await getQuote(snap.ticker);
        const livePrice = q?.c;
        if (!livePrice || livePrice <= 0) return snap;
        // pfcfTTM = (price × shares) / adjFcfTtm. adjFcfTtm est en USD bruts,
        // sharesOutstanding aussi (count), price en monnaie par action → mcap en monnaie brute.
        const livePfcf = (livePrice * snap.sharesOutstanding) / snap.adjFcfTtm;
        if (!Number.isFinite(livePfcf) || livePfcf <= 0) return snap;
        return { ...snap, price: livePrice, pfcfTTM: livePfcf };
      } catch {
        return snap; // quote a planté → snapshot DB inchangé
      }
    }),
  );
}

watchlistRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const entries = await prisma.watchlistEntry.findMany({
    where: { userId },
    orderBy: { addedAt: 'asc' },
  });
  // Snapshot DB = fast path. Pour le P/FCF qui dépend du prix temps réel, on
  // recalcule en live : fetch /quote en parallèle + (price × shares) / adjFcfTtm.
  // Si quote échoue ou snapshot incomplet → on tombe sur la valeur DB stale.
  const dbSnapshots: WatchlistEntry[] = entries.map(e => {
    const snap = (e.snapshot as WatchlistEntry | null) ?? null;
    return snap ?? emptyEntry(e.ticker);
  });
  const t0 = Date.now();
  const result = await enrichWithLivePrice(dbSnapshots);
  console.log(`[watchlist GET user=${userId.slice(0, 8)}] ${dbSnapshots.length} entries enriched live in ${Date.now() - t0}ms`);
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
