/**
 * Tests purs sur les formules FCF (computeFcfBrut + computeFcfAdj).
 *
 * Pourquoi ces tests existent : un bug critique (commit 1031836) avait survécu
 * 3 mois sans être détecté — on faisait `cfo + capex` au lieu de `cfo - |capex|`,
 * doublant ainsi le FCF pour TOUS les US tickers. Ces tests garantissent que la
 * formule reste correcte si quelqu'un refactor un jour.
 */
import { describe, it, expect } from 'vitest';
import { computeFcfBrut, computeFcfAdj, computeTotalDebt, computeCashAndEquivalents, computeExcessCash, OPERATING_CASH_PCT_OF_REVENUE } from './finnhubFundamentals.js';

describe('computeFcfBrut (FCF = CFO − |CapEx|)', () => {
  it('soustrait CapEx positif (cas standard Finnhub)', () => {
    // Cas AMZN 2025 : CFO=$140B, CapEx=$132B reportés POSITIFS dans Finnhub
    //   FCF réel = 140 − 132 = $7.7B (pas 140 + 132 = $272B!)
    expect(computeFcfBrut(139_510_000_000, 131_820_000_000)).toBeCloseTo(7_690_000_000, -3);
  });

  it("soustrait CapEx même si Finnhub renvoie une valeur négative (sécurité avec Math.abs)", () => {
    // Au cas où certains tickers/filings rapporteraient CapEx avec signe négatif
    expect(computeFcfBrut(100_000, -30_000)).toBe(70_000);
    expect(computeFcfBrut(100_000, 30_000)).toBe(70_000);
  });

  it('renvoie null si CFO est null', () => {
    expect(computeFcfBrut(null, 50_000)).toBeNull();
  });

  it('renvoie CFO seul si CapEx est null (boîte sans capex significatif)', () => {
    expect(computeFcfBrut(100_000, null)).toBe(100_000);
  });

  it('peut renvoyer un FCF négatif (cas légitime quand CapEx > CFO)', () => {
    // Cas Tesla 2017 en mode growth : CFO faible, CapEx massif
    expect(computeFcfBrut(2_000_000_000, 4_000_000_000)).toBe(-2_000_000_000);
  });
});

describe('computeFcfAdj (FCF_adj = CFO − |CapEx| − SBC)', () => {
  it('soustrait aussi la SBC', () => {
    // Cas META 2025 : CFO=$116B, CapEx=$70B, SBC=$20B → FCF_adj = 116 - 70 - 20 = $26B
    expect(computeFcfAdj(115_800_000_000, 69_690_000_000, 20_430_000_000)).toBeCloseTo(25_680_000_000, -3);
  });

  it('renvoie FCF brut si SBC est null (boîte sans SBC)', () => {
    expect(computeFcfAdj(100_000, 30_000, null)).toBe(70_000);
  });

  it('renvoie null si CFO est null', () => {
    expect(computeFcfAdj(null, 30_000, 10_000)).toBeNull();
  });

  it("peut révéler un FCF_adj négatif quand SBC > FCF brut (cas AMZN 2025)", () => {
    // AMZN 2025 : CFO=$140B, CapEx=$132B, SBC=$19B
    //   FCF brut = $7.7B, FCF_adj = $7.7B - $19B = -$11.3B
    //   La SBC dépasse le FCF brut → destruction de valeur pour actionnaires existants
    const fcfAdj = computeFcfAdj(139_510_000_000, 131_820_000_000, 19_470_000_000);
    expect(fcfAdj).toBeLessThan(0);
    expect(fcfAdj).toBeCloseTo(-11_780_000_000, -3);
  });
});

describe('computeTotalDebt (somme LT + ST + leases, dédoublonnage LT)', () => {
  const empty = {
    longTermDebtAggregate: null, longTermDebtNoncurrent: null, longTermDebtCurrent: null,
    shortTermBorrowings: null, operatingLeaseNoncurrent: null, operatingLeaseCurrent: null,
    financeLeaseNoncurrent: null, financeLeaseCurrent: null,
  };

  it('renvoie null quand TOUTES les composantes sont absentes (boîte sans dette)', () => {
    expect(computeTotalDebt(empty)).toBeNull();
  });

  it('cas BKNG : somme NonCurrent + Current + op lease, pas d\'agrégé', () => {
    // BKNG 2026-Q1 réel : LongTermDebtNoncurrent=$15.4B, LongTermDebtCurrent=$3.015B,
    // OperatingLeaseNoncurrent=$530M
    expect(computeTotalDebt({
      ...empty,
      longTermDebtNoncurrent: 15_400_000_000,
      longTermDebtCurrent: 3_015_000_000,
      operatingLeaseNoncurrent: 530_000_000,
    })).toBe(18_945_000_000);
  });

  it('préfère LongTermDebt agrégé quand présent (anti double-count NonCurrent + Current)', () => {
    // Si une boîte rapporte LongTermDebt=$20B ET sépare NonCurrent=$15B + Current=$5B,
    // on ne doit PAS additionner les 3 (= $40B). On prend LongTermDebt seul ($20B).
    expect(computeTotalDebt({
      ...empty,
      longTermDebtAggregate: 20_000_000_000,
      longTermDebtNoncurrent: 15_000_000_000,
      longTermDebtCurrent: 5_000_000_000,
      operatingLeaseNoncurrent: 1_000_000_000,
    })).toBe(21_000_000_000); // = 20B agrégé + 1B lease
  });

  it('inclut short-term borrowings + finance lease', () => {
    expect(computeTotalDebt({
      ...empty,
      longTermDebtNoncurrent: 10_000_000_000,
      shortTermBorrowings: 2_000_000_000,
      financeLeaseNoncurrent: 500_000_000,
      financeLeaseCurrent: 100_000_000,
    })).toBe(12_600_000_000);
  });

  it('renvoie 0 quand toutes les composantes valent 0 (pas null)', () => {
    // 0 explicite n'est pas un "missing" — on a vraiment trouvé 0 partout
    const zeros = {
      longTermDebtAggregate: 0, longTermDebtNoncurrent: 0, longTermDebtCurrent: 0,
      shortTermBorrowings: 0, operatingLeaseNoncurrent: 0, operatingLeaseCurrent: 0,
      financeLeaseNoncurrent: 0, financeLeaseCurrent: 0,
    };
    expect(computeTotalDebt(zeros)).toBe(0);
  });
});

describe('computeCashAndEquivalents (somme cash + STI)', () => {
  it('somme cash et short-term investments', () => {
    // AAPL approx : cash $30B + STI $30B = $60B
    expect(computeCashAndEquivalents({ cash: 30_000_000_000, shortTermInvestments: 30_000_000_000 }))
      .toBe(60_000_000_000);
  });

  it('renvoie cash seul si pas de STI (cas BKNG)', () => {
    expect(computeCashAndEquivalents({ cash: 16_000_000_000, shortTermInvestments: null }))
      .toBe(16_000_000_000);
  });

  it('renvoie null quand les deux sont absents (boîte sans cash listé)', () => {
    expect(computeCashAndEquivalents({ cash: null, shortTermInvestments: null })).toBeNull();
  });

  it('renvoie 0 explicitement quand les deux valent 0', () => {
    expect(computeCashAndEquivalents({ cash: 0, shortTermInvestments: 0 })).toBe(0);
  });
});

describe('computeExcessCash (heuristique Damodaran 2% du revenue)', () => {
  it('constante OPERATING_CASH_PCT_OF_REVENUE = 0.02', () => {
    expect(OPERATING_CASH_PCT_OF_REVENUE).toBe(0.02);
  });

  it('cas AAPL : cash $60B sur revenue $390B → excess = $60B − $7.8B = $52.2B', () => {
    expect(computeExcessCash(60_000_000_000, 390_000_000_000)).toBeCloseTo(52_200_000_000, -3);
  });

  it("cas MEDP : cash modeste, revenue $2B → besoin op $40M → excess proche du cash", () => {
    // MEDP type : cash $400M, revenue $2B → op need = $40M, excess = $360M
    expect(computeExcessCash(400_000_000, 2_000_000_000)).toBe(360_000_000);
  });

  it('renvoie 0 si cash ≤ 2 % du revenue (tout le cash est opérationnel)', () => {
    // Boîte cash-poor : cash $10M, revenue $1B → op need $20M → cash entièrement opérationnel
    expect(computeExcessCash(10_000_000, 1_000_000_000)).toBe(0);
  });

  it('renvoie 0 si cash est null ou ≤ 0', () => {
    expect(computeExcessCash(null, 1_000_000_000)).toBe(0);
    expect(computeExcessCash(0, 1_000_000_000)).toBe(0);
    expect(computeExcessCash(-100, 1_000_000_000)).toBe(0);
  });

  it("renvoie 0 (conservateur) si revenue est null — on ne devine pas le besoin opérationnel", () => {
    // Fallback safe : pas de revenue → pas d'hypothèse → pas d'excès soustrait
    expect(computeExcessCash(60_000_000_000, null)).toBe(0);
    expect(computeExcessCash(60_000_000_000, 0)).toBe(0);
    expect(computeExcessCash(60_000_000_000, -100)).toBe(0);
  });

  it('accepte un pourcentage opérationnel custom (override de la constante)', () => {
    // Si l'utilisateur veut un seuil différent (ex 5% pour les retailers à fort BFR)
    expect(computeExcessCash(100_000_000, 1_000_000_000, 0.05)).toBe(50_000_000); // op need = 50M, excess = 50M
  });
});
