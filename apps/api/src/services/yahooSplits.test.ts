/**
 * Tests purs sur la logique d'ajustement des splits.
 * On NE teste PAS fetchSplitEvents (réseau externe Yahoo) — c'est best-effort.
 */
import { describe, it, expect } from 'vitest';
import { cumulativeSplitFactor, adjustForSplits, type SplitEvent } from './yahooSplits.js';

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

  it("le CAGR 5 ans devient correct (≈ −4%/an, rachats nets) au lieu de fictif (+50%/an)", () => {
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
