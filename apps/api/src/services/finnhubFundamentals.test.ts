/**
 * Tests purs sur les formules FCF (computeFcfBrut + computeFcfAdj).
 *
 * Pourquoi ces tests existent : un bug critique (commit 1031836) avait survécu
 * 3 mois sans être détecté — on faisait `cfo + capex` au lieu de `cfo - |capex|`,
 * doublant ainsi le FCF pour TOUS les US tickers. Ces tests garantissent que la
 * formule reste correcte si quelqu'un refactor un jour.
 */
import { describe, it, expect } from 'vitest';
import { computeFcfBrut, computeFcfAdj } from './finnhubFundamentals.js';

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
