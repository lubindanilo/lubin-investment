/**
 * Tests purs sur la logique d'ajustement des splits.
 * On NE teste PAS fetchSplitEvents (réseau externe Yahoo) — c'est best-effort.
 */
import { describe, it, expect } from 'vitest';
import { cumulativeSplitFactor, adjustForSplits, splitAdjustWithDiscontinuity, type SplitEvent } from './yahooSplits.js';

/** Construit un SplitEvent minimaliste pour les tests. */
function split(dateIso: string, num: number, den: number): SplitEvent {
  const ts = Math.floor(new Date(dateIso + 'T00:00:00Z').getTime() / 1000);
  return { ts, date: dateIso, numerator: num, denominator: den };
}

/** Convertit une date ISO en unix timestamp seconds (pour appel cumulativeSplitFactor). */
function tsOf(dateIso: string): number {
  return Math.floor(new Date(dateIso + 'T00:00:00Z').getTime() / 1000);
}

describe('cumulativeSplitFactor', () => {
  it('renvoie 1 sans aucun split', () => {
    expect(cumulativeSplitFactor([], tsOf('2020-01-01'))).toBe(1);
  });

  it('renvoie 1 si tous les splits sont AVANT la date (déjà reflétés dans la valeur)', () => {
    const splits = [split('2015-06-01', 2, 1)];
    expect(cumulativeSplitFactor(splits, tsOf('2020-01-01'))).toBe(1);
  });

  it('applique un facteur ×N pour un split N:1 après la date', () => {
    const splits = [split('2024-05-15', 10, 1)];
    expect(cumulativeSplitFactor(splits, tsOf('2020-01-01'))).toBe(10);
  });

  it('applique un facteur ÷N pour un reverse split 1:N après la date', () => {
    const splits = [split('2023-08-10', 1, 5)];
    expect(cumulativeSplitFactor(splits, tsOf('2020-01-01'))).toBeCloseTo(0.2, 5);
  });

  it('multiplie les facteurs si plusieurs splits après la date', () => {
    const splits = [
      split('2018-06-01', 2, 1),  // 2:1
      split('2022-04-01', 3, 1),  // 3:1
    ];
    // 2 × 3 = 6
    expect(cumulativeSplitFactor(splits, tsOf('2015-01-01'))).toBe(6);
  });

  it("ne compte QUE les splits strictement après la date (le split même n'est pas inclus)", () => {
    const splits = [split('2024-05-15', 10, 1)];
    // Si la valeur est rapportée LE JOUR du split, on assume qu'elle est déjà post-split
    expect(cumulativeSplitFactor(splits, tsOf('2024-05-15'))).toBe(1);
    // Mais 1 jour avant = pré-split → facteur 10
    expect(cumulativeSplitFactor(splits, tsOf('2024-05-14'))).toBe(10);
  });

  it('un point post-tout-split a un facteur 1', () => {
    const splits = [
      split('2018-06-01', 2, 1),
      split('2022-04-01', 3, 1),
    ];
    expect(cumulativeSplitFactor(splits, tsOf('2025-01-01'))).toBe(1);
  });
});

describe('adjustForSplits — scénario réel BKNG (10:1 mai 2024)', () => {
  const splits = [split('2024-05-15', 10, 1)];

  it('un point 2020 doit être multiplié par 10', () => {
    // BKNG ~4.1M actions reportées en 2020 → 41M "current-basis"
    const adjusted = adjustForSplits(4_100_000, splits, tsOf('2020-12-31'));
    expect(adjusted).toBe(41_000_000);
  });

  it('un point 2025 ne doit pas être modifié', () => {
    // BKNG ~33M actions reportées en 2025 → déjà current-basis
    const adjusted = adjustForSplits(33_000_000, splits, tsOf('2025-01-15'));
    expect(adjusted).toBe(33_000_000);
  });

  it("le CAGR 5 ans devient correct (rachats nets) au lieu de fictif (+50%/an)", () => {
    const raw2020 = 4_100_000;
    const raw2025 = 33_000_000;
    const adj2020 = adjustForSplits(raw2020, splits, tsOf('2020-12-31'));
    const adj2025 = adjustForSplits(raw2025, splits, tsOf('2025-01-15'));

    const rawCagr = Math.pow(raw2025 / raw2020, 1 / 5) - 1;
    const adjCagr = Math.pow(adj2025 / adj2020, 1 / 5) - 1;

    // Sans ajustement : faux signal "+51%/an de dilution"
    expect(rawCagr).toBeGreaterThan(0.4);

    // Avec ajustement : vraie réalité, légers rachats nets (−4 à −5%/an)
    expect(adjCagr).toBeLessThan(0);
    expect(adjCagr).toBeGreaterThan(-0.1);
  });
});

describe('splitAdjustWithDiscontinuity — algo pour sources qui restate (Finnhub)', () => {
  it("no-op si aucun split", () => {
    const points = [
      { date: '2020-12-31', value: 100 },
      { date: '2021-12-31', value: 110 },
    ];
    expect(splitAdjustWithDiscontinuity(points, [])).toEqual(points);
  });

  it("détecte un saut de facteur dans la série et ajuste uniquement les points avant", () => {
    // Simulation BKNG : 5 quarters pré-restatement Finnhub, puis 1 post-restatement
    // (Finnhub a restated la dernière 10-Q après le split de avril 2026)
    const splits: SplitEvent[] = [{
      ts: Math.floor(new Date('2026-04-06T00:00:00Z').getTime() / 1000),
      date: '2026-04-06',
      numerator: 25,
      denominator: 1,
    }];
    const points = [
      { date: '2024-12-31', value: 34 },  // pré-restatement
      { date: '2025-03-31', value: 33 },  // pré-restatement
      { date: '2025-06-30', value: 33 },  // pré-restatement
      { date: '2025-09-30', value: 33 },  // pré-restatement (avant le saut)
      { date: '2026-03-31', value: 800 }, // post-restatement (×24 du précédent, dans la marge ±30% de 25)
    ];
    const adjusted = splitAdjustWithDiscontinuity(points, splits);

    // Les 4 premiers points sont multipliés par 25 (homogénéisation post-split)
    expect(adjusted[0]!.value).toBe(34 * 25);
    expect(adjusted[1]!.value).toBe(33 * 25);
    expect(adjusted[2]!.value).toBe(33 * 25);
    expect(adjusted[3]!.value).toBe(33 * 25);
    // Le dernier reste tel quel (Finnhub l'a déjà restated)
    expect(adjusted[4]!.value).toBe(800);
  });

  it("fallback date-based si aucune transition trouvée dans la série", () => {
    // Cas : toute la série est avant le split (Finnhub n'a pas encore re-fetch les vieux Q)
    const splits: SplitEvent[] = [{
      ts: Math.floor(new Date('2026-04-06T00:00:00Z').getTime() / 1000),
      date: '2026-04-06',
      numerator: 25,
      denominator: 1,
    }];
    const points = [
      { date: '2024-12-31', value: 34 },
      { date: '2025-03-31', value: 33 },
      { date: '2025-09-30', value: 33 },
    ];
    const adjusted = splitAdjustWithDiscontinuity(points, splits);
    // Aucun saut → on multiplie tout par 25 (fallback date-based)
    expect(adjusted[0]!.value).toBe(34 * 25);
    expect(adjusted[1]!.value).toBe(33 * 25);
    expect(adjusted[2]!.value).toBe(33 * 25);
  });

  it("ne touche pas une série entièrement post-split (cas où on demande seulement 1Y récent)", () => {
    const splits: SplitEvent[] = [{
      ts: Math.floor(new Date('2020-08-31T00:00:00Z').getTime() / 1000),
      date: '2020-08-31',
      numerator: 4,
      denominator: 1,
    }];
    // Série entière post-split AAPL 4:1 août 2020
    const points = [
      { date: '2023-12-31', value: 15_500_000_000 },
      { date: '2024-06-30', value: 15_400_000_000 },
      { date: '2024-12-31', value: 15_300_000_000 },
    ];
    const adjusted = splitAdjustWithDiscontinuity(points, splits);
    // Tous les ts > split.ts → cumulativeSplitFactor = 1 → pas d'ajustement
    expect(adjusted).toEqual(points);
  });
});
