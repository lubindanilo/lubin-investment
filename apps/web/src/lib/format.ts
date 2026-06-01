/** Helpers de formatage d'affichage (prix, devises). */

/** Devises sans sous-unité courante → affichées sans décimales (yen, won, etc.). */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'CLP', 'HUF', 'ISK', 'VND', 'IDR']);

/**
 * Formate un prix avec sa devise, ex. `312.08 USD`, `352 000 KRW`, `2 909 JPY`.
 * Décimales adaptées à la devise, séparateurs de milliers fr-FR.
 */
export function formatPrice(price: number | null | undefined, currency?: string | null): string {
  if (price == null || !Number.isFinite(price)) return '—';
  const cur = (currency ?? 'USD').toUpperCase();
  const digits = ZERO_DECIMAL_CURRENCIES.has(cur) ? 0 : 2;
  const n = price.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n} ${cur}`;
}
