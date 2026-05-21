/**
 * yahooFundamentals — calcule les chiffres fondamentaux directement depuis
 * Yahoo /fundamentals-timeseries pour les tickers non couverts par Finnhub
 * (tickers européens essentiellement).
 *
 * Stratégie : fetch les séries annuelles brutes nécessaires en UN appel batch,
 * puis on calcule les ratios "à la main" (Yahoo n'expose pas de pre-computed
 * ratios comme Finnhub /stock/metric).
 *
 * Couvre 9/11 critères chiffrés :
 *   ✓ Rentable (marge nette)       = NI / Revenue
 *   ✓ Croissance CA 5Y             = CAGR(revenue) sur 5 ans
 *   ✓ Croissance FCF/action 5Y     = CAGR(FCF/shares) sur 5 ans (split-adj géré)
 *   ✓ Évolution actions 5Y         = déjà fait dans yahoo.ts
 *   ✓ Marge FCF                    = FCF TTM / Revenue TTM
 *   ✓ Operating leverage           = op margin TTM > moy 5Y
 *   ✓ Cash ROCE (proxy)            = FCF / (Equity + LT Debt)
 *   ✓ Dette nette / FCF            = (Total Debt - Cash) / TTM FCF
 *   ✓ Cash Conversion Rate         = FCF / Net Income
 *   ✗ BFR (current ratio annual)   = Current Assets / Current Liabilities (Yahoo l'a)
 *   ✓ P/FCF actuel                 = price × shares / TTM FCF
 *
 * Donc en fait 10/11 + le critère valorisation. SBC reste null (free tier, pas accessible).
 */
import { yahooLimiter } from '../lib/limiter.js';
import { fetchSplitEvents, cumulativeSplitFactor } from './yahooSplits.js';
import type { DerivedMetrics } from '@lubin/shared';

const TIMESERIES_BASE = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Lubin-Investment/0.1';

interface TimeseriesValue {
  asOfDate?: string;
  reportedValue?: { raw?: number };
}
interface TimeseriesResult {
  meta?: { type?: string[]; symbol?: string[] };
  [key: string]: unknown;
}
interface TimeseriesResponse {
  timeseries?: { result?: TimeseriesResult[]; error?: { description?: string } | null };
}

/** Récupère un batch de types annuels Yahoo en 1 requête. */
async function fetchBatch(symbol: string, types: string[]): Promise<TimeseriesResponse> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 7 * 365 * 24 * 3600; // 7 ans pour avoir 5 années pleines + buffer
  const url = `${TIMESERIES_BASE}/${encodeURIComponent(symbol)}`
    + `?symbol=${encodeURIComponent(symbol)}`
    + `&type=${encodeURIComponent(types.join(','))}`
    + `&period1=${period1}&period2=${period2}`;
  // Note : pour les tickers européens .SW/.PA/.DE, Yahoo n'exige PAS le crumb (contrairement au .com)
  // si on hit query1 directement. Si jamais ça change on bascule sur le path session-aware de yahoo.ts.
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo fundamentals HTTP ${res.status}`);
  return res.json() as Promise<TimeseriesResponse>;
}

function extract(response: TimeseriesResponse, type: string): { fiscalYear: number; date: string; value: number }[] {
  const result = response.timeseries?.result?.find(r => r.meta?.type?.includes(type));
  const rows = (result?.[type] as TimeseriesValue[] | undefined) ?? [];
  return rows
    .map(row => {
      const date = row.asOfDate;
      const val = row.reportedValue?.raw;
      if (!date || typeof val !== 'number') return null;
      return { fiscalYear: Number(date.slice(0, 4)), date, value: val };
    })
    .filter((x): x is { fiscalYear: number; date: string; value: number } => x !== null && Number.isFinite(x.fiscalYear))
    .sort((a, b) => a.fiscalYear - b.fiscalYear);
}

/** Helper : applique le split-adjust à une série de share counts (Yahoo as-filed → current-basis). */
function adjustSharesForSplits(shares: { fiscalYear: number; date: string; value: number }[], splits: Awaited<ReturnType<typeof fetchSplitEvents>>) {
  if (splits.length === 0) return shares;
  return shares.map(s => {
    const ts = Math.floor(new Date(s.date + 'T00:00:00Z').getTime() / 1000);
    return { ...s, value: s.value * cumulativeSplitFactor(splits, ts) };
  });
}

/** Helper : récupère la dernière valeur d'une série. */
function latest<T extends { fiscalYear: number; value: number }>(series: T[]): T | null {
  return series.length > 0 ? series[series.length - 1]! : null;
}

/** CAGR robuste : sur les bornes extrêmes d'une série, null si données invalides. */
function cagr<T extends { fiscalYear: number; value: number }>(series: T[]): number | null {
  if (series.length < 2) return null;
  const oldest = series[0]!;
  const newest = series[series.length - 1]!;
  const years = newest.fiscalYear - oldest.fiscalYear;
  if (years < 1 || oldest.value <= 0 || newest.value <= 0) return null;
  return Math.pow(newest.value / oldest.value, 1 / years) - 1;
}

/** Marge 5Y moyenne : moyenne(NI/Rev) sur les années où on a les deux. */
function avgMarginOver(ni: { fiscalYear: number; value: number }[], rev: { fiscalYear: number; value: number }[]): number | null {
  const revByYear: Record<number, number> = {};
  for (const r of rev) if (r.value > 0) revByYear[r.fiscalYear] = r.value;
  const margins: number[] = [];
  for (const n of ni) {
    const r = revByYear[n.fiscalYear];
    if (r && r > 0) margins.push(n.value / r);
  }
  if (margins.length === 0) return null;
  return margins.reduce((s, v) => s + v, 0) / margins.length;
}

interface YahooFundamentalsResult {
  metrics: DerivedMetrics;
  currency: string;
  companyName: string | null;
}

/**
 * Récupère + calcule tous les fondamentaux d'un ticker depuis Yahoo.
 *
 * @param yahooSymbol  Le symbol résolu (ex "COPN.SW", "ASML.AS", "AAPL")
 * @param price        Prix courant (déjà connu via resolveYahooTicker → évite un appel en plus)
 * @param currency     Devise (déjà connue via resolveYahooTicker)
 * @param companyName  Nom long (optionnel, pour métadonnées)
 */
export async function getYahooFundamentals(
  yahooSymbol: string,
  price: number,
  currency: string,
  companyName: string | null = null,
): Promise<YahooFundamentalsResult | null> {
  return yahooLimiter.schedule(async () => {
    try {
      // Batch : 1 seul appel Yahoo avec tous les types nécessaires
      const types = [
        'annualTotalRevenue',
        'annualNetIncome',
        'annualOperatingIncome',
        'annualFreeCashFlow',
        'annualTotalDebt',
        'annualCashAndCashEquivalents',
        'annualStockholdersEquity',
        'annualCurrentAssets',
        'annualCurrentLiabilities',
        'annualDilutedAverageShares',
        'annualOrdinarySharesNumber',
      ];
      const [data, splits] = await Promise.all([
        fetchBatch(yahooSymbol, types),
        fetchSplitEvents(yahooSymbol),
      ]);
      if (data.timeseries?.error) {
        console.warn(`[yahoo fund ${yahooSymbol}]`, data.timeseries.error.description);
        return null;
      }

      const revenue        = extract(data, 'annualTotalRevenue');
      const netIncome      = extract(data, 'annualNetIncome');
      const operatingInc   = extract(data, 'annualOperatingIncome');
      const fcf            = extract(data, 'annualFreeCashFlow');
      const totalDebt      = extract(data, 'annualTotalDebt');
      const cash           = extract(data, 'annualCashAndCashEquivalents');
      const equity         = extract(data, 'annualStockholdersEquity');
      const currentAssets  = extract(data, 'annualCurrentAssets');
      const currentLiab    = extract(data, 'annualCurrentLiabilities');
      const sharesDilutedRaw = extract(data, 'annualDilutedAverageShares');
      const sharesOrdinaryRaw = extract(data, 'annualOrdinarySharesNumber');
      const sharesRaw = sharesDilutedRaw.length >= 2 ? sharesDilutedRaw : sharesOrdinaryRaw;
      const shares = adjustSharesForSplits(sharesRaw, splits);

      const latestRev = latest(revenue);
      const latestNI = latest(netIncome);
      const latestShares = latest(shares);

      // Pour le P/FCF et les ratios dérivés du FCF, on prend la dernière année avec FCF > 0.
      // Pourquoi : Yahoo annual contient parfois une année récente avec FCF négatif (ex Cosmo
      // Pharma 2025) qui rendrait pfcfTTM = null alors que l'année N-1 a un FCF positif
      // significatif. Cohérence avec pfcfHistory.ts qui skip aussi les années FCF ≤ 0.
      // Pour les autres ratios (netMargin, fcfMargin, currentRatio…) on garde "latest" brut.
      const latestFcf = latest(fcf);                         // brut (peut être négatif)
      const latestPositiveFcf = latest(fcf.filter(p => p.value > 0)); // pour pfcfTTM uniquement

      // ─── Calcul des ratios ────────────────────────────────────────────

      // Marge nette = NI / Revenue (latest)
      const netMargin = (latestRev && latestNI && latestRev.value > 0)
        ? latestNI.value / latestRev.value
        : null;

      // Revenue CAGR 5Y
      const revenueCagr = cagr(revenue);

      // FCF/share CAGR (split-adjusté)
      let fcfPerShareCagr: number | null = null;
      if (fcf.length >= 2 && shares.length >= 2) {
        const fcfByYear: Record<number, number> = {};
        for (const f of fcf) fcfByYear[f.fiscalYear] = f.value;
        const fcfPsSeries = shares
          .filter(s => s.value > 0 && fcfByYear[s.fiscalYear] != null && fcfByYear[s.fiscalYear]! > 0)
          .map(s => ({ fiscalYear: s.fiscalYear, value: fcfByYear[s.fiscalYear]! / s.value }));
        fcfPerShareCagr = cagr(fcfPsSeries);
      }

      // Évolution actions 5Y (déjà split-adj)
      const shareCagr = cagr(shares);

      // Marge FCF = FCF / Revenue (latest)
      const fcfMargin = (latestRev && latestFcf && latestRev.value > 0)
        ? latestFcf.value / latestRev.value
        : null;

      // Operating leverage : marge op TTM > marge op 5Y moyenne
      const opMarginNow = (latestRev && latestRev.value > 0)
        ? latest(operatingInc)?.value
          ? (latest(operatingInc)!.value / latestRev.value)
          : null
        : null;
      const opMarginAvg = avgMarginOver(operatingInc, revenue);
      const operatingLeverage = (opMarginNow != null && opMarginAvg != null) ? opMarginNow > opMarginAvg : null;

      // Cash ROCE proxy : FCF / (Equity + LT Debt). FCF/CE strict nécessite IB capital (= NWC + PP&E),
      // pas exposé directement par Yahoo. L'approximation Equity + Debt est l'usage Buffett courant.
      const latestEquity = latest(equity);
      const latestDebt = latest(totalDebt);
      const cashROCE = (latestFcf && latestEquity && latestDebt &&
                       (latestEquity.value + latestDebt.value) > 0)
        ? latestFcf.value / (latestEquity.value + latestDebt.value)
        : null;

      // Dette nette / FCF
      const latestCash = latest(cash);
      const netDebtFcf = (latestDebt && latestFcf && latestFcf.value > 0)
        ? ((latestDebt.value - (latestCash?.value ?? 0)) / latestFcf.value)
        : null;

      // Cash Conversion Rate = FCF / Net Income (>1 si bonne qualité de bénéfices)
      const ccr = (latestFcf && latestNI && latestNI.value > 0)
        ? latestFcf.value / latestNI.value
        : null;

      // BFR : on expose le current ratio brut (Yahoo l'a)
      const latestCA = latest(currentAssets);
      const latestCL = latest(currentLiab);
      const currentRatio = (latestCA && latestCL && latestCL.value > 0)
        ? latestCA.value / latestCL.value
        : null;
      const nwc = currentRatio != null ? (currentRatio < 1 ? -1 : 1) : null;

      // P/FCF TTM = market_cap / FCF. Yahoo donne shares latest, on a price → mcap.
      // On utilise le dernier FCF POSITIF (pas latest brut) pour les cas où la dernière
      // année a un FCF négatif (small biotech, restructuring, etc.) : sinon pfcfTTM
      // serait null alors qu'on a un multiple parfaitement calculable sur l'année N-1.
      const marketCap = (latestShares && price > 0)
        ? price * latestShares.value
        : null;
      const pfcfTTM = (marketCap && latestPositiveFcf && latestPositiveFcf.value > 0)
        ? marketCap / latestPositiveFcf.value
        : null;

      const metrics: DerivedMetrics = {
        netMargin,
        revenueCagr,
        fcfPerShareCagr,
        shareCagr,
        shareCagrSource: shareCagr != null ? 'yahoo' : null,
        fcfMargin,
        operatingLeverage,
        cashROCE,
        netDebtFcf,
        ccr,
        nwc,
        nwcCurrentRatio: currentRatio,
        pfcfTTM,
        marketCap,
        price,
        sbcShareOfFcf: null, // pas dispo en free
      };

      console.log(`[yahoo fund ${yahooSymbol}] OK (${currency}, ${revenue.length}Y revenue, ${fcf.length}Y FCF)`);
      void companyName; // companyName est exposé via resolveYahooTicker, pas besoin ici
      return { metrics, currency, companyName };
    } catch (e) {
      console.warn(`[yahoo fund ${yahooSymbol}] échec :`, (e as Error).message);
      return null;
    }
  });
}
