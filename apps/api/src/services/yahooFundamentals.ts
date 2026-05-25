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
 *   ✓ Cash ROCE Bettin/Mauboussin  = FCF / (Assets − CurLiab − Goodwill − ExcessCash)
 *   ✓ Dette nette / FCF            = (Total Debt - Cash) / TTM FCF
 *   ✓ Cash Conversion Rate         = FCF / Net Income
 *   ✗ BFR (current ratio annual)   = Current Assets / Current Liabilities (Yahoo l'a)
 *   ✓ P/FCF actuel                 = price × shares / TTM FCF
 *
 * Donc en fait 10/11 + le critère valorisation. SBC reste null (free tier, pas accessible).
 */
import { yahooLimiter } from '../lib/limiter.js';
import { fetchSplitEvents, cumulativeSplitFactor } from './yahooSplits.js';
import { computeExcessCash } from './finnhubFundamentals.js';
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
      // Batch : 1 seul appel Yahoo avec tous les types nécessaires.
      // - annualTotalAssets + annualCurrentLiabilities + annualGoodwill : pour Cash ROCE
      //   Bettin/Mauboussin = FCF / (Assets − CurLiab − Goodwill)
      // - annualCashAndShortTermInvestments : pour netDebt/FCF (debt ratio)
      const types = [
        'annualTotalRevenue',
        'annualNetIncome',
        'annualOperatingIncome',
        'annualFreeCashFlow',
        'annualTotalDebt',
        'annualCashAndShortTermInvestments',
        'annualCashAndCashEquivalents',
        'annualTotalAssets',
        'annualGoodwill',
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
      // Préférence : cash+STI agrégé. Fallback : cash seul si Yahoo ne fournit pas l'agrégé.
      const cashStiAgg     = extract(data, 'annualCashAndShortTermInvestments');
      const cash           = cashStiAgg.length > 0 ? cashStiAgg : extract(data, 'annualCashAndCashEquivalents');
      const totalAssets    = extract(data, 'annualTotalAssets');
      const goodwill       = extract(data, 'annualGoodwill');
      const currentAssets  = extract(data, 'annualCurrentAssets');
      const currentLiab    = extract(data, 'annualCurrentLiabilities');
      const sharesDilutedRaw = extract(data, 'annualDilutedAverageShares');
      const sharesOrdinaryRaw = extract(data, 'annualOrdinarySharesNumber');
      const sharesRaw = sharesDilutedRaw.length >= 2 ? sharesDilutedRaw : sharesOrdinaryRaw;
      const shares = adjustSharesForSplits(sharesRaw, splits);

      const latestRev = latest(revenue);
      const latestNI = latest(netIncome);
      const latestShares = latest(shares);
      const latestFcf = latest(fcf);

      // Raisons spécifiques quand un ratio est non-calculable. Principe : pas de fallback
      // caché ("dernière année positive", "shares de l'année dernière"…). On dit honnêtement
      // pourquoi on ne peut pas calculer.
      const reasons: Record<string, string> = {};

      // ─── Calcul des ratios ────────────────────────────────────────────

      // Marge nette = NI / Revenue (latest)
      let netMargin: number | null = null;
      if (!latestRev || !latestNI) reasons.netMargin = 'Revenu ou résultat net indisponible';
      else if (latestRev.value <= 0) reasons.netMargin = 'Chiffre d\'affaires nul ou négatif';
      else netMargin = latestNI.value / latestRev.value;

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
      let fcfMargin: number | null = null;
      if (!latestRev || !latestFcf) reasons.fcfMargin = 'FCF ou CA indisponible';
      else if (latestRev.value <= 0) reasons.fcfMargin = 'Chiffre d\'affaires nul ou négatif';
      else fcfMargin = latestFcf.value / latestRev.value;

      // Operating leverage : marge op TTM > marge op 5Y moyenne
      const opMarginNow = (latestRev && latestRev.value > 0)
        ? latest(operatingInc)?.value
          ? (latest(operatingInc)!.value / latestRev.value)
          : null
        : null;
      const opMarginAvg = avgMarginOver(operatingInc, revenue);
      const operatingLeverage = (opMarginNow != null && opMarginAvg != null) ? opMarginNow > opMarginAvg : null;

      // Cash ROCE Bettin/Mauboussin :
      //   FCF / (Total Assets − Current Liabilities − Goodwill − ExcessCash)
      // où ExcessCash = max(0, cash − 2% × revenue). Cohérent avec le path US.
      // - Current Liabilities exclues car free financing (suppliers, deferred revenue)
      // - Goodwill exclu car non productif (prime d'acquisition)
      // - ExcessCash exclu car non immobilisé dans les ops (dort en T-Bills)
      const latestAssets = latest(totalAssets);
      const latestCurLiab = latest(currentLiab);
      const latestGoodwill = latest(goodwill);
      const latestDebt = latest(totalDebt);
      const latestCash = latest(cash);
      let cashROCE: number | null = null;
      let cashROCEFormula: 'strict' | 'no-excess-fallback' | null = null;
      if (!latestFcf) reasons.cashROCE = 'FCF indisponible';
      else if (latestFcf.value <= 0) reasons.cashROCE = 'FCF négatif sur le dernier exercice';
      else if (!latestAssets || !latestCurLiab) reasons.cashROCE = 'Total Assets ou Current Liabilities indisponibles';
      else {
        const goodwillVal = latestGoodwill?.value ?? 0;
        const cashVal = latestCash?.value ?? 0;
        const revVal = latestRev?.value ?? null;
        const excess = computeExcessCash(cashVal, revVal);
        const ceStrict = latestAssets.value - latestCurLiab.value - goodwillVal - excess;
        if (ceStrict > 0) {
          cashROCE = latestFcf.value / ceStrict;
          cashROCEFormula = 'strict';
        } else {
          // Fallback : sans soustraction d'excess (cohérent avec le path Finnhub)
          const ceNoExcess = latestAssets.value - latestCurLiab.value - goodwillVal;
          if (ceNoExcess > 0) {
            cashROCE = latestFcf.value / ceNoExcess;
            cashROCEFormula = 'no-excess-fallback';
          } else {
            reasons.cashROCE = `Capital employé nul ou négatif même sans excess cash (assets ${(latestAssets.value / 1e9).toFixed(2)}B − curLiab ${(latestCurLiab.value / 1e9).toFixed(2)}B − goodwill ${(goodwillVal / 1e9).toFixed(2)}B) — sur-acquisition`;
          }
        }
      }

      // Dette nette / FCF (séparé du ROCE, garde sa formule classique)
      let netDebtFcf: number | null = null;
      if (!latestDebt || !latestFcf) reasons.netDebtFcf = 'Dette ou FCF indisponible';
      else if (latestFcf.value <= 0) reasons.netDebtFcf = 'FCF négatif sur le dernier exercice';
      else netDebtFcf = (latestDebt.value - (latestCash?.value ?? 0)) / latestFcf.value;

      // Cash Conversion Rate = FCF / Net Income (>1 si bonne qualité de bénéfices)
      let ccr: number | null = null;
      if (!latestFcf || !latestNI) reasons.ccr = 'FCF ou résultat net indisponible';
      else if (latestNI.value <= 0) reasons.ccr = 'Résultat net négatif';
      else if (latestFcf.value <= 0) reasons.ccr = 'FCF négatif sur le dernier exercice';
      else ccr = latestFcf.value / latestNI.value;

      // BFR : on expose le current ratio brut (Yahoo l'a)
      const latestCA = latest(currentAssets);
      const latestCL = latest(currentLiab);
      const currentRatio = (latestCA && latestCL && latestCL.value > 0)
        ? latestCA.value / latestCL.value
        : null;
      const nwc = currentRatio != null ? (currentRatio < 1 ? -1 : 1) : null;

      // P/FCF TTM = market_cap / FCF (dernier exercice, strict — pas de fallback).
      let marketCap: number | null = null;
      if (!latestShares) reasons.marketCap = 'Nombre d\'actions indisponible';
      else if (price <= 0) reasons.marketCap = 'Prix actuel indisponible';
      else marketCap = price * latestShares.value;

      let pfcfTTM: number | null = null;
      if (!marketCap) reasons.pfcfTTM = reasons.marketCap ?? 'Market cap non calculable';
      else if (!latestFcf) reasons.pfcfTTM = 'FCF indisponible';
      else if (latestFcf.value <= 0) reasons.pfcfTTM = 'FCF négatif sur le dernier exercice';
      else pfcfTTM = marketCap / latestFcf.value;

      const metrics: DerivedMetrics = {
        netMargin,
        revenueCagr,
        fcfPerShareCagr,
        shareCagr,
        shareCagrSource: shareCagr != null ? 'yahoo' : null,
        fcfMargin,
        operatingLeverage,
        cashROCE,
        cashROCEFormula,
        netDebtFcf,
        ccr,
        nwc,
        nwcCurrentRatio: currentRatio,
        pfcfTTM,
        marketCap,
        price,
        sbcShareOfFcf: null, // pas dispo en free
        notCalculableReasons: Object.keys(reasons).length > 0 ? reasons : undefined,
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
