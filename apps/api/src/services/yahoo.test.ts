/**
 * Tests purs sur computeSharesCagr (la partie réseau de yahoo.ts n'est pas testée
 * ici car elle dépend du réseau externe — c'est un appel best-effort qui peut
 * silencieusement échouer en prod).
 */
import { describe, it, expect } from 'vitest';
import { computeSharesCagr, type SharesHistoryPoint } from './yahoo.js';

describe('computeSharesCagr', () => {
  it('renvoie null si la série est vide ou null', () => {
    expect(computeSharesCagr(null)).toBeNull();
    expect(computeSharesCagr([])).toBeNull();
  });

  it('renvoie null si la série n\'a qu\'un point', () => {
    expect(computeSharesCagr([{ fiscalYear: 2024, dilutedShares: 30_000_000 }])).toBeNull();
  });

  it('renvoie un CAGR négatif si rachats nets (shares décroissent)', () => {
    const history: SharesHistoryPoint[] = [
      { fiscalYear: 2020, dilutedShares: 36_000_000 },
      { fiscalYear: 2021, dilutedShares: 34_000_000 },
      { fiscalYear: 2022, dilutedShares: 32_000_000 },
      { fiscalYear: 2023, dilutedShares: 30_000_000 },
    ];
    const cagr = computeSharesCagr(history);
    expect(cagr).toBeLessThan(0);
    // (30/36)^(1/3) - 1 ≈ -0.0590
    expect(cagr).toBeCloseTo(-0.059, 3);
  });

  it('renvoie un CAGR positif si dilution', () => {
    const history: SharesHistoryPoint[] = [
      { fiscalYear: 2019, dilutedShares: 100_000_000 },
      { fiscalYear: 2024, dilutedShares: 110_000_000 },
    ];
    const cagr = computeSharesCagr(history);
    expect(cagr).toBeCloseTo(0.0193, 3); // ~+1.93%/an
  });

  it('utilise les bornes extrêmes (ignore valeurs intermédiaires pour le CAGR)', () => {
    const history: SharesHistoryPoint[] = [
      { fiscalYear: 2020, dilutedShares: 100 },
      { fiscalYear: 2021, dilutedShares: 999 },     // outlier au milieu, n'affecte pas le CAGR
      { fiscalYear: 2022, dilutedShares: 80 },
    ];
    const cagr = computeSharesCagr(history);
    // (80/100)^(1/2) - 1 ≈ -0.1056
    expect(cagr).toBeCloseTo(-0.1056, 3);
  });
});
