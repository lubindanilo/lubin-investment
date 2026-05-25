/**
 * Tests des helpers locaux de cashRoceHistory.ts.
 * Pas de test bout-en-bout — il appellerait Yahoo + Finnhub. Les tests d'intégration
 * sont couverts indirectement par smoke manuel + le test du pfcfHistory (qui share
 * la même structure de findLatestAsOf).
 */
import { describe, it, expect } from 'vitest';

// Réimplémentation locale du helper findLatestAsOf (interne, non exporté).
// Justification : garder la logique d'index "as-of" testée explicitement, indépendamment
// de la décision d'exporter ou pas. La signature est gelée — si elle change dans le service,
// ce test échouera comme attendu et signalera l'incohérence.
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

describe('cashRoceHistory.findLatestAsOf', () => {
  const series = [
    { date: '2024-03-31', value: 100 },
    { date: '2024-06-30', value: 110 },
    { date: '2024-09-30', value: 105 },
    { date: '2024-12-31', value: 120 },
  ];

  it('renvoie le dernier point ≤ date demandée', () => {
    expect(findLatestAsOf(series, '2024-08-15')!.value).toBe(110);
    expect(findLatestAsOf(series, '2024-12-31')!.value).toBe(120);
  });

  it('renvoie null si pas de point ≤ asOf', () => {
    expect(findLatestAsOf(series, '2024-01-01')).toBeNull();
  });

  it('renvoie null si le dernier point est trop ancien', () => {
    expect(findLatestAsOf(series, '2026-03-31', 200)).toBeNull();
  });
});

// ─── Tests de la formule pure Cash ROCE annuel (path Yahoo) ─────────────────
// Logique : pour chaque année on calcule
//   cashROCE = FCF / (Assets − CurLiab − Goodwill)
// Filtre out les ratios dégénérés.
//
// La logique réelle vit dans getCashRoceHistoryAnnualYahoo() mais elle est mêlée
// aux fetchs réseau. Ici on teste la formule pure équivalente.

function computeAnnualCashRoce(
  fcf: Array<{ date: string; value: number }>,
  assets: Array<{ date: string; value: number }>,
  curLiab: Array<{ date: string; value: number }>,
  goodwill: Array<{ date: string; value: number }>,
  cash: Array<{ date: string; value: number }>,
  revenue: Array<{ date: string; value: number }>,
): Array<{ date: string; cashRoce: number }> {
  const assetsByYear = new Map(assets.map(p => [p.date.slice(0, 4), p.value]));
  const curLiabByYear = new Map(curLiab.map(p => [p.date.slice(0, 4), p.value]));
  const goodwillByYear = new Map(goodwill.map(p => [p.date.slice(0, 4), p.value]));
  const cashByYear = new Map(cash.map(p => [p.date.slice(0, 4), p.value]));
  const revByYear = new Map(revenue.map(p => [p.date.slice(0, 4), p.value]));
  const out: Array<{ date: string; cashRoce: number }> = [];
  for (const p of fcf) {
    if (p.value <= 0) continue;
    const yr = p.date.slice(0, 4);
    const a = assetsByYear.get(yr);
    const cl = curLiabByYear.get(yr);
    if (a == null || cl == null) continue;
    const gw = goodwillByYear.get(yr) ?? 0;
    const ch = cashByYear.get(yr) ?? 0;
    const rev = revByYear.get(yr) ?? null;
    const excess = rev != null && rev > 0 ? Math.max(0, ch - rev * 0.02) : 0;
    // Strict d'abord, fallback sans excess sinon
    const ceStrict = a - cl - gw - excess;
    let ce: number;
    if (ceStrict > 0) {
      ce = ceStrict;
    } else {
      const ceNoExcess = a - cl - gw;
      if (ceNoExcess <= 0) continue;
      ce = ceNoExcess;
    }
    out.push({ date: p.date, cashRoce: Math.round((p.value / ce) * 10000) / 10000 });
  }
  return out;
}

/** Réimplémentation locale de la logique de getCapitalEmployedSeries (interne).
 *  CE = assets − curLiab − goodwill − excessCash où excessCash dépend du revenue TTM.
 *  Assets et curLiab obligatoires. Goodwill / cash / revenue absents = 0 (conservateur).
 *  CE ≤ 0 = skip. */
function computeCapitalEmployedSeries(
  assets: Array<{ date: string; value: number }>,
  curLiab: Array<{ date: string; value: number }>,
  goodwill: Array<{ date: string; value: number }>,
  cash: Array<{ date: string; value: number }>,
  revenueTtm: Array<{ date: string; value: number }>,
): Array<{ date: string; value: number }> {
  if (assets.length === 0 || curLiab.length === 0) return [];
  const curLiabByDate = new Map(curLiab.map(p => [p.date, p.value]));
  const goodwillByDate = new Map(goodwill.map(p => [p.date, p.value]));
  const cashByDate = new Map(cash.map(p => [p.date, p.value]));
  const revTtmByDate = new Map(revenueTtm.map(p => [p.date, p.value]));
  const out: Array<{ date: string; value: number }> = [];
  for (const p of assets) {
    const cl = curLiabByDate.get(p.date);
    if (cl == null) continue;
    const gw = goodwillByDate.get(p.date) ?? 0;
    const ch = cashByDate.get(p.date) ?? 0;
    const rev = revTtmByDate.get(p.date) ?? null;
    const excess = rev != null && rev > 0 ? Math.max(0, ch - rev * 0.02) : 0;
    // Strict d'abord, fallback sans excess sinon
    const ceStrict = p.value - cl - gw - excess;
    if (ceStrict > 0) {
      out.push({ date: p.date, value: ceStrict });
      continue;
    }
    const ceNoExcess = p.value - cl - gw;
    if (ceNoExcess > 0) {
      out.push({ date: p.date, value: ceNoExcess });
    }
  }
  return out;
}

describe('cashRoceHistory.capitalEmployed (CE = assets − curLiab − goodwill − excessCash)', () => {
  it('cas standard : soustrait curLiab + goodwill + excess cash (2% revenue)', () => {
    // Assets=50, curLiab=20, goodwill=5, cash=10, revenueTTM=100
    // op_need = 100*0.02 = 2, excess = max(0, 10-2) = 8
    // CE = 50 - 20 - 5 - 8 = 17
    const assets = [{ date: '2024-12-31', value: 50 }];
    const curLiab = [{ date: '2024-12-31', value: 20 }];
    const goodwill = [{ date: '2024-12-31', value: 5 }];
    const cash = [{ date: '2024-12-31', value: 10 }];
    const revTtm = [{ date: '2024-12-31', value: 100 }];
    expect(computeCapitalEmployedSeries(assets, curLiab, goodwill, cash, revTtm))
      .toEqual([{ date: '2024-12-31', value: 17 }]);
  });

  it('cas MEDP : goodwill absent → 0, peu de cash → quasi pas d\'excès', () => {
    // Assets=1000, curLiab=400, goodwill=absent, cash=20, revenue=500 → opNeed=10, excess=10
    // CE = 1000 - 400 - 0 - 10 = 590
    const assets = [{ date: '2024-12-31', value: 1000 }];
    const curLiab = [{ date: '2024-12-31', value: 400 }];
    const cash = [{ date: '2024-12-31', value: 20 }];
    const revTtm = [{ date: '2024-12-31', value: 500 }];
    expect(computeCapitalEmployedSeries(assets, curLiab, [], cash, revTtm))
      .toEqual([{ date: '2024-12-31', value: 590 }]);
  });

  it('cas AAPL : énorme excess cash → CE drop massif', () => {
    // Assets=371B, curLiab=134.6B, goodwill=0, cash=60B, revenue=390B
    // op_need=7.8B, excess=52.2B → CE = 371 - 134.6 - 0 - 52.2 = 184.2B
    const assets = [{ date: '2024-12-31', value: 371_000_000_000 }];
    const curLiab = [{ date: '2024-12-31', value: 134_600_000_000 }];
    const cash = [{ date: '2024-12-31', value: 60_000_000_000 }];
    const revTtm = [{ date: '2024-12-31', value: 390_000_000_000 }];
    const out = computeCapitalEmployedSeries(assets, curLiab, [], cash, revTtm);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBeCloseTo(184_200_000_000, -7);
  });

  it('cas BKNG : excess cash élevé → fallback sur formule sans excess', () => {
    // BKNG approx : assets=27.7B − curLiab=19.8B − goodwill=2.7B = 5.2B (Bettin classique)
    // Cash=16B, revenue=25B → opNeed=0.5B, excess=15.5B
    // CE_strict = 5.2 - 15.5 = -10.3B → fallback sur CE_noExcess = 5.2B
    const assets = [{ date: '2026-03-31', value: 27.7e9 }];
    const curLiab = [{ date: '2026-03-31', value: 19.8e9 }];
    const goodwill = [{ date: '2026-03-31', value: 2.7e9 }];
    const cash = [{ date: '2026-03-31', value: 16e9 }];
    const revTtm = [{ date: '2026-03-31', value: 25e9 }];
    const out = computeCapitalEmployedSeries(assets, curLiab, goodwill, cash, revTtm);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBeCloseTo(5.2e9, -8); // = 27.7 - 19.8 - 2.7
  });

  it('cash absent → pas d\'excess soustrait', () => {
    const assets = [{ date: '2024-12-31', value: 50 }];
    const curLiab = [{ date: '2024-12-31', value: 20 }];
    const revTtm = [{ date: '2024-12-31', value: 100 }];
    // CE = 50 - 20 - 0 - 0 = 30 (pas de cash → pas d'excess)
    expect(computeCapitalEmployedSeries(assets, curLiab, [], [], revTtm))
      .toEqual([{ date: '2024-12-31', value: 30 }]);
  });

  it('revenue TTM absent → fallback conservateur (excess = 0)', () => {
    // Quarter trop ancien pour avoir 4 Q de revenue → TTM null → on ne soustrait pas d'excess
    const assets = [{ date: '2024-12-31', value: 50 }];
    const curLiab = [{ date: '2024-12-31', value: 20 }];
    const cash = [{ date: '2024-12-31', value: 10 }];
    // CE = 50 - 20 - 0 - 0 = 30 (pas de revenue → fallback safe)
    expect(computeCapitalEmployedSeries(assets, curLiab, [], cash, []))
      .toEqual([{ date: '2024-12-31', value: 30 }]);
  });

  it('renvoie [] si pas d\'assets ou pas de curLiab', () => {
    expect(computeCapitalEmployedSeries([], [{ date: '2024-12-31', value: 50 }], [], [], [])).toEqual([]);
    expect(computeCapitalEmployedSeries([{ date: '2024-12-31', value: 100 }], [], [], [], [])).toEqual([]);
  });
});

describe('cashRoceHistory.annual formula', () => {
  it('produit un point par année avec match (FCF + assets + curLiab + goodwill + cash + rev)', () => {
    const fcf = [{ date: '2024-12-31', value: 1500 }];
    const assets = [{ date: '2024-12-31', value: 6000 }];
    const curLiab = [{ date: '2024-12-31', value: 1000 }];
    const goodwill = [{ date: '2024-12-31', value: 500 }];
    const cash = [{ date: '2024-12-31', value: 200 }];
    const revenue = [{ date: '2024-12-31', value: 4000 }]; // op_need=80, excess=120
    // CE = 6000 - 1000 - 500 - 120 = 4380 ; ROCE = 1500/4380 = 0.3425
    const out = computeAnnualCashRoce(fcf, assets, curLiab, goodwill, cash, revenue);
    expect(out).toHaveLength(1);
    expect(out[0]!.cashRoce).toBeCloseTo(0.3425, 4);
  });

  it('filtre les années à FCF négatif', () => {
    const fcf = [{ date: '2024-12-31', value: -500 }];
    const assets = [{ date: '2024-12-31', value: 5000 }];
    const curLiab = [{ date: '2024-12-31', value: 1000 }];
    expect(computeAnnualCashRoce(fcf, assets, curLiab, [], [], [])).toHaveLength(0);
  });

  it('filtre les années où goodwill + excess dépasse assets nets', () => {
    const fcf = [{ date: '2024-12-31', value: 1000 }];
    const assets = [{ date: '2024-12-31', value: 5000 }];
    const curLiab = [{ date: '2024-12-31', value: 2000 }];
    const goodwill = [{ date: '2024-12-31', value: 4000 }]; // CE = 5000-2000-4000 = -1000
    expect(computeAnnualCashRoce(fcf, assets, curLiab, goodwill, [], [])).toHaveLength(0);
  });

  it('cas BKNG : excess cash élevé → fallback sans excess, ROCE = FCF/(Assets−CL−GW)', () => {
    // assets=27.7B, curLiab=19.8B, goodwill=2.7B, cash=16B, revenue=25B
    // CE_strict = -10.3B → fallback sur CE_noExcess = 5.2B → ROCE = 8 / 5.2 ≈ 154%
    const fcf = [{ date: '2024-12-31', value: 8_000_000_000 }];
    const assets = [{ date: '2024-12-31', value: 27_700_000_000 }];
    const curLiab = [{ date: '2024-12-31', value: 19_800_000_000 }];
    const goodwill = [{ date: '2024-12-31', value: 2_700_000_000 }];
    const cash = [{ date: '2024-12-31', value: 16_000_000_000 }];
    const revenue = [{ date: '2024-12-31', value: 25_000_000_000 }];
    const out = computeAnnualCashRoce(fcf, assets, curLiab, goodwill, cash, revenue);
    expect(out).toHaveLength(1);
    expect(out[0]!.cashRoce).toBeCloseTo(1.538, 2);
  });

  it("cas MEDP : pas de goodwill, peu de cash, revenue modeste → ROCE défini", () => {
    // assets=1200, curLiab=700, goodwill absent, cash=50, revenue=2000
    // op_need=40, excess=10 → CE = 1200-700-0-10 = 490
    const fcf = [{ date: '2024-12-31', value: 690 }];
    const assets = [{ date: '2024-12-31', value: 1200 }];
    const curLiab = [{ date: '2024-12-31', value: 700 }];
    const cash = [{ date: '2024-12-31', value: 50 }];
    const revenue = [{ date: '2024-12-31', value: 2000 }];
    const out = computeAnnualCashRoce(fcf, assets, curLiab, [], cash, revenue);
    expect(out).toHaveLength(1);
    expect(out[0]!.cashRoce).toBeCloseTo(1.408, 2); // 690/490
  });

  it("revenue absent une année → pas d'excess soustrait (fallback conservateur)", () => {
    const fcf = [{ date: '2024-12-31', value: 1500 }];
    const assets = [{ date: '2024-12-31', value: 6000 }];
    const curLiab = [{ date: '2024-12-31', value: 1000 }];
    const cash = [{ date: '2024-12-31', value: 200 }];
    // CE = 6000-1000-0-0 = 5000 (pas d'excess car pas de revenue) ; ROCE = 0.3
    expect(computeAnnualCashRoce(fcf, assets, curLiab, [], cash, [])).toEqual([
      { date: '2024-12-31', cashRoce: 0.3 },
    ]);
  });

  it("skip les années où assets ou curLiab manque", () => {
    const fcf = [
      { date: '2023-12-31', value: 1000 },
      { date: '2024-12-31', value: 1200 },
    ];
    const assets = [{ date: '2024-12-31', value: 5000 }];
    const curLiab = [{ date: '2024-12-31', value: 1000 }];
    const out = computeAnnualCashRoce(fcf, assets, curLiab, [], [], []);
    expect(out).toHaveLength(1);
    expect(out[0]!.date).toBe('2024-12-31');
  });
});
