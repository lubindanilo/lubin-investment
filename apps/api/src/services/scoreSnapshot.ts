/**
 * buildAndCacheQuantSnapshot — calcule la note quantitative d'un ticker et la persiste
 * dans le cache global TickerQuantSnapshot. Réutilise EXACTEMENT loadQuantData (même
 * logique que /api/analyze), donc le score produit ici est identique à celui de l'analyse.
 *
 * Jamais de qualitatif (GPT) ici : uniquement les 10 critères chiffres + les composants
 * du recompute P/FCF live. Utilisé par la veille screener (includeEarnings: true pour
 * connaître la date du prochain earnings → cadence de re-scoring).
 */
import { loadQuantData } from './quantSnapshot.js';
import { buildQuantitativeCriteria } from './derivedMetrics.js';
import { writeCachedSnapshot, type CachedQuantSnapshot } from './quantCache.js';

export async function buildAndCacheQuantSnapshot(
  ticker: string,
  opts: { includeEarnings?: boolean } = {},
): Promise<CachedQuantSnapshot> {
  const quant = await loadQuantData(ticker, {
    includeNews: false,
    includeEarnings: opts.includeEarnings ?? false,
    log: false,
  });

  const chiffres = buildQuantitativeCriteria(quant.metrics);
  // Path Yahoo : on ne score que les critères réellement disponibles (N/A exclus),
  // comme dans persistQuantCache (analyze) et computeAndCache (watchlist).
  const evaluable = quant.fundamentalsSource === 'yahoo'
    ? chiffres.filter(c => c.valeur !== 'N/A')
    : chiffres;
  const pass = evaluable.filter(c => c.statut === 'pass').length;
  const warn = evaluable.filter(c => c.statut === 'warn').length;

  let adjFcfTtm: number | null = null;
  let sharesOutstanding: number | null = null;
  if (quant.fundamentalsSource === 'finnhub' && quant.rawFhFcfAdj && quant.rawFhCapEmp) {
    adjFcfTtm = quant.rawFhFcfAdj.ttmFcfAdj;
    sharesOutstanding = quant.rawFhCapEmp.sharesLatest;
  } else if (quant.fundamentalsSource === 'yahoo') {
    const m = quant.metrics;
    sharesOutstanding = (m.marketCap != null && m.price != null && m.price > 0)
      ? m.marketCap / m.price : null;
    adjFcfTtm = (m.marketCap != null && m.pfcfTTM != null && m.pfcfTTM > 0)
      ? m.marketCap / m.pfcfTTM : null;
  }

  const snapshot: CachedQuantSnapshot = {
    ticker,
    company: quant.company,
    currency: quant.currency,
    fundamentalsSource: quant.fundamentalsSource,
    fundamentalsAvailable: quant.fundamentalsAvailable,
    yahooSymbol: quant.yahooSymbol,
    metrics: quant.metrics,
    chiffres,
    scoreChiffres: pass + Math.round(warn * 0.5),
    scoreChiffresMax: evaluable.length,
    adjFcfTtm,
    sharesOutstanding,
    nextEarningsDate: quant.earnings?.next?.date ?? null,
    earningsCheckedAt: new Date().toISOString(),
    sector: quant.industry,
    dayChangePct: quant.dayChangePct,
  };
  await writeCachedSnapshot(ticker, snapshot);
  return snapshot;
}
