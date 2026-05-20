/**
 * Service Finnhub /calendar/earnings — récupère la fenêtre last & next earnings
 * d'une entreprise. Sert à 2 choses :
 *
 *   1. **Calage du TTL** du cache timeseries : le cache survit jusqu'au prochain rapport,
 *      puis se vide automatiquement pour reprendre les nouvelles données trimestrielles.
 *   2. **Affichage UI** : afficher les dates + EPS/revenue surprise dans l'AnalysePage.
 *
 * Endpoint Finnhub : `/calendar/earnings?symbol=X&from=...&to=...`
 *   - Gratuit, free tier OK
 *   - Renvoie symbol/date/hour/epsActual/epsEstimate/revenueActual/revenueEstimate/quarter/year
 *
 * Fenêtre : 100 jours en arrière + 100 jours en avant (≈ 1 trimestre passé + futur).
 * Cache interne 7 jours pour éviter de re-fetch chaque analyse.
 */
import type { EarningsInfo, EarningsResult } from '@lubin/shared';
import { finnhubLimiter } from '../lib/limiter.js';
import { fetchWithRetry } from '../lib/retry.js';

const BASE = 'https://finnhub.io/api/v1';
const TOKEN = process.env.FINNHUB_API_KEY ?? '';

interface FinnhubEarningsCalendar {
  earningsCalendar?: Array<{
    symbol: string;
    date: string;
    hour?: string;
    epsActual?: number | null;
    epsEstimate?: number | null;
    revenueActual?: number | null;
    revenueEstimate?: number | null;
    quarter?: number;
    year?: number;
  }>;
}

interface CachedEarnings { data: EarningsInfo; cachedAt: number }
const EARNINGS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const earningsCache = new Map<string, CachedEarnings>();

/** Convertit une entrée Finnhub brute en EarningsResult typé. */
function toResult(raw: NonNullable<FinnhubEarningsCalendar['earningsCalendar']>[number]): EarningsResult | null {
  if (!raw.date || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  const epsAct = raw.epsActual ?? null;
  const epsEst = raw.epsEstimate ?? null;
  const epsSurp = epsAct != null && epsEst != null ? epsAct - epsEst : null;
  const epsSurpPct = epsSurp != null && epsEst && epsEst !== 0 ? epsSurp / Math.abs(epsEst) : null;
  const revAct = raw.revenueActual ?? null;
  const revEst = raw.revenueEstimate ?? null;
  const revSurpPct = revAct != null && revEst && revEst !== 0 ? (revAct - revEst) / Math.abs(revEst) : null;
  return {
    date: raw.date,
    quarter: raw.quarter ?? 0,
    year: raw.year ?? Number(raw.date.slice(0, 4)),
    hour: raw.hour ?? null,
    epsActual: epsAct,
    epsEstimate: epsEst,
    epsSurprise: epsSurp,
    epsSurprisePct: epsSurpPct,
    revenueActual: revAct,
    revenueEstimate: revEst,
    revenueSurprisePct: revSurpPct,
  };
}

/**
 * Retourne les earnings { next, last } d'un ticker. Mémoïsé 7 jours.
 * Renvoie { next: null, last: null } si Finnhub est down ou ticker inconnu.
 */
export async function getEarningsInfo(ticker: string): Promise<EarningsInfo> {
  const cached = earningsCache.get(ticker);
  if (cached && Date.now() - cached.cachedAt < EARNINGS_CACHE_TTL) {
    return cached.data;
  }
  const empty: EarningsInfo = { next: null, last: null };
  if (!TOKEN) {
    earningsCache.set(ticker, { data: empty, cachedAt: Date.now() });
    return empty;
  }

  // Fenêtre : aujourd'hui ±100 jours
  const today = new Date();
  const from = new Date(today); from.setDate(from.getDate() - 100);
  const to   = new Date(today); to.setDate(to.getDate() + 100);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url = `${BASE}/calendar/earnings?symbol=${ticker}&from=${fmt(from)}&to=${fmt(to)}&token=${TOKEN}`;

  try {
    const data = await finnhubLimiter.schedule(async () => {
      const res = await fetchWithRetry(url, undefined, { label: `finnhub earnings ${ticker}`, attempts: 2 });
      return res.json() as Promise<FinnhubEarningsCalendar>;
    });
    const items = (data.earningsCalendar ?? [])
      .filter(e => e.symbol === ticker)
      .map(toResult)
      .filter((x): x is EarningsResult => x !== null);

    const todayIso = fmt(today);
    const past = items.filter(e => e.date < todayIso).sort((a, b) => b.date.localeCompare(a.date)); // récent → ancien
    const future = items.filter(e => e.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date)); // proche → lointain

    const result: EarningsInfo = {
      last: past[0] ?? null,
      next: future[0] ?? null,
    };
    earningsCache.set(ticker, { data: result, cachedAt: Date.now() });
    if (result.next) console.log(`[earnings ${ticker}] next=${result.next.date} last=${result.last?.date ?? 'n/a'}`);
    return result;
  } catch (e) {
    console.warn(`[earnings ${ticker}] échec :`, (e as Error).message);
    earningsCache.set(ticker, { data: empty, cachedAt: Date.now() });
    return empty;
  }
}

/** Wrapper rétro-compat : juste la date du prochain earnings (pour TTL cache timeseries). */
export async function getNextEarningsDate(ticker: string): Promise<string | null> {
  const info = await getEarningsInfo(ticker);
  return info.next?.date ?? null;
}

/** TTL en ms basé sur la prochaine date d'earnings. Fallback 24h. */
export function ttlUntilNextEarnings(nextDate: string | null): number {
  const FALLBACK = 24 * 60 * 60 * 1000;
  if (!nextDate) return FALLBACK;
  const nextTs = Date.parse(nextDate + 'T12:00:00Z');
  if (Number.isNaN(nextTs)) return FALLBACK;
  const ttl = (nextTs - Date.now()) + 24 * 60 * 60 * 1000;
  return Math.max(60 * 60 * 1000, Math.min(ttl, 100 * 24 * 60 * 60 * 1000));
}
