/**
 * Calcul des 10 critères chiffrés + métriques dérivées à partir des données Finnhub.
 * Aucune API externe ici — pure logique de transformation.
 */
import type { Criterion, DerivedMetrics, ValoParams, ValuationResult } from '@lubin/shared';
import type { FinnhubMetricResponse, FinnhubProfile2, FinnhubQuote } from './finnhub.js';

export function computeDerivedMetrics(input: {
  metric: FinnhubMetricResponse | null;
  profile: FinnhubProfile2 | null;
  quote: FinnhubQuote | null;
  /** CAGR du nombre d'actions calculé depuis Yahoo (source brute). Null si indisponible. */
  yahooShareCagr?: number | null;
  /**
   * CAGR du FCF/action calculé directement depuis Yahoo (FCF total / shares split-adj).
   * Préféré à epsGrowth5Y Finnhub car (1) FCF est plus pertinent qu'EPS, (2) Finnhub peut
   * tarder à split-adjuster sur les tickers ayant splitté récemment. Null si Yahoo n'a pas
   * suffisamment d'historique FCF pour ce ticker OU si une anomalie de donnée est détectée.
   */
  yahooFcfPerShareCagr?: number | null;
  /** Raison spécifique quand yahooFcfPerShareCagr est null (anomalie, données manquantes…) */
  yahooFcfPerShareCagrReason?: string;
  /**
   * Override pour la croissance CA 5Y, calculé par régression TTM sur quarterlies Finnhub.
   * Préféré à `revenueGrowth5Y` de Finnhub (qui est endpoint-based, sensible aux outliers).
   * Si null/undefined → on retombe sur revenueGrowth5Y avec sa raison.
   */
  revenueGrowthOverride?: number | null;
  revenueGrowthOverrideReason?: string;
  /** Raison quand yahooShareCagr est null (régression échoue ET Yahoo aussi) */
  sharesGrowthReason?: string;
  /**
   * Tendance de la marge opérationnelle TTM par régression sur 5 ans. Positif = expansion,
   * négatif = compression. Remplace l'ancien proxy boolean (margin_TTM > margin_5Y_mean).
   */
  opMarginTrend?: number | null;
  opMarginTrendReason?: string;
}): DerivedMetrics {
  const m = input.metric?.metric ?? {};
  const price = input.quote?.c ?? null;

  // Helpers
  const val = (k: string) => (k in m && typeof m[k] === 'number' ? (m[k] as number) : null);
  const pct = (k: string) => {
    const v = val(k);
    return v == null ? null : v / 100;
  };

  const revenueGrowth5Y = pct('revenueGrowth5Y');
  const revenueShareGrowth5Y = pct('revenueShareGrowth5Y');
  const epsGrowth5Y = pct('epsGrowth5Y');

  // FCF/share growth — Yahoo direct UNIQUEMENT (FCF total / shares split-adj).
  // Pas de fallback caché vers Finnhub epsGrowth5Y : ce proxy EPS est fundamentally
  // cassé sur les sociétés ayant splité récemment ou eu une année EPS négative
  // (cas AMZN avec son split 20:1 en 2022 + EPS négatif 2022 → epsGrowth5Y -52%/an aberrant).
  // Si Yahoo ne peut pas calculer, on affiche "Non calculable" + la raison.
  const fcfPerShareCagr: number | null = (input.yahooFcfPerShareCagr != null && Number.isFinite(input.yahooFcfPerShareCagr))
    ? input.yahooFcfPerShareCagr
    : null;
  // L'argument epsGrowth5Y reste lu plus haut pour les logs/debug mais n'est plus utilisé.
  void epsGrowth5Y;

  // Évolution nombre d'actions :
  //   1) Source brute Yahoo (priorité) — vrai CAGR depuis la série diluted shares
  //   2) Fallback : dérivation Finnhub via ratios revenue/share vs revenue
  //      (1+g_total) = (1+g_per_share) × (1+g_shares) → g_shares = (1+g_total)/(1+g_per_share) − 1
  let shareCagr: number | null = null;
  let shareCagrSource: DerivedMetrics['shareCagrSource'] = null;
  if (input.yahooShareCagr != null && Number.isFinite(input.yahooShareCagr)) {
    shareCagr = input.yahooShareCagr;
    shareCagrSource = 'yahoo';
  } else if (revenueGrowth5Y != null && revenueShareGrowth5Y != null && revenueShareGrowth5Y > -1) {
    shareCagr = (1 + revenueGrowth5Y) / (1 + revenueShareGrowth5Y) - 1;
    shareCagrSource = 'finnhub-derived';
  }

  // Marge FCF (proxy : price/pfcf ÷ revenuePerShareTTM)
  const pfcfTTM = val('pfcfShareTTM');
  const rps = val('revenuePerShareTTM');
  let fcfMargin: number | null = null;
  if (price != null && pfcfTTM != null && pfcfTTM > 0 && rps != null && rps > 0) {
    fcfMargin = (price / pfcfTTM) / rps;
  } else if (pct('netProfitMargin5Y') != null) {
    fcfMargin = pct('netProfitMargin5Y');
  }

  // Operating leverage : tendance de la marge op TTM par régression (au lieu du proxy
  // margin_TTM vs margin_5Y_mean qui était sensible aux outliers).
  //   - opMarginTrend > 0  → marges en expansion (pass)
  //   - opMarginTrend < 0  → marges en compression (fail)
  // Si null (pas assez de données), on retombe sur l'ancien proxy boolean comme dernier recours.
  const opTTM = val('operatingMarginTTM');
  const op5Y = val('operatingMargin5Y');
  let operatingLeverage: boolean | null = null;
  if (input.opMarginTrend != null && Number.isFinite(input.opMarginTrend)) {
    operatingLeverage = input.opMarginTrend > 0;
  } else if (opTTM != null && op5Y != null) {
    operatingLeverage = opTTM > op5Y;
  }

  // Cash ROCE : proxy via roi5Y (true Cash ROCE = FCF/CE, indisponible en free tier)
  const cashROCE = pct('roi5Y') ?? pct('roiTtm');

  // Net Debt / FCF : (EV - mcap) / FCF où FCF = mcap / pfcfTTM
  const ev = val('enterpriseValue');
  const mcap = val('marketCapitalization');
  let netDebtFcf: number | null = null;
  if (ev != null && mcap != null && pfcfTTM != null && pfcfTTM > 0) {
    const fcfTotal = mcap / pfcfTTM;
    if (fcfTotal > 0) netDebtFcf = (ev - mcap) / fcfTotal;
  }

  // Cash Conversion Rate : peTTM / pfcfShareTTM (proxy)
  const peTTM = val('peTTM');
  let ccr: number | null = null;
  if (peTTM != null && pfcfTTM != null && pfcfTTM > 0) ccr = peTTM / pfcfTTM;

  // NWC : on a juste le current ratio annuel en free tier → on en déduit le signe
  const currentRatio = val('currentRatioAnnual');
  const nwc = currentRatio != null ? (currentRatio < 1 ? -1 : 1) : null; // marqueur sign

  const netMargin = pct('netProfitMarginTTM') ?? pct('netProfitMargin5Y');

  // revenueCagr : préfère le calcul par régression TTM (input.revenueGrowthOverride)
  // sinon retombe sur le précomputed Finnhub revenueGrowth5Y (endpoint-based).
  const revenueCagr: number | null = (input.revenueGrowthOverride != null && Number.isFinite(input.revenueGrowthOverride))
    ? input.revenueGrowthOverride
    : revenueGrowth5Y;

  // Raisons "Non calculable" pour les ratios dérivés Finnhub
  const reasons: Record<string, string> = {};
  if (fcfPerShareCagr == null) {
    reasons.fcfPerShareCagr = input.yahooFcfPerShareCagrReason ?? 'Historique insuffisant pour calculer FCF/action 5 ans';
  }
  if (revenueCagr == null) reasons.revenueCagr = input.revenueGrowthOverrideReason ?? 'Croissance CA 5Y indisponible';
  if (shareCagr == null) reasons.shareCagr = input.sharesGrowthReason ?? 'Évolution actions 5Y indisponible';
  if (netMargin == null) reasons.netMargin = 'Marge nette indisponible chez Finnhub';
  if (fcfMargin == null) reasons.fcfMargin = 'Marge FCF non dérivable (P/FCF ou CA manquant)';
  if (cashROCE == null) reasons.cashROCE = 'ROCE indisponible chez Finnhub';
  if (netDebtFcf == null) reasons.netDebtFcf = 'Net debt / FCF non dérivable (EV ou FCF manquant)';
  if (ccr == null) reasons.ccr = 'Cash Conversion Rate non dérivable (PE ou P/FCF manquant)';
  if (operatingLeverage == null) reasons.operatingLeverage = input.opMarginTrendReason ?? 'Marges opérationnelles 5Y indisponibles';
  if (pfcfTTM == null) reasons.pfcfTTM = 'P/FCF TTM indisponible chez Finnhub';
  if (currentRatio == null) reasons.nwcCurrentRatio = 'Current ratio annuel indisponible';

  return {
    netMargin,
    revenueCagr,
    fcfPerShareCagr,
    shareCagr,
    shareCagrSource,
    fcfMargin,
    operatingLeverage,
    cashROCE,
    netDebtFcf,
    ccr,
    nwc,
    nwcCurrentRatio: currentRatio,
    pfcfTTM,
    marketCap: mcap,
    price,
    // SBC nécessite cash flow statement (FMP premium) → null en free tier
    sbcShareOfFcf: null,
    notCalculableReasons: Object.keys(reasons).length > 0 ? reasons : undefined,
  };
}

// ─── Construction des 10 critères chiffrés ────────────────────────────────

function fmtPct(v: number | null, suffix = '%', digits = 1): string {
  return v == null ? 'N/A' : (v * 100).toFixed(digits) + suffix;
}
function fmtRaw(v: number | null, digits = 2): string {
  return v == null ? 'N/A' : v.toFixed(digits);
}

/**
 * Format strict pour les valeurs non calculables. Au lieu de "N/A" générique,
 * on affiche "Non calculable" et l'explication contient la raison spécifique
 * (FCF négatif, données manquantes, etc.) — principe d'honnêteté radicale.
 */
const NOT_CALC = 'Non calculable';
function reasonOr(m: DerivedMetrics, key: string, fallback: string): string {
  return m.notCalculableReasons?.[key] ?? fallback;
}

export function buildQuantitativeCriteria(m: DerivedMetrics): Criterion[] {
  return [
    {
      nom: 'Rentable (marge nette)',
      valeur: m.netMargin == null ? NOT_CALC : fmtPct(m.netMargin),
      cible: '> 0 %',
      statut: m.netMargin == null ? 'warn' : m.netMargin > 0.05 ? 'pass' : m.netMargin > 0 ? 'warn' : 'fail',
      explication: m.netMargin == null
        ? reasonOr(m, 'netMargin', 'Donnée indisponible')
        : m.netMargin > 0 ? `Entreprise rentable (${fmtPct(m.netMargin)})` : 'Pertes nettes',
    },
    {
      nom: 'Croissance du CA 5 ans',
      valeur: m.revenueCagr == null ? NOT_CALC : fmtPct(m.revenueCagr, '%/an'),
      cible: '> 10 %/an',
      statut: m.revenueCagr == null ? 'warn' : m.revenueCagr > 0.10 ? 'pass' : m.revenueCagr > 0.05 ? 'warn' : 'fail',
      explication: m.revenueCagr == null
        ? reasonOr(m, 'revenueCagr', 'Historique CA insuffisant')
        : m.revenueCagr > 0.10 ? 'Croissance soutenue' : 'Croissance insuffisante',
    },
    {
      nom: 'Croissance FCF/action 5 ans',
      valeur: m.fcfPerShareCagr == null ? NOT_CALC : fmtPct(m.fcfPerShareCagr, '%/an'),
      cible: '> 10 %/an (ajusté SBC)',
      statut: m.fcfPerShareCagr == null ? 'warn' : m.fcfPerShareCagr > 0.10 ? 'pass' : m.fcfPerShareCagr > 0.05 ? 'warn' : 'fail',
      explication: m.fcfPerShareCagr == null
        ? reasonOr(m, 'fcfPerShareCagr', 'Historique FCF/action insuffisant')
        : m.fcfPerShareCagr > 0.10 ? 'Création de valeur par action solide' : 'Création de valeur par action faible',
    },
    (() => {
      const v = m.shareCagr;
      const sourceTag = m.shareCagrSource === 'yahoo'
        ? ' [Yahoo raw]'
        : m.shareCagrSource === 'finnhub-derived'
          ? ' [Finnhub dérivé]'
          : '';
      const base = v == null
        ? 'Donnée indisponible'
        : v < 0
          ? `Rachats nets — création de valeur (${(v * 100).toFixed(2)}%/an)`
          : v <= 0.005
            ? "Nombre d'actions stable"
            : v < 0.025
              ? `Dilution modérée (${(v * 100).toFixed(2)}%/an)`
              : `Dilution forte (${(v * 100).toFixed(2)}%/an)`;
      return {
        nom: "Évolution nombre d'actions 5 ans",
        valeur: v == null ? 'N/A' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%/an',
        cible: 'Stable ou en baisse',
        statut: v == null ? 'warn' : v <= 0.005 ? 'pass' : v < 0.025 ? 'warn' : 'fail',
        explication: base + sourceTag,
      } as const;
    })(),
    {
      nom: 'Marge FCF (ajustée SBC)',
      valeur: m.fcfMargin == null ? NOT_CALC : fmtPct(m.fcfMargin),
      cible: '> 10 %',
      statut: m.fcfMargin == null ? 'warn' : m.fcfMargin > 0.10 ? 'pass' : m.fcfMargin > 0.05 ? 'warn' : 'fail',
      explication: m.fcfMargin == null
        ? reasonOr(m, 'fcfMargin', 'Donnée indisponible')
        : m.fcfMargin > 0.10 ? 'Marge FCF solide' : 'Marge FCF faible',
    },
    {
      nom: 'Operating leverage',
      valeur: m.operatingLeverage == null ? NOT_CALC : m.operatingLeverage ? '✓ Expansion' : '✗ Compression',
      cible: 'Marge en expansion sur 5 ans',
      statut: m.operatingLeverage == null ? 'warn' : m.operatingLeverage ? 'pass' : 'fail',
      explication: m.operatingLeverage == null
        ? reasonOr(m, 'operatingLeverage', 'Trajectoire 5 ans indisponible')
        : m.operatingLeverage ? 'Revenus croissent plus vite que les coûts' : 'Coûts grandissent plus vite que les revenus',
    },
    {
      nom: 'Cash ROCE',
      valeur: m.cashROCE == null ? NOT_CALC : fmtPct(m.cashROCE),
      cible: '> 15 % (FCF / Capital Employé)',
      statut: m.cashROCE == null ? 'warn' : m.cashROCE > 0.15 ? 'pass' : m.cashROCE > 0.10 ? 'warn' : 'fail',
      explication: m.cashROCE == null
        ? reasonOr(m, 'cashROCE', 'Donnée indisponible')
        : m.cashROCE > 0.15 ? 'Excellent retour cash sur capital' : 'Retour sur capital insuffisant',
    },
    {
      nom: 'Dette nette / FCF',
      valeur: m.netDebtFcf == null ? NOT_CALC : fmtRaw(m.netDebtFcf),
      cible: '< 3 ans',
      statut: m.netDebtFcf == null ? 'warn' : m.netDebtFcf < 3 ? 'pass' : m.netDebtFcf < 5 ? 'warn' : 'fail',
      explication: m.netDebtFcf == null
        ? reasonOr(m, 'netDebtFcf', 'Donnée indisponible')
        : m.netDebtFcf < 0
          ? 'Trésorerie nette positive'
          : m.netDebtFcf < 3
            ? `Remboursable en ${fmtRaw(m.netDebtFcf)} ans`
            : 'Endettement élevé',
    },
    {
      nom: 'Cash Conversion Rate',
      valeur: m.ccr == null ? NOT_CALC : fmtRaw(m.ccr),
      cible: '> 1 (FCF / Net Income)',
      statut: m.ccr == null ? 'warn' : m.ccr > 1 ? 'pass' : m.ccr > 0.7 ? 'warn' : 'fail',
      explication: m.ccr == null
        ? reasonOr(m, 'ccr', 'Donnée indisponible')
        : m.ccr > 1 ? 'Les bénéfices deviennent vraiment du cash' : 'Une partie des bénéfices ne se transforme pas en cash',
    },
    (() => {
      // Current ratio = Current Assets / Current Liabilities. Sa lecture :
      //   < 1   → la boîte peut payer ses fournisseurs avec ce que ses clients lui paient (modèle "BFR négatif" type Amazon, Costco) — fort
      //   1-1.5 → équilibre classique
      //   > 1.5 → beaucoup de capital immobilisé en stocks + créances clients
      const cr = m.nwcCurrentRatio;
      const valeur = cr == null ? NOT_CALC : cr.toFixed(2);
      let statut: 'pass' | 'warn' | 'fail' = 'warn';
      let explication = reasonOr(m, 'nwcCurrentRatio', 'Bilan indisponible');
      if (cr != null) {
        if (cr < 1) {
          statut = 'pass';
          explication = `${cr.toFixed(2)} — les clients payent avant les fournisseurs (modèle type Amazon, Costco)`;
        } else if (cr < 1.5) {
          statut = 'warn';
          explication = `${cr.toFixed(2)} — équilibre classique entre actifs courants et passifs courants`;
        } else {
          statut = 'fail';
          explication = `${cr.toFixed(2)} — beaucoup de capital immobilisé en stocks et créances clients`;
        }
      }
      return {
        nom: 'Current Ratio',
        valeur,
        cible: '< 1 (BFR négatif)',
        statut,
        explication,
      } as const;
    })(),
    {
      nom: 'P/FCF actuel',
      valeur: m.pfcfTTM == null ? NOT_CALC : m.pfcfTTM.toFixed(1) + '×',
      cible: '< 25',
      statut: m.pfcfTTM == null ? 'warn' : m.pfcfTTM < 25 ? 'pass' : m.pfcfTTM < 35 ? 'warn' : 'fail',
      explication: m.pfcfTTM == null
        ? reasonOr(m, 'pfcfTTM', 'P/FCF non calculable')
        : m.pfcfTTM < 25 ? `Multiple raisonnable (${m.pfcfTTM.toFixed(1)}× FCF)` : `Multiple tendu — ${m.pfcfTTM.toFixed(1)}× FCF`,
    },
  ];
}

// ─── Valorisation Buffett-style ──────────────────────────────────────────

export function buildValuation(
  metrics: DerivedMetrics,
  params: ValoParams,
): ValuationResult {
  const result: ValuationResult = {
    nom: 'Valorisation',
    valeur: 'Inputs incomplets',
    cible: '',
    statut: 'warn',
    explication: '',
    fcfPsNow: null,
    currentPfcf: metrics.pfcfTTM,
    fcfPs5Y: null,
    exitValue: null,
    buyPrice: null,
    currentPrice: metrics.price,
    discountPct: null,
  };

  if (!metrics.price || !metrics.pfcfTTM || metrics.pfcfTTM <= 0) {
    result.explication = `Manque : ${[!metrics.price && 'prix', !metrics.pfcfTTM && 'P/FCF'].filter(Boolean).join(', ')}.`;
    return result;
  }

  const fcfPsNow = metrics.price / metrics.pfcfTTM;
  const years = 5;
  const fcfPs5Y = fcfPsNow * Math.pow(1 + params.fcfGrowth, years);
  const exitValue = params.targetMultiple * fcfPs5Y;
  const buyPrice = exitValue / Math.pow(1 + params.targetReturn, years);
  const discountPct = (buyPrice - metrics.price) / metrics.price;

  result.valeur = `Acheter sous ${buyPrice.toFixed(2)}$`;
  result.statut = metrics.price <= buyPrice ? 'pass' : metrics.price <= buyPrice * 1.10 ? 'warn' : 'fail';
  result.explication = discountPct >= 0
    ? `Décote de ${(discountPct * 100).toFixed(1)}% vs prix actuel.`
    : `Surcote de ${Math.abs(discountPct * 100).toFixed(1)}% — attendre une baisse.`;
  result.fcfPsNow = fcfPsNow;
  result.fcfPs5Y = fcfPs5Y;
  result.exitValue = exitValue;
  result.buyPrice = buyPrice;
  result.discountPct = discountPct;
  return result;
}

// ─── Filtre news Bettin-relevant ─────────────────────────────────────────

import type { FinnhubNewsItem } from './finnhub.js';
import type { NewsItem, NewsType } from '@lubin/shared';

export function filterNews(raw: FinnhubNewsItem[]): NewsItem[] {
  const classify = (h: string): NewsType | null => {
    const s = h.toLowerCase();
    if (/lawsuit|class action|securities fraud|investor alert|investigating potential|sec investigation|reminds.*investors|deadline.*action|vs\.|vs medp| vs |which.*better|which.*stock/.test(s)) return null;
    if (/buyback|repurchase|rachat/.test(s)) return 'rachat';
    if (/dividend/.test(s)) return 'dividende';
    if (/\bq[1-4]\b|earnings|results|revenue|beats?|misses|guidance|raises outlook|cuts outlook/.test(s)) return 'résultats';
    if (/acquir|merger|\bdeal\b|m&a|acquisition|spin[- ]off|divest/.test(s)) return 'M&A';
    if (/\bceo\b|\bcfo\b|chief.*officer|appoints|named .* (ceo|cfo|chair)|founder|board chair|resigns|steps down/.test(s)) return 'mgmt';
    return null;
  };

  return raw
    .map(n => {
      const type = classify(n.headline);
      if (!type) return null;
      return {
        titre: n.headline,
        date: new Date(n.datetime * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }),
        type,
        resume: (n.summary ?? '').slice(0, 220),
        url: n.url,
        source: n.source,
      } satisfies NewsItem;
    })
    .filter((x): x is NewsItem => x !== null)
    .slice(0, 5);
}
