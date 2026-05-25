/**
 * Service Yahoo Finance — source brute pour l'historique du nombre d'actions.
 *
 * Endpoints utilisés (free, server-side uniquement) :
 *   - https://fc.yahoo.com  → cookies de session (best effort)
 *   - https://query1.finance.yahoo.com/v1/test/getcrumb  → crumb token
 *   - https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}
 *       ?type=annualDilutedAverageShares,annualOrdinarySharesNumber&period1=…&period2=…&crumb=…
 *
 * ⚠ Yahoo a vidé `quoteSummary.incomeStatementHistory.dilutedAverageShares` (tout null).
 * Le bon endpoint pour les séries historiques est `fundamentals-timeseries`.
 *
 * Si Yahoo échoue (cookie/crumb/parsing) → on retourne null et le caller fallback
 * sur la dérivation Finnhub (revenueGrowth5Y vs revenueShareGrowth5Y).
 */
import { yahooLimiter } from '../lib/limiter.js';
import { fetchSplitEvents, cumulativeSplitFactor } from './yahooSplits.js';

const TIMESERIES_BASE = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
const CRUMB_URL = 'https://query1.finance.yahoo.com/v1/test/getcrumb';
const SESSION_URL = 'https://fc.yahoo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Lubin-Investment/0.1';
const CRUMB_TTL_MS = 60 * 60 * 1000;          // 1h

interface YahooSession { crumb: string; cookies: string; expiresAt: number }
let cachedSession: YahooSession | null = null;

async function fetchSession(): Promise<YahooSession> {
  // Étape 1 — session cookies (best effort)
  let cookies = '';
  try {
    const sessionRes = await fetch(SESSION_URL, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'manual',
    });
    const setCookies = sessionRes.headers.getSetCookie?.() ?? [];
    cookies = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  } catch (e) {
    console.warn('[yahoo session] cookies non récupérés —', (e as Error).message);
  }

  // Étape 2 — crumb
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'text/plain' };
  if (cookies) headers.Cookie = cookies;
  const crumbRes = await fetch(CRUMB_URL, { headers });
  if (!crumbRes.ok) throw new Error(`Yahoo crumb HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length > 64 || crumb.includes('<')) throw new Error('Yahoo : crumb invalide');

  return { crumb, cookies, expiresAt: Date.now() + CRUMB_TTL_MS };
}

async function getSession(): Promise<YahooSession> {
  if (cachedSession && Date.now() < cachedSession.expiresAt) return cachedSession;
  cachedSession = await fetchSession();
  console.log(`[yahoo] session refresh — crumb=${cachedSession.crumb.slice(0, 6)}…`);
  return cachedSession;
}

function invalidateSession() { cachedSession = null; }

interface TimeseriesValue {
  asOfDate?: string;
  reportedValue?: { raw?: number };
}
interface TimeseriesResult {
  meta?: { type?: string[]; symbol?: string[] };
  timestamp?: number[];
  // La clé exacte dépend du type demandé, on indexe dynamiquement par chaîne.
  [key: string]: unknown;
}
interface TimeseriesResponse {
  timeseries?: { result?: TimeseriesResult[]; error?: { description?: string } | null };
}

async function fetchTimeseries(ticker: string, types: string[]): Promise<TimeseriesResponse> {
  // 6 ans en arrière → couvre 5 années fiscales pleines
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 6 * 365 * 24 * 3600;
  const typeParam = types.join(',');

  const tryOnce = async (session: YahooSession): Promise<Response> => {
    const url = `${TIMESERIES_BASE}/${encodeURIComponent(ticker)}`
      + `?symbol=${encodeURIComponent(ticker)}`
      + `&type=${encodeURIComponent(typeParam)}`
      + `&period1=${period1}&period2=${period2}`
      + `&crumb=${encodeURIComponent(session.crumb)}`;
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
    if (session.cookies) headers.Cookie = session.cookies;
    return fetch(url, { headers });
  };

  let session = await getSession();
  let res = await tryOnce(session);
  if (res.status === 401 || res.status === 403) {
    invalidateSession();
    session = await getSession();
    res = await tryOnce(session);
  }
  if (!res.ok) throw new Error(`Yahoo timeseries HTTP ${res.status}`);
  return res.json() as Promise<TimeseriesResponse>;
}

/** Pour la dérivation CAGR annuelle (ne garde que l'année + valeurs strictement > 0). */
function extractSeries(response: TimeseriesResponse, type: string): { fiscalYear: number; date: string; value: number }[] {
  return extractSeriesFull(response, type)
    .filter(p => p.value > 0)
    .map(p => ({ fiscalYear: Number(p.date.slice(0, 4)), date: p.date, value: p.value }))
    .filter(p => Number.isFinite(p.fiscalYear));
}

/** Pour l'UI histogramme — garde la date complète, accepte valeurs négatives ou nulles. */
function extractSeriesFull(response: TimeseriesResponse, type: string): { date: string; value: number }[] {
  const result = response.timeseries?.result?.find(r => r.meta?.type?.includes(type));
  const rows = (result?.[type] as TimeseriesValue[] | undefined) ?? [];
  return rows
    .map(row => {
      const date = row.asOfDate;
      const val = row.reportedValue?.raw;
      if (!date || typeof val !== 'number') return null;
      return { date, value: val };
    })
    .filter((x): x is { date: string; value: number } => x !== null);
}

export interface SharesHistoryPoint {
  fiscalYear: number;
  /** Préférence : actions diluées moyennes ; fallback : ordinary shares de fin d'année.
   *  Toujours en current-basis (split-adjusté) — peut être comparé d'une année à l'autre. */
  dilutedShares: number;
  /** Free cash flow annuel total (devise rapport). Null si Yahoo ne l'a pas pour cette année.
   *  FCF n'est PAS affecté par les splits (c'est un montant total, pas par action). */
  fcf: number | null;
}

/**
 * Renvoie l'historique des actions sur 4-5 ans, trié du plus ancien au plus récent.
 * Préfère `annualDilutedAverageShares` (moyenne pondérée diluée, métrique standard pour EPS) ;
 * fallback sur `annualOrdinarySharesNumber` (snapshot fin d'année).
 * Null si Yahoo plante ou ne renvoie pas assez de points.
 *
 * IMPORTANT — split adjustment :
 *   Yahoo renvoie les share counts as-filed (= avec le nombre d'actions exact à la date
 *   du reporting, AVANT splits ultérieurs). Pour comparer 2020 à 2025, il faut tout
 *   ramener à la même base ("current-basis"). On fetch en parallèle les événements
 *   split du ticker et on multiplie chaque point historique par le facteur cumulatif.
 *   Sans ça, BKNG (split 10:1 en mai 2024) afficherait une dilution fictive de +50%/an.
 */
export async function getSharesHistory(ticker: string): Promise<SharesHistoryPoint[] | null> {
  return yahooLimiter.schedule(async () => {
    try {
      // Parallélise : la fenêtre timeseries (shares + FCF) et la liste des splits sont indépendantes.
      // On embarque FCF directement ici pour pouvoir calculer un fcfPerShareCagr split-adjusté
      // sans relancer un appel Yahoo séparé (et sans dépendre de Finnhub epsGrowth5Y qui peut
      // ne pas avoir absorbé un split récent).
      const [data, splits] = await Promise.all([
        fetchTimeseries(ticker, ['annualDilutedAverageShares', 'annualOrdinarySharesNumber', 'annualFreeCashFlow']),
        fetchSplitEvents(ticker),
      ]);
      if (data.timeseries?.error) {
        console.warn(`[yahoo ${ticker}]`, data.timeseries.error.description);
        return null;
      }

      const diluted = extractSeries(data, 'annualDilutedAverageShares');
      const ordinary = extractSeries(data, 'annualOrdinarySharesNumber');
      const fcfSeries = extractSeries(data, 'annualFreeCashFlow');
      const series = diluted.length >= 2 ? diluted : ordinary;
      const source = diluted.length >= 2 ? 'diluted' : 'ordinary';

      if (series.length < 2) {
        console.log(`[yahoo ${ticker}] < 2 points (diluted=${diluted.length}, ordinary=${ordinary.length}) — fallback Finnhub`);
        return null;
      }

      // Index FCF par année pour join O(1)
      const fcfByYear: Record<number, number> = {};
      for (const p of fcfSeries) fcfByYear[p.fiscalYear] = p.value;

      const points: SharesHistoryPoint[] = series
        .map(s => {
          const asOfTs = Math.floor(new Date(s.date + 'T00:00:00Z').getTime() / 1000);
          const factor = cumulativeSplitFactor(splits, asOfTs);
          return {
            fiscalYear: s.fiscalYear,
            dilutedShares: s.value * factor,
            fcf: fcfByYear[s.fiscalYear] ?? null,
          };
        })
        .sort((a, b) => a.fiscalYear - b.fiscalYear);

      const splitNote = splits.length > 0 ? ` [${splits.length} split-adj]` : '';
      const fcfNote = fcfSeries.length > 0 ? ` +FCF${fcfSeries.length}` : '';
      console.log(`[yahoo ${ticker}] ${points.length} années via ${source} (${points[0]!.fiscalYear} → ${points[points.length - 1]!.fiscalYear})${splitNote}${fcfNote}`);
      return points;
    } catch (e) {
      console.warn(`[yahoo ${ticker}] échec — fallback Finnhub :`, (e as Error).message);
      return null;
    }
  });
}

/** CAGR à partir de la série brute. Null si série trop courte ou aberrante. */
export function computeSharesCagr(history: SharesHistoryPoint[] | null): number | null {
  if (!history || history.length < 2) return null;
  const oldest = history[0]!;
  const newest = history[history.length - 1]!;
  const years = newest.fiscalYear - oldest.fiscalYear;
  if (years < 1 || oldest.dilutedShares <= 0) return null;
  return Math.pow(newest.dilutedShares / oldest.dilutedShares, 1 / years) - 1;
}

export interface FcfPerShareCagrResult {
  /** CAGR calculé. Null si non calculable ou anomalie détectée. */
  value: number | null;
  /** Raison spécifique quand value=null. */
  reason?: string;
}

/**
 * CAGR du FCF par action depuis l'historique Yahoo (split-adjusté).
 *
 * On calcule directement : fcfPerShare(année) = fcf / dilutedShares
 *                          CAGR = (fcfPerShare_newest / fcfPerShare_oldest)^(1/years) - 1
 *
 * Renvoie { value: null, reason: "..." } si :
 *   - moins de 2 points avec FCF + shares > 0 → "Historique FCF insuffisant"
 *   - les bornes ont un FCF négatif → "FCF négatif sur les bornes"
 *   - série trop courte → "Période < 1 an"
 *   - **dernière année anormalement basse** (drop > 60% vs médiane des 2-3 précédentes)
 *     → "Données Yahoo Y dubieuses : FCF a/b/c…" — pas de fallback caché, on alerte.
 */
export function computeFcfPerShareCagr(history: SharesHistoryPoint[] | null): FcfPerShareCagrResult {
  if (!history || history.length < 2) {
    return { value: null, reason: 'Historique FCF insuffisant' };
  }
  const valid = history.filter(p => p.fcf != null && p.fcf > 0 && p.dilutedShares > 0);
  if (valid.length < 2) {
    return { value: null, reason: 'Moins de 2 années avec FCF > 0' };
  }

  // Détection d'anomalie sur le dernier point : si le FCF de l'année N est < 40% de
  // la médiane des années N-3..N-1 valides, on suspecte une donnée partielle/preliminaire
  // (cas AMZN 2025 où Yahoo a renvoyé 7.7B vs ~32B les années précédentes). On bloque
  // au lieu d'inventer une CAGR aberrante (-51.9%/an).
  if (valid.length >= 3) {
    const last = valid[valid.length - 1]!;
    const prev = valid.slice(-4, -1).map(p => p.fcf!).filter(Boolean).sort((a, b) => a - b);
    const median = prev[Math.floor(prev.length / 2)];
    if (median != null && last.fcf! < median * 0.4) {
      return {
        value: null,
        reason: `Données Yahoo ${last.fiscalYear} suspectes (FCF ${(last.fcf! / 1e9).toFixed(1)}B vs médiane ${(median / 1e9).toFixed(1)}B sur les années précédentes — probable partial year)`,
      };
    }
  }

  const oldest = valid[0]!;
  const newest = valid[valid.length - 1]!;
  const years = newest.fiscalYear - oldest.fiscalYear;
  if (years < 1) return { value: null, reason: 'Période < 1 an entre bornes valides' };
  const fcfPsOld = oldest.fcf! / oldest.dilutedShares;
  const fcfPsNew = newest.fcf! / newest.dilutedShares;
  if (fcfPsOld <= 0 || fcfPsNew <= 0) {
    return { value: null, reason: 'FCF/action négatif sur une borne' };
  }
  return { value: Math.pow(fcfPsNew / fcfPsOld, 1 / years) - 1 };
}

// ═══════════════════════════════════════════════════════════════
// ── Séries temporelles trimestrielles (pour histogrammes UI) ────
// ═══════════════════════════════════════════════════════════════

export interface TimeseriesPoint {
  /** Date de fin de trimestre (YYYY-MM-DD) */
  date: string;
  /** Valeur du trimestre (devise locale pour montants, ratio pour marges, etc.) */
  value: number;
}

/**
 * Récupère une série temporelle trimestrielle Yahoo sur N années.
 * Renvoie [] si Yahoo répond mal. Cibles supportées (exemples) :
 *   - quarterlyTotalRevenue
 *   - quarterlyFreeCashFlow
 *   - quarterlyNetIncomeContinuousOperations
 *   - quarterlyOperatingMargin
 *   - quarterlyDilutedAverageShares
 *   - quarterlyBasicAverageShares
 *   - quarterlyTotalDebt
 *   - quarterlyCashAndCashEquivalents
 *   - etc. (cf. Yahoo doc fundamentals-timeseries)
 */
export async function getQuarterlyTimeseries(
  ticker: string,
  type: string,
  years: number,
): Promise<TimeseriesPoint[]> {
  // Validation simple — on n'accepte que des types qui commencent par "quarterly"
  // pour éviter les abus (l'endpoint Yahoo accepte aussi annual*, trailing*, etc.)
  if (!/^quarterly[A-Z]/.test(type)) return [];
  // Cap raisonnable : 50 ans (= "All")
  const safeYears = Math.max(1, Math.min(years, 50));

  // Les séries de share count sont as-filed (pré-split). Pour l'histogramme UI on doit
  // ajuster pour que la courbe ne montre PAS une marche d'escalier artificielle au split.
  const isShareCountSeries = /Shares?(Number|Outstanding|AverageShares)?$/.test(type)
    || /^quarterly(Basic|Diluted)Average?Shares/.test(type);

  return yahooLimiter.schedule(async () => {
    try {
      // Hack : fetchTimeseries calcule period1 = 6 ans en arrière par défaut, ce qui est
      // insuffisant pour 10Y/20Y/All. On passe par fetchTimeseriesCustomPeriod ci-dessous.
      // Parallélise les splits si on en a besoin.
      const [data, splits] = await Promise.all([
        fetchTimeseriesCustomPeriod(ticker, [type], safeYears + 1),
        isShareCountSeries ? fetchSplitEvents(ticker) : Promise.resolve([] as Awaited<ReturnType<typeof fetchSplitEvents>>),
      ]);
      if (data.timeseries?.error) {
        console.warn(`[yahoo ts ${ticker}/${type}]`, data.timeseries.error.description);
        return [];
      }
      const rawPoints = extractSeriesFull(data, type);
      const cutoffDate = new Date();
      cutoffDate.setFullYear(cutoffDate.getFullYear() - safeYears);
      const cutoffIso = cutoffDate.toISOString().slice(0, 10);

      const adjusted = rawPoints
        .filter(p => p.date >= cutoffIso)
        .map(p => {
          if (!isShareCountSeries || splits.length === 0) return p;
          const asOfTs = Math.floor(new Date(p.date + 'T00:00:00Z').getTime() / 1000);
          return { date: p.date, value: p.value * cumulativeSplitFactor(splits, asOfTs) };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

      const splitNote = isShareCountSeries && splits.length > 0 ? ` [${splits.length} split-adj]` : '';
      console.log(`[yahoo ts ${ticker}/${type}] ${adjusted.length} pts sur ${safeYears}Y${splitNote}`);
      return adjusted;
    } catch (e) {
      console.warn(`[yahoo ts ${ticker}/${type}] échec :`, (e as Error).message);
      return [];
    }
  });
}

// ─── Mapping high-level metric key (Finnhub-friendly) → Yahoo type ────────
// Permet d'utiliser la même clé (ex: 'revenue', 'fcf') quelle que soit la source.
const METRIC_TO_YAHOO: Record<string, string> = {
  revenue:         'quarterlyTotalRevenue',
  netIncome:       'quarterlyNetIncome',
  operatingIncome: 'quarterlyOperatingIncome',
  fcf:             'quarterlyFreeCashFlow',
  cfo:             'quarterlyOperatingCashFlow',
  capex:           'quarterlyCapitalExpenditure',
  shares:          'quarterlyDilutedAverageShares',
  totalDebt:       'quarterlyTotalDebt',
};

/**
 * Wrapper de haut niveau : prend une clé métier (revenue, fcf, …) et délègue
 * à Yahoo /fundamentals-timeseries via le mapping ci-dessus. Renvoie une liste
 * vide si la clé n'a pas d'équivalent Yahoo (caller doit fallback Finnhub).
 */
export async function getYahooMetricTimeseries(
  ticker: string,
  metricKey: string,
  years: number,
): Promise<TimeseriesPoint[]> {
  const yType = METRIC_TO_YAHOO[metricKey];
  if (!yType) return [];
  return getQuarterlyTimeseries(ticker, yType, years);
}

/** Variant de fetchTimeseries avec fenêtre configurable (jusqu'à 50 ans). */
async function fetchTimeseriesCustomPeriod(ticker: string, types: string[], years: number): Promise<TimeseriesResponse> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - years * 365 * 24 * 3600;
  const typeParam = types.join(',');

  const tryOnce = async (session: YahooSession): Promise<Response> => {
    const url = `${TIMESERIES_BASE}/${encodeURIComponent(ticker)}`
      + `?symbol=${encodeURIComponent(ticker)}`
      + `&type=${encodeURIComponent(typeParam)}`
      + `&period1=${period1}&period2=${period2}`
      + `&crumb=${encodeURIComponent(session.crumb)}`;
    const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
    if (session.cookies) headers.Cookie = session.cookies;
    return fetch(url, { headers });
  };

  let session = await getSession();
  let res = await tryOnce(session);
  if (res.status === 401 || res.status === 403) {
    invalidateSession();
    session = await getSession();
    res = await tryOnce(session);
  }
  if (!res.ok) throw new Error(`Yahoo timeseries HTTP ${res.status}`);
  return res.json() as Promise<TimeseriesResponse>;
}
