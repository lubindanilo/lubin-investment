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
  /**
   * FCF ajusté SBC sur les 12 derniers mois (CFO_TTM − SBC_TTM + CapEx_TTM).
   * Si fourni → utilisé pour pfcfTTM, fcfMargin, cashROCE, netDebtFcf, ccr.
   * Sinon → on retombe sur les ratios précomputed Finnhub (FCF brut, non ajusté).
   */
  adjFcfTtm?: number | null;
  /** SBC / FCF brut sur TTM (alerte qualité FCF si > 0.15) */
  sbcShareOfFcf?: number | null;
  /**
   * Capital employé Bettin/Mauboussin = Total Assets − Current Liabilities − Goodwill − Excess Cash.
   * Snapshot du dernier quarter. Utilisé comme dénominateur du Cash ROCE.
   * Null si données critiques manquent OU si CE ≤ 0 (sur-acquisition ou ultra-cash-rich).
   */
  capitalEmployed?: number | null;
  /** Raison explicite quand capitalEmployed est null (equity négatif > debt, données manquantes…) */
  capitalEmployedReason?: string;
  /** Variante de formule effectivement appliquée par le snapshot — propagé tel quel à la sortie */
  capitalEmployedFormula?: 'strict' | 'no-excess-fallback' | 'no-goodwill-fallback' | 'financial-equity' | null;
  // ─── Fallbacks /financials-reported quand /stock/metric flake ─────────────
  // Ces champs sont peuplés à partir de la même fetch CapitalEmployedSnapshot.
  // Ils ne sont utilisés que si /stock/metric ne donne pas le ratio précomputed
  // équivalent — c'est-à-dire que tant que Finnhub /stock/metric répond bien,
  // les valeurs affichées sont IDENTIQUES à avant (Finnhub précomputed gagne).
  /** Revenue TTM brut (somme des 4 derniers Q décumulés) — fallback pour netMargin + fcfMargin */
  revenueTtm?: number | null;
  /** Net Income TTM (somme des 4 derniers Q) — fallback pour netMargin + ccr */
  netIncomeTtm?: number | null;
  /** Shares outstanding (latest Q, split-adjusté) — fallback pour mcap = price × shares */
  sharesLatest?: number | null;
  /** Current Assets (latest Q) — fallback pour current ratio = CA / CL */
  currentAssetsSnapshot?: number | null;
  /** Current Liabilities (latest Q) — fallback pour current ratio = CA / CL */
  currentLiabilitiesSnapshot?: number | null;
  /** Total Debt (latest Q) — fallback pour netDebtFcf = (debt − cash) / FCF */
  totalDebtSnapshot?: number | null;
  /** Total Cash (latest Q) — fallback pour netDebtFcf */
  totalCashSnapshot?: number | null;
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

  // P/FCF actuel + Marge FCF — préfère le FCF ajusté SBC si dispo, sinon retombe sur
  // les valeurs Finnhub précomputed (FCF brut, non ajusté).
  //   pfcfTTM_adj = market_cap / FCF_adj_TTM
  //   fcfMargin_adj = FCF_adj_TTM / revenue_TTM
  //
  // Fallback robustesse : mcap peut être absent de /stock/metric si Finnhub flake.
  // On le reconstruit alors via price × sharesLatest (financials-reported, split-adj).
  let mcap = val('marketCapitalization');
  let mcapSource: 'finnhub-metric' | 'financials-reported' = 'finnhub-metric';
  if ((mcap == null || mcap <= 0) && price != null && price > 0 && input.sharesLatest != null && input.sharesLatest > 0) {
    // sharesLatest est en valeur absolue (count), price en $/action.
    // mcap final dans `marketCapitalization` est en millions chez Finnhub → on stocke dans la même unité.
    mcap = (price * input.sharesLatest) / 1_000_000;
    mcapSource = 'financials-reported';
  }
  const rps = val('revenuePerShareTTM');
  let pfcfTTM: number | null = null;
  let fcfMargin: number | null = null;
  if (input.adjFcfTtm != null && input.adjFcfTtm > 0 && mcap != null && mcap > 0) {
    const mcapAbsolute = mcap * 1_000_000;
    pfcfTTM = mcapAbsolute / input.adjFcfTtm;
    // Marge FCF — préfère le revenueTtm direct de /financials-reported, fallback sur la
    // dérivation revenuePerShareTTM × shares de /stock/metric (le code original).
    if (input.revenueTtm != null && input.revenueTtm > 0) {
      fcfMargin = input.adjFcfTtm / input.revenueTtm;
    } else if (price != null && price > 0 && rps != null && rps > 0) {
      const sharesAbs = mcapAbsolute / price;
      const revenueAbs = rps * sharesAbs;
      if (revenueAbs > 0) fcfMargin = input.adjFcfTtm / revenueAbs;
    }
  } else {
    // Fallback : ratios Finnhub précomputed (FCF brut, non ajusté SBC)
    pfcfTTM = val('pfcfShareTTM');
    if (price != null && pfcfTTM != null && pfcfTTM > 0 && rps != null && rps > 0) {
      fcfMargin = (price / pfcfTTM) / rps;
    } else if (pct('netProfitMargin5Y') != null) {
      fcfMargin = pct('netProfitMargin5Y');
    }
  }
  void mcapSource; // garde la variable pour debug futur

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

  // Cash ROCE Bettin/Mauboussin : FCF_adj / (Assets − CurLiab − Goodwill − ExcessCash).
  // Avec fallback explicite sur la formule sans excess cash pour les boîtes ultra-cash-rich
  // (BKNG, MEDP) où l'excess cash dépasse le capital opérationnel net. Le caller (snapshot)
  // a déjà choisi la formule à appliquer via `capitalEmployedFormula`.
  let cashROCE: number | null = null;
  let cashROCEReason: string | undefined;
  const cashROCEFormula: 'strict' | 'no-excess-fallback' | 'no-goodwill-fallback' | 'financial-equity' | null = input.capitalEmployedFormula ?? null;
  if (input.adjFcfTtm == null || input.adjFcfTtm <= 0) {
    cashROCEReason = input.adjFcfTtm == null
      ? 'FCF ajusté TTM indisponible'
      : 'FCF ajusté TTM négatif ou nul';
  } else if (input.capitalEmployed == null) {
    cashROCEReason = input.capitalEmployedReason ?? 'Capital employé indisponible';
  } else {
    cashROCE = input.adjFcfTtm / input.capitalEmployed;
    // Si un fallback (no-excess, no-goodwill ou financial-equity) est appliqué, on expose
    // la raison même quand cashROCE est calculé — la carte UI affichera la formule réellement utilisée.
    if (cashROCEFormula !== 'strict' && cashROCEFormula != null && input.capitalEmployedReason) {
      cashROCEReason = input.capitalEmployedReason;
    }
  }

  // Net Debt / FCF : (EV - mcap) / FCF_adj. Source primaire : Finnhub /stock/metric.
  // Fallback : (totalDebt − totalCash) / adjFcfTtm depuis le snapshot (/financials-reported).
  const ev = val('enterpriseValue');
  let netDebtFcf: number | null = null;
  if (ev != null && mcap != null) {
    const netDebtAbsolute = (ev - mcap) * 1_000_000;
    const fcfToUse = input.adjFcfTtm ?? (pfcfTTM != null && pfcfTTM > 0 ? (mcap * 1_000_000) / pfcfTTM : null);
    if (fcfToUse != null && fcfToUse > 0) {
      netDebtFcf = netDebtAbsolute / fcfToUse;
    }
  } else if (input.adjFcfTtm != null && input.adjFcfTtm > 0
          && input.totalDebtSnapshot != null && input.totalCashSnapshot != null) {
    // Fallback /financials-reported : netDebt = totalDebt - totalCash (en USD bruts)
    const netDebtAbsolute = input.totalDebtSnapshot - input.totalCashSnapshot;
    netDebtFcf = netDebtAbsolute / input.adjFcfTtm;
  }

  // Cash Conversion Rate : FCF_adj / Net Income. Source primaire : Finnhub peTTM × mcap.
  // Fallback : netIncomeTtm direct depuis /financials-reported.
  let ccr: number | null = null;
  if (input.adjFcfTtm != null && input.adjFcfTtm > 0) {
    const peTTM = val('peTTM');
    if (peTTM != null && peTTM > 0 && mcap != null && mcap > 0) {
      const netIncomeTtmFromPe = (mcap * 1_000_000) / peTTM;
      if (netIncomeTtmFromPe > 0) ccr = input.adjFcfTtm / netIncomeTtmFromPe;
    }
    // Fallback : netIncomeTtm direct si peTTM ou mcap manquent
    if (ccr == null && input.netIncomeTtm != null && input.netIncomeTtm > 0) {
      ccr = input.adjFcfTtm / input.netIncomeTtm;
    }
  } else {
    const peTTM = val('peTTM');
    if (peTTM != null && pfcfTTM != null && pfcfTTM > 0) ccr = peTTM / pfcfTTM;
  }

  // NWC : current ratio = CA / CL. Source primaire : Finnhub currentRatioAnnual.
  // Fallback : currentAssets / currentLiabilities depuis le snapshot /financials-reported.
  let currentRatio = val('currentRatioAnnual');
  if (currentRatio == null
      && input.currentAssetsSnapshot != null
      && input.currentLiabilitiesSnapshot != null
      && input.currentLiabilitiesSnapshot > 0) {
    currentRatio = input.currentAssetsSnapshot / input.currentLiabilitiesSnapshot;
  }
  const nwc = currentRatio != null ? (currentRatio < 1 ? -1 : 1) : null;

  // Marge nette = NI / Revenue. Source primaire : Finnhub TTM ou 5Y précomputed.
  // Fallback : netIncomeTtm / revenueTtm directs depuis /financials-reported.
  let netMargin = pct('netProfitMarginTTM') ?? pct('netProfitMargin5Y');
  if (netMargin == null
      && input.netIncomeTtm != null
      && input.revenueTtm != null && input.revenueTtm > 0) {
    netMargin = input.netIncomeTtm / input.revenueTtm;
  }

  // revenueCagr : préfère le calcul par régression TTM (input.revenueGrowthOverride)
  // sinon retombe sur le précomputed Finnhub revenueGrowth5Y (endpoint-based).
  const revenueCagr: number | null = (input.revenueGrowthOverride != null && Number.isFinite(input.revenueGrowthOverride))
    ? input.revenueGrowthOverride
    : revenueGrowth5Y;

  // Raisons "Non calculable" affichées à l'utilisateur. On NE propage PAS les messages
  // techniques internes (détail de régression, noms de fournisseurs, etc.) : copy produit
  // en français clair uniquement.
  const reasons: Record<string, string> = {};
  if (fcfPerShareCagr == null) {
    reasons.fcfPerShareCagr = 'Historique insuffisant pour estimer la croissance sur 5 ans';
  }
  if (revenueCagr == null) reasons.revenueCagr = 'Historique insuffisant pour estimer la croissance du chiffre d\'affaires';
  if (shareCagr == null) reasons.shareCagr = 'Historique insuffisant pour estimer l\'évolution du nombre d\'actions';
  if (netMargin == null) reasons.netMargin = 'Marge nette indisponible';
  if (fcfMargin == null) reasons.fcfMargin = 'Marge de free cash flow indisponible';
  // notCalculableReasons.cashROCE est exposé dans 2 cas :
  //  - ROCE non calculable (donnée manquante / CE négatif) → la raison explique pourquoi
  //  - ROCE calculé mais via un fallback (ultra-cash-rich, financial) → la raison explique
  //    quelle variante de formule a été appliquée. La carte UI peut ainsi afficher
  //    transparemment le fallback (principe "pas de fallback caché").
  if (cashROCE == null) {
    reasons.cashROCE = cashROCEReason ?? 'ROCE non calculable (FCF ou capital employé manquant)';
  } else if (cashROCEReason) {
    reasons.cashROCE = cashROCEReason;
  }
  if (netDebtFcf == null) reasons.netDebtFcf = 'Dette nette / FCF indisponible';
  if (ccr == null) reasons.ccr = 'Taux de conversion du cash indisponible';
  if (operatingLeverage == null) reasons.operatingLeverage = 'Historique insuffisant pour estimer la tendance des marges';
  if (pfcfTTM == null) reasons.pfcfTTM = 'P/FCF indisponible';
  if (currentRatio == null) reasons.nwcCurrentRatio = 'Ratio de liquidité indisponible';

  return {
    netMargin,
    revenueCagr,
    fcfPerShareCagr,
    shareCagr,
    shareCagrSource,
    fcfMargin,
    operatingLeverage,
    cashROCE,
    cashROCEFormula,
    netDebtFcf,
    ccr,
    nwc,
    nwcCurrentRatio: currentRatio,
    pfcfTTM,
    marketCap: mcap,
    price,
    // SBC / FCF brut — utile pour afficher un warning UI si > 15%
    sbcShareOfFcf: input.sbcShareOfFcf ?? null,
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
    (() => {
      // Le texte est court : verdict + mention discrète du fallback si appliqué.
      // La formule complète, les composants et l'explication des variants sont dans la
      // modale info (icône ⓘ sur la carte), pas dans le texte de la carte.
      const variant = m.cashROCEFormula;
      const fallbackNote =
        variant === 'no-excess-fallback'   ? ' (calcul fallback ultra-cash-rich — voir ⓘ)' :
        variant === 'no-goodwill-fallback' ? ' (formule Buffett goodwill inclus — voir ⓘ)' :
        variant === 'financial-equity'     ? ' (formule secteur financier — voir ⓘ)' :
        '';
      const verdict = m.cashROCE == null
        ? reasonOr(m, 'cashROCE', 'Donnée indisponible')
        : m.cashROCE > 0.15
          ? `Excellent retour cash sur capital${fallbackNote}`
          : `Retour sur capital insuffisant${fallbackNote}`;
      return {
        nom: 'Cash ROCE',
        valeur: m.cashROCE == null ? NOT_CALC : fmtPct(m.cashROCE),
        cible: '> 15 % (FCF ÷ Capital Investi)',
        statut: m.cashROCE == null ? 'warn' : m.cashROCE > 0.15 ? 'pass' : m.cashROCE > 0.10 ? 'warn' : 'fail',
        explication: verdict,
      } as const;
    })(),
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
  ];
}

/**
 * Critère "P/FCF actuel" séparé des chiffres qualité.
 *
 * Rationale : le P/FCF est une métrique de VALORISATION (timing d'entrée), pas
 * de qualité business. Une boîte exceptionnelle reste exceptionnelle même
 * surévaluée — elle est juste pas encore au bon prix. On le sort donc du score
 * Chiffres (10) et on l'affiche à côté de la valorisation Buffett.
 */
export function buildPfcfCriterion(m: DerivedMetrics): Criterion {
  return {
    nom: 'P/FCF actuel',
    valeur: m.pfcfTTM == null ? NOT_CALC : m.pfcfTTM.toFixed(1) + '×',
    cible: '< 25',
    statut: m.pfcfTTM == null ? 'warn' : m.pfcfTTM < 25 ? 'pass' : m.pfcfTTM < 35 ? 'warn' : 'fail',
    explication: m.pfcfTTM == null
      ? reasonOr(m, 'pfcfTTM', 'P/FCF non calculable')
      : m.pfcfTTM < 25 ? `Multiple raisonnable (${m.pfcfTTM.toFixed(1)}× FCF)` : `Multiple tendu — ${m.pfcfTTM.toFixed(1)}× FCF`,
  };
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
