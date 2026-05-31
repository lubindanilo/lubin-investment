/**
 * Cache GLOBAL par ticker du résultat de l'analyse quant.
 *
 * Architecture : source unique de vérité.
 *   - /api/analyze écrit ici après chaque compute fresh.
 *   - /api/watchlist lit ici directement (jamais de recompute).
 *
 * Conséquence : le score affiché en watchlist EST le score calculé par l'analyse.
 * Divergence mathématiquement impossible.
 *
 * Storage : table Postgres `TickerQuantSnapshot` (clé = ticker).
 * Global, pas per-user, car les fundamentaux sont universels.
 *
 * TTL implicite : on n'expire pas automatiquement. Le cache est mis à jour quand
 * l'utilisateur clique explicitement sur "Analyser" pour ce ticker. Le bouton
 * "Rafraîchir" de la watchlist force un re-fetch (cf. /api/watchlist/refresh).
 */
import type { DerivedMetrics, Criterion } from '@lubin/shared';
import { prisma } from '../db/client.js';

/**
 * Payload stocké dans la DB. Contient tout ce dont une UI a besoin pour afficher
 * une vue compacte (watchlist) OU détaillée (analyze). Les graphiques historiques
 * et les news ne sont PAS cachés ici — ils ont leur propre TTL earnings-based.
 */
export interface CachedQuantSnapshot {
  // Identité
  ticker: string;
  company: string;
  currency: string;
  fundamentalsSource: 'finnhub' | 'yahoo' | null;
  fundamentalsAvailable: boolean;
  yahooSymbol?: string;

  // Métriques + critères (utilisés par analyze pour le rendu complet)
  metrics: DerivedMetrics;
  chiffres: Criterion[];  // 10 critères qualité

  // Score précomputé — c'est CETTE VALEUR qui s'affiche en watchlist (pas de recompute)
  scoreChiffres: number;
  scoreChiffresMax: number;

  // Pour le recompute LIVE du P/FCF en watchlist (price × shares / adjFcfTtm)
  adjFcfTtm: number | null;
  sharesOutstanding: number | null;

  // ─── Prochain earnings (affiché en watchlist) ───────────────────────────
  /** Date du prochain earnings (YYYY-MM-DD). Null si inconnue. */
  nextEarningsDate?: string | null;
  /** ISO timestamp du dernier check earnings. Évite de re-fetcher en boucle quand
   *  aucune date n'est connue (recheck espacé), tout en gardant le cache valide
   *  "jusqu'à la date" quand une date future est connue. */
  earningsCheckedAt?: string | null;

  // ─── Métadonnées d'affichage (screener) ─────────────────────────────────
  /** Secteur/industrie (Finnhub). Null pour la plupart des titres Yahoo. */
  sector?: string | null;
  /** Variation du jour en % (quote.dp). */
  dayChangePct?: number | null;
}

/** Lit le snapshot caché pour un ticker. Retourne null si absent (jamais analysé). */
export async function getCachedSnapshot(ticker: string): Promise<CachedQuantSnapshot | null> {
  const row = await prisma.tickerQuantSnapshot.findUnique({ where: { ticker } });
  return row ? (row.snapshot as unknown as CachedQuantSnapshot) : null;
}

/** Lit plusieurs snapshots en batch (pour la watchlist). */
export async function getCachedSnapshotsBatch(tickers: string[]): Promise<Map<string, CachedQuantSnapshot>> {
  if (tickers.length === 0) return new Map();
  const rows = await prisma.tickerQuantSnapshot.findMany({
    where: { ticker: { in: tickers } },
  });
  const map = new Map<string, CachedQuantSnapshot>();
  for (const r of rows) map.set(r.ticker, r.snapshot as unknown as CachedQuantSnapshot);
  return map;
}

/** Écrit le snapshot (upsert) — appelé après chaque compute fresh. */
export async function writeCachedSnapshot(ticker: string, snapshot: CachedQuantSnapshot): Promise<void> {
  await prisma.tickerQuantSnapshot.upsert({
    where: { ticker },
    update: { snapshot: snapshot as unknown as object, refreshedAt: new Date() },
    create: { ticker, snapshot: snapshot as unknown as object, refreshedAt: new Date() },
  });
}
