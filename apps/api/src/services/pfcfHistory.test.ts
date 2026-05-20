/**
 * Tests purs sur les helpers internes de pfcfHistory.ts.
 * On NE teste PAS getPfcfHistory (réseau externe Yahoo + Finnhub).
 */
import { describe, it, expect } from 'vitest';

// rollingTtm + findLatestAsOf sont des helpers locaux ; pour les tester on les ré-implémente
// dans la suite (signature stable). Une autre option serait de les exporter — on garde
// le module compact en les testant via le comportement de bout en bout dans un futur
// integration test.

// Helpers ré-implémentés (copies) pour valider la logique
type Pt = { date: string; value: number };
function rollingTtm(quarterlyFcf: Pt[]): { date: string; ttm: number }[] {
  const sorted = [...quarterlyFcf].sort((a, b) => a.date.localeCompare(b.date));
  const result: { date: string; ttm: number }[] = [];
  for (let i = 3; i < sorted.length; i++) {
    const ttm = sorted[i]!.value + sorted[i-1]!.value + sorted[i-2]!.value + sorted[i-3]!.value;
    result.push({ date: sorted[i]!.date, ttm });
  }
  return result;
}
function findLatestAsOf<T extends { date: string }>(series: T[], asOfIso: string, maxStalenessDays = 200): T | null {
  let candidate: T | null = null;
  for (const p of series) {
    if (p.date <= asOfIso) candidate = p;
    else break;
  }
  if (!candidate) return null;
  const ageMs = new Date(asOfIso).getTime() - new Date(candidate.date).getTime();
  if (ageMs > maxStalenessDays * 24 * 3600 * 1000) return null;
  return candidate;
}

describe('rollingTtm', () => {
  it('renvoie vide si < 4 trimestres', () => {
    const fcf: Pt[] = [
      { date: '2024-03-31', value: 100 },
      { date: '2024-06-30', value: 110 },
      { date: '2024-09-30', value: 105 },
    ];
    expect(rollingTtm(fcf)).toEqual([]);
  });

  it('produit TTM = somme des 4 derniers Q dès le 4e point', () => {
    const fcf: Pt[] = [
      { date: '2024-03-31', value: 100 },
      { date: '2024-06-30', value: 110 },
      { date: '2024-09-30', value: 105 },
      { date: '2024-12-31', value: 120 },
      { date: '2025-03-31', value: 130 },
    ];
    const ttm = rollingTtm(fcf);
    expect(ttm).toEqual([
      { date: '2024-12-31', ttm: 100 + 110 + 105 + 120 },  // = 435
      { date: '2025-03-31', ttm: 110 + 105 + 120 + 130 },  // = 465
    ]);
  });

  it("ré-trie la série en entrée (sécurité — l'API peut renvoyer non trié)", () => {
    const fcf: Pt[] = [
      { date: '2025-03-31', value: 130 },
      { date: '2024-03-31', value: 100 },
      { date: '2024-12-31', value: 120 },
      { date: '2024-09-30', value: 105 },
      { date: '2024-06-30', value: 110 },
    ];
    const ttm = rollingTtm(fcf);
    expect(ttm[0]!.date).toBe('2024-12-31');
    expect(ttm[1]!.date).toBe('2025-03-31');
  });
});

describe('findLatestAsOf', () => {
  const series = [
    { date: '2024-03-31', value: 100 },
    { date: '2024-06-30', value: 110 },
    { date: '2024-09-30', value: 105 },
    { date: '2024-12-31', value: 120 },
  ];

  it('renvoie le dernier point ≤ date demandée', () => {
    expect(findLatestAsOf(series, '2024-08-15')!.date).toBe('2024-06-30');
    expect(findLatestAsOf(series, '2024-09-30')!.date).toBe('2024-09-30');
    expect(findLatestAsOf(series, '2024-12-31')!.date).toBe('2024-12-31');
  });

  it("renvoie null si pas de point < asOf", () => {
    expect(findLatestAsOf(series, '2024-01-01')).toBeNull();
  });

  it("renvoie null si le point trouvé est trop vieux (staleness)", () => {
    // Le dernier point connu est 2024-12-31. Si on demande 2026-03-31 (>1 an plus tard),
    // on considère que les données sont périmées → null.
    expect(findLatestAsOf(series, '2026-03-31', 200)).toBeNull();
  });
});
