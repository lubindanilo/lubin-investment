/**
 * Service Finnhub `/stock/financials-reported` — extrait les états financiers
 * directement depuis les 10-K / 10-Q SEC. Beaucoup plus profond que Yahoo
 * (16+ années annuelles, 29+ trimestres pour la plupart des US tickers).
 *
 * ⚠ Particularité des 10-Q : les chiffres income statement et cash flow sont
 *   CUMULATIFS YTD (Q3 contient Q1+Q2+Q3). On décumule pour avoir des vrais
 *   trimestres individuels. Les balance sheet items (BS) sont des snapshots
 *   à date, pas cumulatifs.
 */
import { finnhubLimiter } from '../lib/limiter.js';
import { fetchWithRetry } from '../lib/retry.js';
import type { TimeseriesPoint } from '@lubin/shared';
import { fetchSplitEvents, splitAdjustWithDiscontinuity } from './yahooSplits.js';

const BASE = 'https://finnhub.io/api/v1';
const TOKEN = process.env.FINNHUB_API_KEY ?? '';

type Section = 'bs' | 'cf' | 'ic';
type Frequency = 'annual' | 'quarterly';

interface FinnhubReportItem {
  concept: string;
  label?: string;
  unit?: string;
  value: number;
}
interface FinnhubFiling {
  year: number;
  quarter: number;
  startDate: string;
  endDate: string;
  form: '10-K' | '10-Q' | string;
  report: { bs?: FinnhubReportItem[]; cf?: FinnhubReportItem[]; ic?: FinnhubReportItem[] };
}
interface FinnhubReportedResponse {
  data?: FinnhubFiling[];
  error?: string;
}

/**
 * Mapping des métriques (clés haut-niveau utilisées dans l'UI) vers les concepts XBRL US-GAAP.
 * Plusieurs concepts candidats par métrique car les boîtes utilisent des tags différents.
 */
export interface MetricConfig {
  /** Section du rapport (bilan, cash flow, income statement) */
  section: Section;
  /** Concepts XBRL candidats, testés dans l'ordre */
  concepts: string[];
  /**
   * True si la valeur est cumulative YTD dans les 10-Q (résultat net, CA, etc.).
   * False si snapshot à date (cash, dette, actions outstanding).
   */
  cumulative: boolean;
}

export const METRICS: Record<string, MetricConfig> = {
  revenue: {
    section: 'ic',
    concepts: [
      'us-gaap_Revenues',
      'us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax',
      'us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax',
      'us-gaap_SalesRevenueNet',
      'us-gaap_SalesRevenueGoodsNet',
    ],
    cumulative: true,
  },
  netIncome: {
    section: 'ic',
    concepts: [
      'us-gaap_NetIncomeLoss',
      'us-gaap_ProfitLoss',
    ],
    cumulative: true,
  },
  operatingIncome: {
    section: 'ic',
    concepts: ['us-gaap_OperatingIncomeLoss'],
    cumulative: true,
  },
  fcf: {
    // FCF = CashFlowFromOperations − CapEx — calculé en aval
    section: 'cf',
    concepts: ['__computed_fcf__'],
    cumulative: true,
  },
  cfo: {
    section: 'cf',
    concepts: [
      'us-gaap_NetCashProvidedByUsedInOperatingActivities',
      'us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    cumulative: true,
  },
  capex: {
    section: 'cf',
    concepts: [
      'us-gaap_PaymentsToAcquirePropertyPlantAndEquipment',
      'us-gaap_PaymentsToAcquireProductiveAssets',
    ],
    cumulative: true,
  },
  shares: {
    section: 'ic',
    concepts: [
      'us-gaap_WeightedAverageNumberOfDilutedSharesOutstanding',
      'us-gaap_WeightedAverageNumberOfSharesOutstandingBasic',
    ],
    cumulative: false, // moyenne pondérée → pas cumulative
  },
  /**
   * Stock-Based Compensation. Apparait dans le cash flow statement comme add-back
   * non-cash (les boîtes l'ajoutent au CFO). On le soustrait pour calculer le "FCF
   * ajusté SBC" qui reflète la vraie création de valeur économique (la SBC est une
   * dilution réelle même si elle ne passe pas par le cash).
   */
  sbc: {
    section: 'cf',
    concepts: [
      'us-gaap_ShareBasedCompensation',
      'us-gaap_StockBasedCompensation',
      'us-gaap_AllocatedShareBasedCompensationExpense',
    ],
    cumulative: true,
  },
  /**
   * Dette totale agrégée — calcule en sommant TOUTES les composantes du passif financier :
   *   LT debt (current + non-current portions) + ST borrowings + leases (op + fin).
   *
   * Avant ce fix, on prenait le PREMIER concept qui matchait dans une liste, ce qui
   * sous-estimait la dette pour les boîtes qui rapportent les composantes séparément
   * (ex BKNG : on récupérait $15.4B au lieu de $19B). Voir __computed_totalDebt__
   * dans extractValue pour la logique de somme + dédoublonnage.
   */
  totalDebt: {
    section: 'bs',
    concepts: ['__computed_totalDebt__'],
    cumulative: false,
  },
  /**
   * Cash + short-term investments — cash réellement mobilisable pour rembourser la
   * dette. Soustrait du capital employé dans le Cash ROCE Buffett/Damodaran style.
   * Voir __computed_cash__ dans extractValue.
   */
  cashAndEquivalents: {
    section: 'bs',
    concepts: ['__computed_cash__'],
    cumulative: false,
  },
  /**
   * Capitaux propres (Stockholders' Equity). Point-in-time, snapshot fin de période.
   * Conservé même si plus utilisé pour Cash ROCE (formule désormais asset-based) —
   * peut servir pour d'autres ratios (P/B, leverage, etc.).
   */
  equity: {
    section: 'bs',
    concepts: [
      'us-gaap_StockholdersEquity',
      'us-gaap_StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
    cumulative: false,
  },
  /**
   * Total Assets — utilisé dans le dénominateur Bettin/Mauboussin du Cash ROCE :
   *   CE = Total Assets − Current Liabilities − Goodwill
   */
  totalAssets: {
    section: 'bs',
    concepts: ['us-gaap_Assets'],
    cumulative: false,
  },
  /**
   * Current Liabilities — soustrait du capital employé car c'est du "free financing"
   * (suppliers, deferred revenue, accruals…) qui ne demande pas de rémunération.
   */
  currentLiabilities: {
    section: 'bs',
    concepts: ['us-gaap_LiabilitiesCurrent'],
    cumulative: false,
  },
  /**
   * Current Assets — utilisé pour calculer le current ratio (CA / CL) en fallback
   * quand Finnhub /stock/metric ne renvoie pas currentRatioAnnual.
   */
  currentAssets: {
    section: 'bs',
    concepts: ['us-gaap_AssetsCurrent'],
    cumulative: false,
  },
  /**
   * Goodwill — soustrait du capital employé. Les primes d'acquisitions traînent au
   * bilan mais ne sont pas du capital productif. Permet de mesurer le retour sur le
   * capital ORGANIQUE (vs acquisitif).
   * Absent = 0 (la boîte n'a pas fait d'acquisitions significatives).
   */
  goodwill: {
    section: 'bs',
    concepts: ['us-gaap_Goodwill'],
    cumulative: false,
  },
};

export type MetricKey = keyof typeof METRICS;

/**
 * Tickers liés par un changement de nom : Finnhub conserve les filings sous le
 * SYMBOLE déposé au moment du filing. Quand une boîte rebrand (Fiserv FISV→FI,
 * Meta FB→META, Square SQ→XYZ, Twitter TWTR→X), les quarters récents arrivent
 * sous le nouveau ticker tandis que les vieux restent sous l'ancien. Si on query
 * un seul, on rate la moitié de l'historique → bug constaté sur FISV (1 quarter
 * récent isolé sans contexte TTM).
 *
 * On fetch les deux et on merge dedupé par date. Bidirectionnel par construction :
 * query 'FISV' ou 'FI' → mêmes données combinées.
 */
const TICKER_ALIASES: Record<string, string[]> = {
  FISV: ['FI'],
  FI:   ['FISV'],
  FB:   ['META'],
  META: ['FB'],
  SQ:   ['XYZ'],
  XYZ:  ['SQ'],
  TWTR: ['X'],
  X:    ['TWTR'],
  TWX:  ['T'],
  GOOG: ['GOOGL'],  // dual-class : généralement les mêmes filings mais on merge par sécurité
  GOOGL: ['GOOG'],
};

async function fetchReportedSingle(ticker: string, freq: Frequency): Promise<FinnhubFiling[]> {
  return finnhubLimiter.schedule(async () => {
    const url = `${BASE}/stock/financials-reported?symbol=${ticker}&freq=${freq}&token=${TOKEN}`;
    const r = await fetchWithRetry(url, undefined, { label: `finnhub reported ${freq}`, attempts: 3 });
    const j = await r.json() as FinnhubReportedResponse;
    if (j.error) throw new Error(`Finnhub reported: ${j.error}`);
    return j.data ?? [];
  });
}

async function fetchReported(ticker: string, freq: Frequency): Promise<FinnhubFiling[]> {
  const aliases = TICKER_ALIASES[ticker.toUpperCase()] ?? [];
  if (aliases.length === 0) return fetchReportedSingle(ticker, freq);

  // Fetch en parallèle le symbole demandé + tous ses alias
  const all = await Promise.all([
    fetchReportedSingle(ticker, freq),
    ...aliases.map(a => fetchReportedSingle(a, freq).catch(() => [] as FinnhubFiling[])),
  ]);
  const flat = all.flat();
  if (flat.length === 0) return flat;

  // Dédupe par endDate (clé naturelle d'un filing). Si deux symboles publient le
  // même quarter, on garde celui du symbole demandé en priorité (= entrée la plus
  // ancienne dans `all`, donc on garde la première occurrence rencontrée).
  const seen = new Set<string>();
  const merged: FinnhubFiling[] = [];
  for (const f of flat) {
    const key = `${f.endDate}|${f.year}|${f.quarter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  // Trier par endDate ASC (downstream attend cet ordre)
  merged.sort((a, b) => a.endDate.localeCompare(b.endDate));
  console.log(`[finnhub fundamentals] ${ticker} merged with aliases ${aliases.join(',')} : ${all.map((x, i) => `${i === 0 ? ticker : aliases[i-1]}=${x.length}`).join(' ')} → ${merged.length} dedupé`);
  return merged;
}

/**
 * Formule pure du Free Cash Flow brut (avant ajustement SBC).
 *
 * FCF = CFO − |CapEx|
 *
 * ⚠ CRITIQUE : Finnhub renvoie les concepts `us-gaap_PaymentsToAcquirePropertyPlantAndEquipment`
 * en VALEUR ABSOLUE positive (= montant payé). Pas en signed cash flow négatif.
 * On doit donc TOUJOURS soustraire la magnitude, jamais additionner.
 *
 * Bug historique (commit 1031836) : on faisait `cfo + capex` qui ADDITIONNAIT deux
 * outflows → FCF doublé. AMZN passait de $7.7B réel à $271B factice. Tous les ratios
 * dérivés étaient gonflés. Test ci-dessous pour anti-regression.
 *
 * Exporté pour tests unitaires.
 */
export function computeFcfBrut(cfo: number | null, capex: number | null): number | null {
  if (cfo == null) return null;
  return cfo - Math.abs(capex ?? 0);
}

/**
 * Formule pure du FCF ajusté SBC.
 * FCF_adj = CFO − |CapEx| − SBC
 * (SBC est positif chez Finnhub, on soustrait pour annuler l'add-back non-cash dans CFO)
 */
export function computeFcfAdj(cfo: number | null, capex: number | null, sbc: number | null): number | null {
  const brut = computeFcfBrut(cfo, capex);
  if (brut == null) return null;
  return brut - (sbc ?? 0);
}

/**
 * Dette totale = LT debt (current + non-current) + ST borrowings + leases (op + fin).
 *
 * Règle anti-double-count : `LongTermDebt` (l'agrégé) inclut déjà la portion courante,
 * donc s'il est présent on l'utilise SEUL pour la LT debt. Sinon on somme les deux
 * portions séparément.
 *
 * Renvoie null si AUCUN concept de dette n'est trouvé (boîte sans dette = 0 sera
 * géré en aval dans getCapitalEmployedSeries qui interprète absence = 0).
 *
 * Exporté pour tests unitaires.
 */
export function computeTotalDebt(parts: {
  longTermDebtAggregate: number | null;
  longTermDebtNoncurrent: number | null;
  longTermDebtCurrent: number | null;
  shortTermBorrowings: number | null;
  operatingLeaseNoncurrent: number | null;
  operatingLeaseCurrent: number | null;
  financeLeaseNoncurrent: number | null;
  financeLeaseCurrent: number | null;
}): number | null {
  // LT debt : si l'agrégé est présent (rare mais arrive), il inclut déjà la portion courante.
  // Sinon, somme des deux portions. Évite le double-count si certains tickers reportent les 3.
  const ltDebt = parts.longTermDebtAggregate != null
    ? parts.longTermDebtAggregate
    : (parts.longTermDebtNoncurrent ?? 0) + (parts.longTermDebtCurrent ?? 0);
  const stDebt = parts.shortTermBorrowings ?? 0;
  const leases = (parts.operatingLeaseNoncurrent ?? 0)
               + (parts.operatingLeaseCurrent ?? 0)
               + (parts.financeLeaseNoncurrent ?? 0)
               + (parts.financeLeaseCurrent ?? 0);
  const total = ltDebt + stDebt + leases;
  // Renvoie null SEULEMENT si aucune composante n'a été trouvée (vs renvoyer 0 qui
  // pourrait masquer un défaut de parsing). 0 légitime ne survient pas en pratique :
  // une boîte sans dette du tout omet TOUS ces concepts du filing XBRL.
  const allMissing = parts.longTermDebtAggregate == null
                  && parts.longTermDebtNoncurrent == null
                  && parts.longTermDebtCurrent == null
                  && parts.shortTermBorrowings == null
                  && parts.operatingLeaseNoncurrent == null
                  && parts.operatingLeaseCurrent == null
                  && parts.financeLeaseNoncurrent == null
                  && parts.financeLeaseCurrent == null;
  return allMissing ? null : total;
}

/**
 * Cash + équivalents + investissements court terme — la trésorerie réellement
 * mobilisable pour rembourser la dette. Pour Damodaran-style net capital employed.
 * Renvoie null si aucune composante trouvée.
 *
 * Exporté pour tests unitaires.
 */
export function computeCashAndEquivalents(parts: {
  cash: number | null;
  shortTermInvestments: number | null;
}): number | null {
  if (parts.cash == null && parts.shortTermInvestments == null) return null;
  return (parts.cash ?? 0) + (parts.shortTermInvestments ?? 0);
}

/**
 * Estime le cash EXCÉDENTAIRE (= non utilisé dans les opérations).
 *
 * Heuristique standard Damodaran/Mauboussin/McKinsey :
 *   cash_opérationnel ≈ 2 % du revenue TTM (besoin pour rouler salaires, fournisseurs, etc.)
 *   excess_cash = max(0, cash_total − operating_cash_need)
 *
 * À soustraire du capital employé pour mesurer le ROCE sur le capital VRAIMENT immobilisé
 * dans les ops (vs cash qui dort en T-Bills et ne génère pas d'EBIT).
 *
 * Fallback conservateur : si revenue indisponible → renvoie 0 (pas d'excès supposé), pour
 * éviter de slasher le dénominateur sur la base d'une hypothèse vide.
 *
 * Exporté pour tests unitaires.
 */
export const OPERATING_CASH_PCT_OF_REVENUE = 0.02;

export function computeExcessCash(
  totalCash: number | null,
  revenueTtm: number | null,
  operatingPct: number = OPERATING_CASH_PCT_OF_REVENUE,
): number {
  if (totalCash == null || totalCash <= 0) return 0;
  if (revenueTtm == null || revenueTtm <= 0) return 0;
  const operatingNeed = revenueTtm * operatingPct;
  return Math.max(0, totalCash - operatingNeed);
}

function extractValue(filing: FinnhubFiling, cfg: MetricConfig): number | null {
  if (cfg.concepts.includes('__computed_fcf__')) {
    const cfo = extractFirst(filing, 'cf', METRICS.cfo!.concepts);
    const capex = extractFirst(filing, 'cf', METRICS.capex!.concepts);
    return computeFcfBrut(cfo, capex);
  }
  if (cfg.concepts.includes('__computed_totalDebt__')) {
    return computeTotalDebt({
      longTermDebtAggregate:    extractFirst(filing, 'bs', ['us-gaap_LongTermDebt']),
      longTermDebtNoncurrent:   extractFirst(filing, 'bs', ['us-gaap_LongTermDebtNoncurrent']),
      longTermDebtCurrent:      extractFirst(filing, 'bs', ['us-gaap_LongTermDebtCurrent']),
      shortTermBorrowings:      extractFirst(filing, 'bs', [
        'us-gaap_ShortTermBorrowings',
        'us-gaap_NotesPayableCurrent',
        'us-gaap_CommercialPaper',
      ]),
      operatingLeaseNoncurrent: extractFirst(filing, 'bs', ['us-gaap_OperatingLeaseLiabilityNoncurrent']),
      operatingLeaseCurrent:    extractFirst(filing, 'bs', ['us-gaap_OperatingLeaseLiabilityCurrent']),
      financeLeaseNoncurrent:   extractFirst(filing, 'bs', ['us-gaap_FinanceLeaseLiabilityNoncurrent']),
      financeLeaseCurrent:      extractFirst(filing, 'bs', ['us-gaap_FinanceLeaseLiabilityCurrent']),
    });
  }
  if (cfg.concepts.includes('__computed_cash__')) {
    return computeCashAndEquivalents({
      cash: extractFirst(filing, 'bs', [
        'us-gaap_CashAndCashEquivalentsAtCarryingValue',
        'us-gaap_CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
        'us-gaap_Cash',
      ]),
      shortTermInvestments: extractFirst(filing, 'bs', [
        'us-gaap_ShortTermInvestments',
        'us-gaap_MarketableSecuritiesCurrent',
        'us-gaap_AvailableForSaleSecuritiesCurrent',
      ]),
    });
  }
  return extractFirst(filing, cfg.section, cfg.concepts);
}

function extractFirst(filing: FinnhubFiling, section: Section, concepts: string[]): number | null {
  const items = filing.report?.[section];
  if (!items) return null;
  for (const concept of concepts) {
    // Match exact d'abord
    let found = items.find(i => i.concept === concept);
    // Certains vieux filings reportent les concepts SANS le préfixe `us-gaap_` (constaté
    // sur ADBE Q2 FY21 : `Revenues` au lieu de `us-gaap_Revenues`). On retombe sur le
    // nom nu si l'exact match échoue. Garde-fou : on ne décompose qu'un préfixe connu
    // (`us-gaap_` / `us-gaap:`), pas n'importe quel namespace (éviter `adbe:Foo` qui
    // ne doit PAS matcher `Foo` d'un autre namespace).
    if (!found) {
      const bare = concept.replace(/^us-gaap[_:]/, '');
      if (bare !== concept) {
        found = items.find(i => i.concept === bare);
      }
    }
    if (found && typeof found.value === 'number' && Number.isFinite(found.value)) return found.value;
  }
  return null;
}

/**
 * Récupère une série temporelle (quarterly ou annual) depuis Finnhub financials-reported.
 *
 * Pour le quarterly + métrique cumulative (revenue, NI, FCF, etc.) :
 *   1. Décumule les Q1/Q2/Q3 YTD pour avoir des valeurs trimestrielles individuelles.
 *   2. Récupère AUSSI les filings annuels (10-K) et calcule Q4 = annuel − Q3 cumulé YTD.
 *      Sans cette étape, on aurait Q1/Q2/Q3 seulement (les 10-Q ne couvrent pas Q4).
 *
 * Pour le quarterly + métrique non-cumulative (shares, dette à instant T) :
 *   Renvoie les valeurs Q1/Q2/Q3 telles quelles. Pas de Q4 dérivé (l'annuel
 *   serait juste une moyenne pondérée FY qui n'est pas comparable à Q4 seul).
 *
 * Pour l'annual : valeurs telles que dans les 10-K.
 */
export async function getReportedTimeseries(
  ticker: string,
  metric: MetricKey,
  freq: Frequency,
  years: number,
): Promise<TimeseriesPoint[]> {
  const cfg = METRICS[metric];
  if (!cfg) return [];
  const cap = Math.max(1, Math.min(years, 50));

  // Pour quarterly + cumulative : fetch en parallèle les deux fréquences pour dériver Q4
  const needAnnualForQ4 = freq === 'quarterly' && cfg.cumulative;
  const [quarterlyFilings, annualFilings] = await Promise.all([
    freq === 'quarterly' ? fetchReported(ticker, 'quarterly') : Promise.resolve([]),
    freq === 'annual' || needAnnualForQ4 ? fetchReported(ticker, 'annual') : Promise.resolve([]),
  ]);

  // Cas simple : annual
  if (freq === 'annual') {
    const points = extractAndPack(annualFilings, cfg);
    return splitAdjustIfNeeded(filterWindow(points, cap), ticker, metric);
  }

  // Cas quarterly
  type Raw = { date: string; value: number; year: number; quarter: number };
  const quarterlyRaw: Raw[] = quarterlyFilings
    .map(f => {
      const value = extractValue(f, cfg);
      if (value == null) return null;
      return { date: f.endDate.slice(0, 10), value, year: f.year, quarter: f.quarter };
    })
    .filter((x): x is Raw => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Décumulation Q1/Q2/Q3 si cumulative.
  //
  // Cas piégeux : si Q1 manque pour une année (ex : changement de ticker FISV→FI en plein
  // milieu de 2023, Finnhub ne renvoie alors que Q2/Q3 sous l'ancien symbol), on ne peut PAS
  // décumuler — la valeur "Q2" est en réalité la valeur YTD = Q1+Q2 actuelle. Si on remontait
  // cette valeur comme si c'était Q2 seul, on aurait des chiffres 2-3× trop hauts (bug constaté
  // sur FISV : Q2 2021 reporté à $7.8B au lieu de $4.0B réel, Q3 2025 à $15.9B au lieu de ~$5B).
  // → On SKIP le point quand on ne peut pas décumuler proprement.
  const points: TimeseriesPoint[] = [];
  const ytdByYear: Record<number, number> = {};
  // Trace la quarter le plus récent vu pour chaque année (pour valider qu'on a la chaîne complète)
  const lastQuarterByYear: Record<number, number> = {};
  let skippedQ: { date: string; quarter: number }[] = [];
  for (const r of quarterlyRaw) {
    if (!cfg.cumulative) {
      points.push({ date: r.date, value: r.value });
      continue;
    }
    if (r.quarter === 1) {
      points.push({ date: r.date, value: r.value });
      ytdByYear[r.year] = r.value;
      lastQuarterByYear[r.year] = 1;
    } else {
      // Pour décumuler Q_n on a besoin du Q_(n-1) YTD de la MÊME année.
      // Si lastQuarterByYear[r.year] !== r.quarter - 1, il manque un quarter intermédiaire
      // (Q1 absent, ou Q1+Q2 absents, etc.) → on ne peut pas décumuler.
      const expectedPrior = r.quarter - 1;
      if (lastQuarterByYear[r.year] !== expectedPrior) {
        skippedQ.push({ date: r.date, quarter: r.quarter });
        continue;
      }
      const priorYtd = ytdByYear[r.year]!;
      points.push({ date: r.date, value: r.value - priorYtd });
      ytdByYear[r.year] = r.value;
      lastQuarterByYear[r.year] = r.quarter;
    }
  }
  if (skippedQ.length > 0) {
    console.warn(`[finnhub fundamentals ${ticker}/${metric}] ${skippedQ.length} Q skipped (impossible à décumuler, Q1 ou intermédiaire manquant) :`, skippedQ.slice(0, 5));
  }

  // Dérivation Q4 : annuel − Q3 YTD (cumulative only)
  //
  // ⚠ CRITIQUE : on ne dérive Q4 que si on a EFFECTIVEMENT le YTD Q3 (lastQuarterByYear === 3).
  // Si seul Q1 a été décumulé (Q2 manquait → Q3 skipped), `ytdByYear[year]` contiendrait
  // le YTD Q1 et on calculerait Q4 = annuel − Q1 = somme(Q2+Q3+Q4) → bar 3× trop haut.
  // Cas réel : ADBE FY23 (Q2 absent chez Finnhub) → 23/12 affichait $14.74B au lieu de ~$5B.
  if (needAnnualForQ4) {
    let q4Count = 0;
    let q4Skipped = 0;
    for (const a of annualFilings) {
      const annualValue = extractValue(a, cfg);
      if (annualValue == null) continue;
      // Vérification stricte : il faut Q3 YTD pour faire annual − Q3 = Q4
      if (lastQuarterByYear[a.year] !== 3) {
        q4Skipped++;
        continue;
      }
      const q3Ytd = ytdByYear[a.year]!;
      const q4Date = a.endDate.slice(0, 10);
      // On vérifie qu'on n'a pas déjà ce point (cas rare où un 10-K aurait été parsé comme quarterly)
      if (points.some(p => p.date === q4Date)) continue;
      points.push({ date: q4Date, value: annualValue - q3Ytd });
      q4Count++;
    }
    console.log(`[finnhub fundamentals] ${ticker}/${metric}: ${q4Count} Q4 dérivés du 10-K${q4Skipped > 0 ? ` (${q4Skipped} Q4 non dérivables — Q3 YTD manquant)` : ''}`);
  }

  points.sort((a, b) => a.date.localeCompare(b.date));
  return splitAdjustIfNeeded(filterWindow(points, cap), ticker, metric);
}

// ═══════════════════════════════════════════════════════════════════════════
// Croissance annualisée par régression log-linéaire (robuste aux outliers)
// ═══════════════════════════════════════════════════════════════════════════
//
// Principe général :
//   1. Fetch les quarterlies
//   2. Calcule un TTM rolling (somme 4Q pour flow, moyenne 4Q pour stock, ratio pour marges)
//   3. Garde les TTM positifs sur la fenêtre (5Y par défaut)
//   4. Régression linéaire de log(TTM) vs temps → slope = taux annualisé en log
//   5. Renvoie exp(slope) - 1 = croissance annualisée
//
// Avantages :
//   - Utilise TOUS les points (20+ TTM) pour estimer la pente, pas seulement les bornes
//   - Robuste face à un quarter ou une année aberrante
//   - Le TTM lisse la saisonnalité intra-année
//
// Helpers privés réutilisés par les 4 calculs :
//   - rollingTtmSum     pour les flows (revenue, fcf, op income)
//   - rollingTtmMean    pour les stocks (shares — point-in-time, moyenné sur 4Q = avg annuel)
//   - regressLogGrowth  régression sur les points TTM

interface TtmPoint { date: string; ts: number; value: number }

function rollingTtmSum(points: TimeseriesPoint[]): TtmPoint[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const out: TtmPoint[] = [];
  for (let i = 3; i < sorted.length; i++) {
    const sum = sorted[i]!.value + sorted[i-1]!.value + sorted[i-2]!.value + sorted[i-3]!.value;
    out.push({ date: sorted[i]!.date, ts: tsOf(sorted[i]!.date), value: sum });
  }
  return out;
}

function rollingTtmMean(points: TimeseriesPoint[]): TtmPoint[] {
  return rollingTtmSum(points).map(p => ({ ...p, value: p.value / 4 }));
}

function tsOf(date: string): number {
  return new Date(date + 'T00:00:00Z').getTime();
}

/**
 * Régression linéaire de log(value) sur t (années depuis t0).
 * Renvoie { rate, n, first, last } pour traçabilité. null si non régressable.
 */
function regressLogGrowth(points: TtmPoint[]): { rate: number; n: number; first: TtmPoint; last: TtmPoint } | null {
  const valid = points.filter(p => p.value > 0);
  if (valid.length < 4) return null;
  const t0 = valid[0]!.ts;
  const xs = valid.map(p => (p.ts - t0) / (365.25 * 24 * 3600 * 1000));
  const ys = valid.map(p => Math.log(p.value));
  const n = xs.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY);
    den += (xs[i]! - meanX) ** 2;
  }
  if (den === 0) return null;
  return { rate: Math.exp(num / den) - 1, n, first: valid[0]!, last: valid[valid.length - 1]! };
}

/** Filtre une série de TTM points sur les `windowYears` dernières années (par ts). */
function windowed(points: TtmPoint[], windowYears: number): TtmPoint[] {
  const cutoff = Date.now() - windowYears * 365.25 * 24 * 3600 * 1000;
  return points.filter(p => p.ts >= cutoff);
}

// ─── FCF ajusté SBC ─────────────────────────────────────────────────────────
// FCF_adj = CFO − SBC + CapEx (CapEx déjà signé négatif). Pourquoi soustraire SBC :
// elle est ajoutée au CFO comme add-back non-cash, ce qui INFLATE le CFO de la valeur
// de la dilution. Pour mesurer la vraie création de valeur économique, on doit la
// re-soustraire. Critique pour les tickers tech (META, GOOGL, AMZN avec $20B/an+).

export interface AdjustedFcfResult {
  /** TTM CFO − SBC + CapEx du dernier trimestre dispo. Null si données insuffisantes. */
  ttmFcfAdj: number | null;
  /** TTM CFO brut (pour debug + ratio SBC) */
  ttmCfo: number | null;
  /** TTM SBC */
  ttmSbc: number | null;
  /** TTM CapEx (signé négatif) */
  ttmCapex: number | null;
  /** Ratio SBC / FCF non ajusté — > 0.15 = alerte qualité FCF. Null si non calculable. */
  sbcShareOfFcf: number | null;
  /** Date du quarter le plus récent utilisé pour le TTM */
  asOf: string | null;
}

// ─── Capital Employé Bettin/Mauboussin (snapshot) ───────────────────────────
// CE = Total Assets − Current Liabilities − Goodwill − Excess Cash
//
// Vision asset-based du capital qui doit être rémunéré :
//   - On part des actifs totaux
//   - On exclut les passifs courants = free financing (suppliers, deferred revenue)
//   - On exclut le goodwill = primes d'acquisitions, pas du capital productif
//   - On exclut le cash EXCÉDENTAIRE (>2% revenue) = cash qui dort en T-Bills,
//     pas mobilisé dans les ops
//
// Cas dégénérés (→ "Non calculable", pas de fallback caché) :
//   - Total Assets ou Current Liabilities indispo
//   - CE ≤ 0 :
//     · goodwill > capital productif (sur-acquisitions) OU
//     · cash excédentaire > capital opérationnel restant (boîte ultra-cash-rich)
//     → ratio non interprétable de toute façon

export interface CapitalEmployedSnapshot {
  totalAssets: number | null;
  currentLiabilities: number | null;
  /** Current Assets snapshot dernier Q — pour fallback nwcCurrentRatio si /stock/metric absent */
  currentAssets: number | null;
  goodwill: number | null;
  equity: number | null;
  /** Total debt (LT + ST + leases) au dernier quarter — utilisé par le fallback financier */
  totalDebt: number | null;
  /** Cash total (cash + STI) au dernier quarter */
  totalCash: number | null;
  /** Revenue TTM (somme des 4 derniers Q) — utilisé pour estimer le cash opérationnel
   *  ET comme dénominateur fallback pour netMargin / fcfMargin */
  revenueTtm: number | null;
  /** Net Income TTM (somme des 4 derniers Q décumulés) — pour fallback netMargin / ccr */
  netIncomeTtm: number | null;
  /** Shares outstanding (point-in-time, dernier Q, split-adjusted) — pour fallback mcap = price × shares */
  sharesLatest: number | null;
  /** Cash excédentaire théorique = max(0, totalCash − 2% × revenueTtm) */
  excessCash: number | null;
  /** Formule effectivement appliquée :
   *  - 'strict' : CE = Assets − CurLiab − Goodwill − ExcessCash (formule complète)
   *  - 'no-excess-fallback' : CE = Assets − CurLiab − Goodwill (ultra-cash-rich)
   *  - 'no-goodwill-fallback' : CE = Assets − CurLiab (sur-acquisitive asset-light : MEDP-style)
   *  - 'financial-equity' : CE = Equity + LT Debt − Goodwill (assureurs/banques, bilan unclassified)
   *  Null si CE indispo. */
  formulaUsed: 'strict' | 'no-excess-fallback' | 'no-goodwill-fallback' | 'financial-equity' | null;
  /** Capital employé final utilisé ; null si non calculable même avec fallback */
  capitalEmployed: number | null;
  /** Date du dernier quarter dispo */
  asOf: string | null;
  /** Raison explicite quand capitalEmployed est null */
  reason?: string;
}

export async function computeCapitalEmployedSnapshot(ticker: string): Promise<CapitalEmployedSnapshot> {
  const [assetsQ, curLiabQ, curAssetsQ, goodwillQ, cashQ, revenueQ, equityQ, debtQ, netIncomeQ, sharesQ] = await Promise.all([
    getReportedTimeseries(ticker, 'totalAssets', 'quarterly', 2),
    getReportedTimeseries(ticker, 'currentLiabilities', 'quarterly', 2),
    getReportedTimeseries(ticker, 'currentAssets', 'quarterly', 2),
    getReportedTimeseries(ticker, 'goodwill', 'quarterly', 2),
    getReportedTimeseries(ticker, 'cashAndEquivalents', 'quarterly', 2),
    getReportedTimeseries(ticker, 'revenue', 'quarterly', 2),
    getReportedTimeseries(ticker, 'equity', 'quarterly', 2),
    getReportedTimeseries(ticker, 'totalDebt', 'quarterly', 2),
    getReportedTimeseries(ticker, 'netIncome', 'quarterly', 2),
    getReportedTimeseries(ticker, 'shares', 'quarterly', 2),
  ]);
  const lastAssets = assetsQ[assetsQ.length - 1];
  const lastCurLiab = curLiabQ[curLiabQ.length - 1];
  const lastCurAssets = curAssetsQ[curAssetsQ.length - 1];
  const lastGoodwill = goodwillQ[goodwillQ.length - 1];
  const lastCash = cashQ[cashQ.length - 1];
  const lastEquity = equityQ[equityQ.length - 1];
  const lastDebt = debtQ[debtQ.length - 1];
  const lastShares = sharesQ[sharesQ.length - 1];
  const totalAssets = lastAssets?.value ?? null;
  const currentLiabilities = lastCurLiab?.value ?? null;
  const currentAssets = lastCurAssets?.value ?? null;
  const goodwill = lastGoodwill?.value ?? 0;
  const totalCash = lastCash?.value ?? 0;
  const equity = lastEquity?.value ?? null;
  const totalDebt = lastDebt?.value ?? 0;
  const sharesLatest = lastShares?.value ?? null;
  // TTM revenue + netIncome : sommes des 4 derniers Q (décumulés par getReportedTimeseries).
  // Si <4 Q dispos → null (on ne fait pas de TTM partiel qui ferait des ratios faux).
  const revenueSorted = [...revenueQ].sort((a, b) => a.date.localeCompare(b.date));
  const last4Rev = revenueSorted.slice(-4);
  const revenueTtm = last4Rev.length === 4 ? last4Rev.reduce((s, p) => s + p.value, 0) : null;
  const netIncomeSorted = [...netIncomeQ].sort((a, b) => a.date.localeCompare(b.date));
  const last4NI = netIncomeSorted.slice(-4);
  const netIncomeTtm = last4NI.length === 4 ? last4NI.reduce((s, p) => s + p.value, 0) : null;
  const excessCash = computeExcessCash(totalCash, revenueTtm);
  const asOf = lastAssets?.date ?? lastCurLiab?.date ?? lastEquity?.date ?? null;

  const baseFields = {
    totalAssets, currentLiabilities, currentAssets,
    goodwill: lastGoodwill?.value ?? null,
    equity, totalDebt: lastDebt?.value ?? null,
    totalCash: lastCash?.value ?? null,
    revenueTtm, netIncomeTtm, sharesLatest, excessCash,
  };

  if (totalAssets == null) {
    return { ...baseFields, formulaUsed: null, capitalEmployed: null, asOf, reason: 'Total Assets indisponible chez Finnhub' };
  }

  // ─── Fallback secteur financier (assureurs, banques) ───────────────────────
  // Bilan unclassified (us-gaap_LiabilitiesCurrent absent) : les passifs sont des
  // réserves de sinistres + primes non gagnées + deferred premiums, pas séparés
  // current/non-current. La formule Bettin/Mauboussin ne s'applique pas.
  //
  // Formule adaptée : CE = Equity + LongTermDebt − Goodwill. Équivalent mathématique
  // de "Assets − (Liabilities − LongTermDebt) − Goodwill" — c'est-à-dire qu'on traite
  // les réserves d'assurance comme du "free financing" (float, équivalent du deferred
  // revenue chez Amazon/Costco). Ne soustrait PAS l'excess cash (le cash d'un assureur
  // est du working capital, pas excédentaire).
  if (currentLiabilities == null && equity != null) {
    const ceFinancial = equity + totalDebt - goodwill;
    if (ceFinancial > 0) {
      return {
        ...baseFields, formulaUsed: 'financial-equity', capitalEmployed: ceFinancial, asOf,
        reason: `Bilan unclassified (pas de Current Liabilities) — fallback secteur financier : CE = Equity ${(equity/1e9).toFixed(2)}B + Dette LT ${(totalDebt/1e9).toFixed(2)}B − Goodwill ${(goodwill/1e9).toFixed(2)}B`,
      };
    }
    return {
      ...baseFields, formulaUsed: null, capitalEmployed: null, asOf,
      reason: `Capital employé nul ou négatif sur le fallback financier (equity ${(equity/1e9).toFixed(2)}B + dette ${(totalDebt/1e9).toFixed(2)}B − goodwill ${(goodwill/1e9).toFixed(2)}B)`,
    };
  }

  if (currentLiabilities == null) {
    return {
      ...baseFields, formulaUsed: null, capitalEmployed: null, asOf,
      reason: 'Current Liabilities ET Equity indisponibles chez Finnhub',
    };
  }

  // ─── Formule standard (industriels, tech, retail, services) ────────────────
  // Try strict d'abord (Bettin/Mauboussin + Damodaran excess cash)
  const ceStrict = totalAssets - currentLiabilities - goodwill - excessCash;
  if (ceStrict > 0) {
    return { ...baseFields, formulaUsed: 'strict', capitalEmployed: ceStrict, asOf };
  }
  // Strict CE ≤ 0 → fallback sans soustraction d'excess (cas ultra-cash-rich BKNG/MEDP)
  const ceNoExcess = totalAssets - currentLiabilities - goodwill;
  if (ceNoExcess > 0) {
    return {
      ...baseFields, formulaUsed: 'no-excess-fallback', capitalEmployed: ceNoExcess, asOf,
      reason: `Fallback : cash excédentaire (${(excessCash / 1e9).toFixed(2)}B) > capital opérationnel net — formule sans soustraction d'excess (Bettin/Mauboussin classique)`,
    };
  }
  // Sans excess ET sans goodwill : Buffett classique = CE = Assets − CurLiab.
  // Pour les boîtes asset-light sur-acquisitives (MEDP, certains rouleurs de services
  // health/IT) où le goodwill dépasse le tangible net capital, on inclut le goodwill
  // car c'est du capital réellement payé via M&A. La ROCE résultante traite le
  // goodwill comme du capital normal.
  const ceNoGoodwill = totalAssets - currentLiabilities;
  if (ceNoGoodwill > 0) {
    return {
      ...baseFields, formulaUsed: 'no-goodwill-fallback', capitalEmployed: ceNoGoodwill, asOf,
      reason: `Fallback : goodwill (${(goodwill / 1e9).toFixed(2)}B) > capital tangible net — formule incluant le goodwill dans le capital employé (Buffett classique)`,
    };
  }
  return {
    ...baseFields, formulaUsed: null, capitalEmployed: null, asOf,
    reason: `Capital employé nul ou négatif même goodwill inclus (assets ${(totalAssets / 1e9).toFixed(2)}B − curLiab ${(currentLiabilities / 1e9).toFixed(2)}B = ${(ceNoGoodwill / 1e9).toFixed(2)}B) — passifs courants dépassent les actifs totaux, situation anormale`,
  };
}

export async function computeAdjustedFcfTtm(ticker: string): Promise<AdjustedFcfResult> {
  const empty: AdjustedFcfResult = {
    ttmFcfAdj: null, ttmCfo: null, ttmSbc: null, ttmCapex: null, sbcShareOfFcf: null, asOf: null,
  };
  const [cfoQ, capexQ, sbcQ] = await Promise.all([
    getReportedTimeseries(ticker, 'cfo', 'quarterly', 2),
    getReportedTimeseries(ticker, 'capex', 'quarterly', 2),
    getReportedTimeseries(ticker, 'sbc', 'quarterly', 2),
  ]);
  if (cfoQ.length < 4 || capexQ.length < 4) return empty;

  // TTM rolling sum sur les 4 derniers Q
  const cfoTtm = rollingTtmSum(cfoQ);
  const capexTtm = rollingTtmSum(capexQ);
  const sbcTtm = sbcQ.length >= 4 ? rollingTtmSum(sbcQ) : [];

  if (cfoTtm.length === 0 || capexTtm.length === 0) return empty;
  // On prend le dernier TTM. Match par date (le plus récent commun à toutes les séries).
  const lastCfo = cfoTtm[cfoTtm.length - 1]!;
  const capexAtDate = capexTtm.find(c => c.date === lastCfo.date) ?? capexTtm[capexTtm.length - 1]!;
  const sbcAtDate = sbcTtm.find(s => s.date === lastCfo.date) ?? sbcTtm[sbcTtm.length - 1];

  const ttmCfo = lastCfo.value;
  const ttmCapex = capexAtDate.value;
  const ttmSbc = sbcAtDate?.value ?? null;
  // CapEx est en valeur absolue chez Finnhub (cf commentaire dans extractValue) → toujours soustraire.
  const rawFcf = ttmCfo - Math.abs(ttmCapex);
  const ttmFcfAdj = ttmSbc != null ? rawFcf - ttmSbc : rawFcf; // si pas de SBC, FCF non ajusté
  const sbcShareOfFcf = (ttmSbc != null && rawFcf > 0) ? ttmSbc / rawFcf : null;

  return { ttmFcfAdj, ttmCfo, ttmSbc, ttmCapex, sbcShareOfFcf, asOf: lastCfo.date };
}

/**
 * Variante TTM rolling SUR TOUTE la série quarterly : renvoie pour chaque trimestre
 * un FCF_adj TTM. Utilisé par les régressions (FCF/action growth, etc.) qui ont besoin
 * de l'historique complet, pas juste du dernier.
 */
export async function getAdjustedFcfTtmSeries(ticker: string, windowYears: number): Promise<TtmPoint[]> {
  const [cfoQ, capexQ, sbcQ] = await Promise.all([
    getReportedTimeseries(ticker, 'cfo', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'capex', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'sbc', 'quarterly', windowYears + 1),
  ]);
  if (cfoQ.length < 4 || capexQ.length < 4) return [];

  const cfoTtm = rollingTtmSum(cfoQ);
  const capexTtm = rollingTtmSum(capexQ);
  const sbcTtm = sbcQ.length >= 4 ? rollingTtmSum(sbcQ) : [];
  const capexByDate = new Map(capexTtm.map(p => [p.date, p.value]));
  const sbcByDate = new Map(sbcTtm.map(p => [p.date, p.value]));

  const out: TtmPoint[] = [];
  for (const p of cfoTtm) {
    const capex = capexByDate.get(p.date);
    if (capex == null) continue;
    const sbc = sbcByDate.get(p.date) ?? 0; // si pas de SBC ce quarter, on assume 0 (boîte sans SBC)
    // CapEx en valeur absolue chez Finnhub → toujours soustraire la magnitude.
    out.push({ date: p.date, ts: p.ts, value: p.value - Math.abs(capex) - sbc });
  }
  return out;
}

/**
 * Série quarterly du capital employé Bettin/Mauboussin =
 *   Assets(t) − CurLiab(t) − Goodwill(t) − ExcessCash(t)
 *
 * où ExcessCash(t) = max(0, cash(t) − 2% × revenueTTM(t)). Point-in-time, pas TTM
 * sur le CE lui-même (les éléments du bilan sont des snapshots), seul le revenue est
 * roulé en TTM pour estimer le besoin opérationnel.
 *
 * - Absence de goodwill / cash / revenue sur un quarter = 0 (XBRL omet les concepts vides
 *   ou pas assez de Q pour le TTM revenue → conservateur : pas d'excess soustrait)
 * - Absence de assets ou curLiab = quarter skippé
 * - CE ≤ 0 → quarter skippé
 */
export async function getCapitalEmployedSeries(ticker: string, windowYears: number): Promise<TimeseriesPoint[]> {
  const [assetsQ, curLiabQ, goodwillQ, cashQ, revenueQ, equityQ, debtQ] = await Promise.all([
    getReportedTimeseries(ticker, 'totalAssets', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'currentLiabilities', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'goodwill', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'cashAndEquivalents', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'revenue', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'equity', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'totalDebt', 'quarterly', windowYears + 1),
  ]);
  if (assetsQ.length === 0) return [];
  const curLiabByDate = new Map(curLiabQ.map(p => [p.date, p.value]));
  const goodwillByDate = new Map(goodwillQ.map(p => [p.date, p.value]));
  const cashByDate = new Map(cashQ.map(p => [p.date, p.value]));
  const equityByDate = new Map(equityQ.map(p => [p.date, p.value]));
  const debtByDate = new Map(debtQ.map(p => [p.date, p.value]));
  const revenueTtmSeries = rollingTtmSum(revenueQ);
  const revenueTtmByDate = new Map(revenueTtmSeries.map(p => [p.date, p.value]));
  const out: TimeseriesPoint[] = [];
  for (const p of assetsQ) {
    const curLiab = curLiabByDate.get(p.date);
    const goodwill = goodwillByDate.get(p.date) ?? 0;
    const equity = equityByDate.get(p.date);
    const debt = debtByDate.get(p.date) ?? 0;

    // Fallback secteur financier : pas de Current Liab pour ce quarter mais Equity dispo
    if (curLiab == null) {
      if (equity == null) continue;
      const ceFinancial = equity + debt - goodwill;
      if (ceFinancial > 0) out.push({ date: p.date, value: ceFinancial });
      continue;
    }

    // Formule standard avec fallback chain : strict → no-excess → no-goodwill
    const cash = cashByDate.get(p.date) ?? 0;
    const revTtm = revenueTtmByDate.get(p.date) ?? null;
    const excess = computeExcessCash(cash, revTtm);
    const ceStrict = p.value - curLiab - goodwill - excess;
    if (ceStrict > 0) {
      out.push({ date: p.date, value: ceStrict });
      continue;
    }
    const ceNoExcess = p.value - curLiab - goodwill;
    if (ceNoExcess > 0) {
      out.push({ date: p.date, value: ceNoExcess });
      continue;
    }
    // Dernier recours : Buffett classique avec goodwill inclus (boîtes sur-acquisitives)
    const ceNoGoodwill = p.value - curLiab;
    if (ceNoGoodwill > 0) {
      out.push({ date: p.date, value: ceNoGoodwill });
    }
  }
  return out;
}

// ─── Croissance revenue 5 ans (TTM revenue + régression) ───────────────────

export async function computeRevenueGrowthFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  const revQ = await getReportedTimeseries(ticker, 'revenue', 'quarterly', windowYears + 1);
  if (revQ.length < 8) return { value: null, reason: `Moins de 8 trimestres revenue (${revQ.length})` };

  const ttm = windowed(rollingTtmSum(revQ), windowYears);
  if (ttm.length < 4) return { value: null, reason: 'Trop peu de TTM dans la fenêtre' };

  const r = regressLogGrowth(ttm);
  if (!r) return { value: null, reason: 'Régression non calculable (TTM ≤ 0 ?)' };
  console.log(`[revGrowthRegress ${ticker}] ${r.n} TTM | ${r.first.date}(${(r.first.value/1e9).toFixed(1)}B) → ${r.last.date}(${(r.last.value/1e9).toFixed(1)}B) → ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

// ─── Évolution actions 5 ans (régression directe sur shares quarterly) ─────

export async function computeSharesGrowthFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  // shares est non-cumulative (point-in-time). Pas besoin de TTM, on régresse direct.
  // splitAdjustWithDiscontinuity dans getReportedTimeseries(metric='shares') gère déjà
  // les splits, on a donc des shares en current-basis comparables d'un Q à l'autre.
  const sharesQ = await getReportedTimeseries(ticker, 'shares', 'quarterly', windowYears + 1);
  if (sharesQ.length < 8) return { value: null, reason: `Moins de 8 trimestres shares (${sharesQ.length})` };

  // Convert TimeseriesPoint → TtmPoint format (juste pour réutiliser regressLogGrowth)
  const points: TtmPoint[] = sharesQ
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(p => ({ date: p.date, ts: tsOf(p.date), value: p.value }));

  const win = windowed(points, windowYears);
  if (win.length < 4) return { value: null, reason: 'Trop peu de shares dans la fenêtre' };

  const r = regressLogGrowth(win);
  if (!r) return { value: null, reason: 'Régression non calculable' };
  console.log(`[sharesGrowthRegress ${ticker}] ${r.n} pts | ${r.first.date}(${(r.first.value/1e6).toFixed(0)}M) → ${r.last.date}(${(r.last.value/1e6).toFixed(0)}M) → ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

// ─── Operating leverage (tendance TTM op margin) ───────────────────────────

export async function computeOperatingMarginTrendFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  // Op margin TTM = TTM(opIncome) / TTM(revenue). On régresse log(margin) sur le temps,
  // slope > 0 → marges en expansion (operating leverage positif).
  const [opQ, revQ] = await Promise.all([
    getReportedTimeseries(ticker, 'operatingIncome', 'quarterly', windowYears + 1),
    getReportedTimeseries(ticker, 'revenue', 'quarterly', windowYears + 1),
  ]);
  if (opQ.length < 8 || revQ.length < 8) {
    return { value: null, reason: `Moins de 8 trimestres pour op income (${opQ.length}) ou revenue (${revQ.length})` };
  }

  const opTtm = rollingTtmSum(opQ);
  const revTtm = rollingTtmSum(revQ);
  const revByDate = new Map(revTtm.map(p => [p.date, p.value]));

  // Marge à chaque quarter où on a les 2 TTM
  const marginTtm: TtmPoint[] = [];
  for (const op of opTtm) {
    const rev = revByDate.get(op.date);
    if (rev == null || rev <= 0) continue;
    marginTtm.push({ date: op.date, ts: op.ts, value: op.value / rev });
  }

  const win = windowed(marginTtm, windowYears);
  if (win.length < 4) return { value: null, reason: 'Trop peu de marges TTM dans la fenêtre' };

  const r = regressLogGrowth(win);
  if (!r) return { value: null, reason: 'Régression non calculable (marge ≤ 0 ?)' };
  console.log(`[opLeverageRegress ${ticker}] ${r.n} TTM | ${r.first.date}(${(r.first.value*100).toFixed(1)}%) → ${r.last.date}(${(r.last.value*100).toFixed(1)}%) → margin trend ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

/**
 * Calcule un taux de croissance annualisé du FCF/action sur ~5 ans par
 * régression log-linéaire des TTM trimestriels.
 *
 * Pourquoi pas une CAGR endpoint-based (Y-5 vs Y0) :
 *   - Sensible aux outliers : si Y-5 OU Y0 est une année atypique (one-shot,
 *     spike conjoncturel, etc.), la CAGR mesure surtout le bruit, pas le trend.
 *   - Cas AMZN : Y-5 (2021) = $107B mais 2022 a fait $110B (à peine plus), puis
 *     2023 jump à $137B, 2024 inconnu, 2025 spike à $271B (probablement
 *     anomalie comptable Finnhub) → la CAGR endpoint 2021→2025 dit +26%/an,
 *     mais ça ne reflète pas vraiment la trajectoire.
 *
 * Approche régression :
 *   1. Fetch 6 ans de quarterlies Finnhub (FCF + shares).
 *   2. Pour chaque trimestre où on a 4 quarters précédents : calcule
 *      TTM_FCF (sum 4 derniers Q) / TTM_shares (moyenne 4 derniers Q).
 *   3. Filtre les TTM positifs (log impossible sinon).
 *   4. Garde les 20 derniers TTM (~5 ans).
 *   5. Régression linéaire de log(TTM_fcfPs) sur l'axe temporel (années).
 *   6. Le coefficient = taux de croissance log → exp(slope) - 1 = croissance annualisée.
 *
 * Avantages :
 *   - Utilise TOUS les points pour estimer la pente, pas seulement les bornes.
 *   - Le TTM lisse déjà la saisonnalité intra-année.
 *   - Robuste face à un quarter aberrant.
 */
export async function computeFcfPerShareCagrFromQuarterlies(
  ticker: string,
  windowYears = 5,
): Promise<{ value: number | null; reason?: string }> {
  // Utilise FCF_adj TTM (CFO − SBC + CapEx) au lieu du FCF brut.
  // Cohérence avec le reste de l'app qui a switché sur FCF_adj.
  const [fcfAdjTtm, sharesQ] = await Promise.all([
    getAdjustedFcfTtmSeries(ticker, windowYears),
    getReportedTimeseries(ticker, 'shares', 'quarterly', windowYears + 1),
  ]);
  if (fcfAdjTtm.length < 4 || sharesQ.length < 8) {
    return { value: null, reason: 'Moins de 4 TTM FCF_adj ou 8 trimestres shares' };
  }

  const sharesSorted = [...sharesQ].sort((a, b) => a.date.localeCompare(b.date));
  const sharesAtOrBefore = (date: string): number | null => {
    let c: number | null = null;
    for (const p of sharesSorted) { if (p.date <= date) c = p.value; else break; }
    return c;
  };

  const fcfPsTtm: TtmPoint[] = [];
  for (const f of fcfAdjTtm) {
    const sh = sharesAtOrBefore(f.date);
    if (sh == null || sh <= 0 || f.value <= 0) continue;
    fcfPsTtm.push({ date: f.date, ts: f.ts, value: f.value / sh });
  }
  const win = windowed(fcfPsTtm, windowYears);
  // Minimum 8 TTM positifs sinon la régression sur peu de points donne des résultats aberrants
  // (cas AMZN dont le FCF_adj est négatif la moitié du temps → 4-6 pts résiduels → slope explosif).
  if (win.length < 8) return { value: null, reason: `Trop peu de TTM FCF/action positifs (${win.length}/8 minimum) — FCF/action_adj souvent négatif sur la période` };

  const r = regressLogGrowth(win);
  if (!r) return { value: null, reason: 'Régression non calculable' };
  console.log(`[fcfPsRegress ${ticker}] ${r.n} TTM (FCF_adj) | ${r.first.date}(${r.first.value.toFixed(2)}) → ${r.last.date}(${r.last.value.toFixed(2)}) → ${(r.rate * 100).toFixed(2)}%/an`);
  return { value: r.rate };
}

/**
 * Si la métrique est un share count, on ramène toutes les valeurs en current-basis.
 *
 * Pour Finnhub on utilise un algorithme "discontinuity-based" (≠ Yahoo date-based) :
 * Finnhub fait du restatement automatique des filings publiées POST-split — la 10-Q
 * Q1 publiée juste après un split contient déjà les chiffres post-split, même si le
 * quarter end est avant. Un adjustment date-based double-counterait le facteur.
 *
 * splitAdjustWithDiscontinuity détecte le saut ≈ factor dans la série et n'ajuste que
 * les points avant ce saut. Voir yahooSplits.ts pour le détail de l'algorithme.
 */
async function splitAdjustIfNeeded(
  points: TimeseriesPoint[],
  ticker: string,
  metric: MetricKey,
): Promise<TimeseriesPoint[]> {
  if (metric !== 'shares' || points.length === 0) return points;
  const splits = await fetchSplitEvents(ticker);
  if (splits.length === 0) return points;
  return splitAdjustWithDiscontinuity(points, splits);
}

function extractAndPack(filings: FinnhubFiling[], cfg: MetricConfig): TimeseriesPoint[] {
  return filings
    .map(f => {
      const value = extractValue(f, cfg);
      if (value == null) return null;
      return { date: f.endDate.slice(0, 10), value };
    })
    .filter((x): x is TimeseriesPoint => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function filterWindow(points: TimeseriesPoint[], years: number): TimeseriesPoint[] {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return points.filter(p => p.date >= cutoffIso);
}
