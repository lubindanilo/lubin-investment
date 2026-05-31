/**
 * Screener — veille quantitative automatique de l'univers des actions.
 *
 * Principe :
 *   1. seed : ingère la liste des tickers d'un/des exchange(s) dans ScreenerTicker (pending).
 *   2. tick : pioche les N tickers "dus" (jamais notés, ou earnings atteint) et calcule
 *      leur note /10 (quanti only, via buildAndCacheQuantSnapshot). Appelé en boucle par
 *      un cron (GitHub Actions) sous la limite Finnhub.
 *   3. top  : lit les meilleures notes pour la vue screener (tri instantané, indexé).
 *
 * Cadence de fraîcheur = la date du prochain earnings : tant qu'elle est future, le score
 * reste en cache ; dès qu'elle est atteinte, le ticker redevient "dû" et est re-noté
 * (ce qui récupère la nouvelle date). Fallback TTL pour les dates inconnues.
 */
import { prisma } from '../db/client.js';
import { getStockSymbols } from './finnhub.js';
import { buildAndCacheQuantSnapshot } from './scoreSnapshot.js';
import { getSparkSeries } from './priceSeries.js';
import { EU_LARGE_CAPS } from '../data/euLargeCaps.js';

/**
 * Couverture progressive : US d'abord (priority 0), puis EU (1).
 * US : liste Finnhub (filtrée bourses primaires). EU : liste curée (Finnhub free ne fournit
 * pas les symboles hors US), scorée via le fallback Yahoo.
 */
const US_PRIORITY = 0;
const EU_PRIORITY = 1;

/** Types Finnhub qu'on garde (on écarte ETF, warrants, droits, fonds, etc.). */
const KEPT_TYPES = new Set(['Common Stock', 'ADR', 'REIT', '']);
/** Symbole compatible avec le reste de l'app (TickerSchema). */
const VALID_SYMBOL = /^[A-Z.\-]{1,8}$/;
/**
 * Bourses US "réelles" : Nasdaq (XNAS), NYSE (XNYS), NYSE American/AMEX (XASE).
 * On EXCLUT l'OTC/pink-sheets (OOTC) — ~17 600 tickers obscurs souvent sans données,
 * qui gaspillent les cycles et polluent les résultats (faux 10/10 sur données fantômes).
 * Les vraies ADR de sociétés étrangères restent couvertes par le seed EU (bourse d'origine).
 */
const US_PRIMARY_MICS = new Set(['XNAS', 'XNYS', 'XASE']);

const MAX_ATTEMPTS = 5;
const RESCORE_TTL_MS = 90 * 24 * 3600 * 1000; // re-note les dates inconnues tous les 90j

export interface SeedResult { region: string; fetched: number; inserted: number }

type SeedRow = { ticker: string; exchange: string | null; name: string | null; currency: string | null; region: string; priority: number };

/** Insère les lignes en lot, idempotent (skipDuplicates : préserve les déjà notées). */
async function insertRows(region: string, rows: SeedRow[]): Promise<number> {
  let inserted = 0;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await prisma.screenerTicker.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    inserted += res.count;
  }
  console.log(`[screener seed ${region}] ${rows.length} tickers valides → ${inserted} nouveaux insérés`);
  return inserted;
}

/** Ingère l'univers d'une région dans la file. US = Finnhub (bourses primaires), EU = liste curée. */
export async function seedRegion(region: string): Promise<SeedResult> {
  if (region === 'US') return seedUs();
  if (region === 'EU') return seedEu();
  throw new Error(`Région inconnue : ${region} (dispo : US, EU)`);
}

/** US : liste Finnhub /stock/symbol?exchange=US, filtrée aux bourses primaires (pas d'OTC). */
async function seedUs(): Promise<SeedResult> {
  const symbols = await getStockSymbols('US').catch(() => [] as Awaited<ReturnType<typeof getStockSymbols>>);
  const rows: SeedRow[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    const ticker = (s.symbol ?? '').toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    if (!VALID_SYMBOL.test(ticker)) continue;
    if (!KEPT_TYPES.has(s.type ?? '')) continue;
    if (!US_PRIMARY_MICS.has(s.mic ?? '')) continue; // pas d'OTC/pink-sheets
    seen.add(ticker);
    rows.push({ ticker, exchange: s.mic ?? 'US', name: s.description ?? null, currency: s.currency ?? null, region: 'US', priority: US_PRIORITY });
  }
  return { region: 'US', fetched: rows.length, inserted: await insertRows('US', rows) };
}

/** EU : liste curée des grandes capitalisations (Finnhub free ne liste pas l'EU). */
async function seedEu(): Promise<SeedResult> {
  const seen = new Set<string>();
  const rows: SeedRow[] = [];
  for (const raw of EU_LARGE_CAPS) {
    const ticker = raw.toUpperCase();
    if (seen.has(ticker) || !VALID_SYMBOL.test(ticker)) continue;
    seen.add(ticker);
    const ex = ticker.includes('.') ? ticker.slice(ticker.lastIndexOf('.') + 1) : null;
    rows.push({ ticker, exchange: ex, name: null, currency: null, region: 'EU', priority: EU_PRIORITY });
  }
  return { region: 'EU', fetched: rows.length, inserted: await insertRows('EU', rows) };
}

/** Sélectionne les prochains tickers à (re)noter, par priorité de région puis ancienneté. */
async function pickDueTickers(limit: number): Promise<{ ticker: string }[]> {
  const today = new Date().toISOString().slice(0, 10);
  const ttlCutoff = new Date(Date.now() - RESCORE_TTL_MS);
  return prisma.screenerTicker.findMany({
    where: {
      OR: [
        { status: 'pending' },
        // earnings atteint → re-note (récupère la nouvelle date au passage)
        { status: 'scored', nextEarningsDate: { lte: today } },
        // date inconnue → re-note après le TTL pour ne pas geler éternellement
        { status: 'scored', nextEarningsDate: null, lastScoredAt: { lt: ttlCutoff } },
        // erreurs transitoires : on retente jusqu'à MAX_ATTEMPTS
        { status: 'error', attempts: { lt: MAX_ATTEMPTS } },
      ],
    },
    orderBy: [{ priority: 'asc' }, { lastScoredAt: { sort: 'asc', nulls: 'first' } }],
    take: limit,
    select: { ticker: true },
  });
}

type ScoreOutcome = 'scored' | 'nodata' | 'error';

/** Note un ticker (quanti only) et met à jour sa ligne ScreenerTicker. */
async function scoreOne(ticker: string): Promise<ScoreOutcome> {
  try {
    const snap = await buildAndCacheQuantSnapshot(ticker, { includeEarnings: true });
    const hasScore = snap.scoreChiffresMax > 0;
    const status: ScoreOutcome = snap.fundamentalsAvailable && hasScore ? 'scored' : 'nodata';
    // Sparkline 1 an pour les titres notés (non bloquant si Yahoo échoue → []).
    const spark = hasScore ? await getSparkSeries(ticker).catch(() => []) : [];
    await prisma.screenerTicker.update({
      where: { ticker },
      data: {
        status,
        name: snap.company,
        currency: snap.currency,
        fundamentalsSource: snap.fundamentalsSource,
        scoreChiffres: hasScore ? snap.scoreChiffres : null,
        scoreChiffresMax: hasScore ? snap.scoreChiffresMax : null,
        scoreRatio: hasScore ? snap.scoreChiffres / snap.scoreChiffresMax : null,
        pfcfTTM: snap.metrics.pfcfTTM ?? null,
        sector: snap.sector ?? null,
        price: snap.metrics.price ?? null,
        dayChangePct: snap.dayChangePct ?? null,
        spark: spark.length >= 2 ? spark : undefined,
        nextEarningsDate: snap.nextEarningsDate ?? null,
        lastScoredAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    return status;
  } catch (e) {
    console.warn(`[screener score ${ticker}] échec : ${(e as Error).message}`);
    await prisma.screenerTicker.update({
      where: { ticker },
      data: { status: 'error', attempts: { increment: 1 }, lastScoredAt: new Date() },
    }).catch(() => {});
    return 'error';
  }
}

export interface TickResult { picked: number; scored: number; nodata: number; error: number; elapsedMs: number }

/**
 * Traite un lot de tickers dus. Séquentiel (le finnhubLimiter gère la concurrence interne
 * à chaque ticker) avec un budget de temps pour tenir sous la durée max du lambda.
 */
export async function tick(limit: number, softDeadlineMs = 25_000): Promise<TickResult> {
  const start = Date.now();
  const due = await pickDueTickers(limit);
  let scored = 0, nodata = 0, error = 0;
  for (const t of due) {
    if (Date.now() - start > softDeadlineMs) break;
    const r = await scoreOne(t.ticker);
    if (r === 'scored') scored++; else if (r === 'nodata') nodata++; else error++;
  }
  const elapsedMs = Date.now() - start;
  console.log(`[screener tick] picked=${due.length} scored=${scored} nodata=${nodata} error=${error} in ${elapsedMs}ms`);
  return { picked: due.length, scored, nodata, error, elapsedMs };
}

export interface TopRow {
  ticker: string;
  name: string | null;
  scoreChiffres: number | null;
  scoreChiffresMax: number | null;
  pfcfTTM: number | null;
  currency: string | null;
  nextEarningsDate: string | null;
  sector: string | null;
  price: number | null;
  dayChangePct: number | null;
  spark: number[] | null;
}

/** Meilleures notes pour la vue screener. Tri par ratio décroissant, indexé. */
export async function getTop(opts: { minRatio?: number; maxPfcf?: number; minMax?: number; limit?: number } = {}): Promise<TopRow[]> {
  const { minRatio = 0, maxPfcf, minMax = 8, limit = 100 } = opts;
  return prisma.screenerTicker.findMany({
    where: {
      status: 'scored',
      scoreChiffresMax: { gte: minMax },       // dénominateur significatif (évite 2/2 = 100%)
      scoreRatio: { gte: minRatio },
      ...(maxPfcf != null ? { pfcfTTM: { gt: 0, lte: maxPfcf } } : {}),
    },
    orderBy: [{ scoreRatio: 'desc' }, { scoreChiffresMax: 'desc' }],
    take: Math.min(limit, 500),
    select: {
      ticker: true, name: true, scoreChiffres: true, scoreChiffresMax: true,
      pfcfTTM: true, currency: true, nextEarningsDate: true,
      sector: true, price: true, dayChangePct: true, spark: true,
    },
  }) as Promise<TopRow[]>;
}

/** Compteurs de progression de la veille. */
export async function getStats(): Promise<{ pending: number; scored: number; nodata: number; error: number; total: number }> {
  const grouped = await prisma.screenerTicker.groupBy({ by: ['status'], _count: { _all: true } });
  const out = { pending: 0, scored: 0, nodata: 0, error: 0, total: 0 };
  for (const g of grouped) {
    const c = g._count._all;
    if (g.status === 'pending' || g.status === 'scored' || g.status === 'nodata' || g.status === 'error') {
      out[g.status] = c;
    }
    out.total += c;
  }
  return out;
}
