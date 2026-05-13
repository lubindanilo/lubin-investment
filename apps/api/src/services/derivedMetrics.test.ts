/**
 * Tests des fonctions pures de derivedMetrics.
 * Aucun appel réseau / DB ici — pur calcul.
 */
import { describe, it, expect } from 'vitest';
import {
  computeDerivedMetrics,
  buildQuantitativeCriteria,
  buildValuation,
  filterNews,
} from './derivedMetrics.js';
import type { FinnhubNewsItem } from './finnhub.js';

describe('computeDerivedMetrics', () => {
  it('renvoie tous les champs null quand les inputs sont vides', () => {
    const m = computeDerivedMetrics({ metric: null, profile: null, quote: null });
    expect(m.netMargin).toBeNull();
    expect(m.revenueCagr).toBeNull();
    expect(m.pfcfTTM).toBeNull();
    expect(m.price).toBeNull();
  });

  it('extrait price + pfcfTTM + métriques de croissance', () => {
    const m = computeDerivedMetrics({
      metric: {
        metric: {
          revenueGrowth5Y: 22.27,
          revenueShareGrowth5Y: 28.39,   // > revenueGrowth → rachats nets
          epsGrowth5Y: 31.7,
          pfcfShareTTM: 16.7,
          revenuePerShareTTM: 92.5,
          peTTM: 25.8,
          netProfitMarginTTM: 17.2,
          enterpriseValue: 11207,
          marketCapitalization: 11859,
          roi5Y: 54.6,
          operatingMarginTTM: 18,
          operatingMargin5Y: 14,
          currentRatioAnnual: 0.85,
        },
      },
      profile: { name: 'Medpace Holdings Inc' },
      quote: { c: 415.27, d: 0, dp: 0, h: 0, l: 0, pc: 0 },
    });

    expect(m.price).toBe(415.27);
    expect(m.pfcfTTM).toBe(16.7);
    expect(m.revenueCagr).toBeCloseTo(0.2227, 4);
    expect(m.fcfPerShareCagr).toBeCloseTo(0.317, 4);
    expect(m.netMargin).toBeCloseTo(0.172, 4);
    expect(m.cashROCE).toBeCloseTo(0.546, 4);
    expect(m.operatingLeverage).toBe(true);
    expect(m.nwc).toBe(-1);
    expect(m.netDebtFcf).toBeLessThan(0);
    // shareCagr = (1.2227 / 1.2839) − 1 ≈ -0.0477
    expect(m.shareCagr).toBeCloseTo(-0.0477, 3);
  });

  it('shareCagr null si une des deux métriques manque', () => {
    const m1 = computeDerivedMetrics({
      metric: { metric: { revenueGrowth5Y: 22.27 } },
      profile: null, quote: null,
    });
    expect(m1.shareCagr).toBeNull();

    const m2 = computeDerivedMetrics({
      metric: { metric: { revenueShareGrowth5Y: 28.39 } },
      profile: null, quote: null,
    });
    expect(m2.shareCagr).toBeNull();
  });

  it('shareCagr positif si dilution (rev/share croît moins vite que rev total)', () => {
    const m = computeDerivedMetrics({
      metric: { metric: { revenueGrowth5Y: 20, revenueShareGrowth5Y: 15 } },
      profile: null, quote: null,
    });
    // (1.20 / 1.15) - 1 ≈ +0.0435
    expect(m.shareCagr).toBeCloseTo(0.0435, 3);
    expect(m.shareCagr).toBeGreaterThan(0);
    expect(m.shareCagrSource).toBe('finnhub-derived');
  });

  it('shareCagr priorise Yahoo sur la dérivation Finnhub', () => {
    const m = computeDerivedMetrics({
      // Finnhub dirait dilution +4.35%/an, mais Yahoo dit -2%/an
      metric: { metric: { revenueGrowth5Y: 20, revenueShareGrowth5Y: 15 } },
      profile: null, quote: null,
      yahooShareCagr: -0.02,
    });
    expect(m.shareCagr).toBe(-0.02);
    expect(m.shareCagrSource).toBe('yahoo');
  });

  it('shareCagr fallback Finnhub si Yahoo absent', () => {
    const m = computeDerivedMetrics({
      metric: { metric: { revenueGrowth5Y: 20, revenueShareGrowth5Y: 15 } },
      profile: null, quote: null,
      yahooShareCagr: null,
    });
    expect(m.shareCagrSource).toBe('finnhub-derived');
  });

  it('shareCagrSource null si aucune source disponible', () => {
    const m = computeDerivedMetrics({ metric: null, profile: null, quote: null });
    expect(m.shareCagr).toBeNull();
    expect(m.shareCagrSource).toBeNull();
  });
});

describe('buildQuantitativeCriteria', () => {
  it('produit exactement 11 critères', () => {
    const m = computeDerivedMetrics({ metric: null, profile: null, quote: null });
    const criteres = buildQuantitativeCriteria(m);
    expect(criteres).toHaveLength(11);
  });

  it('inclut "Évolution nombre d\'actions 5 ans" en position 4', () => {
    const m = computeDerivedMetrics({ metric: null, profile: null, quote: null });
    const criteres = buildQuantitativeCriteria(m);
    expect(criteres[3]?.nom).toMatch(/Évolution.*actions/i);
  });

  it('renvoie statut warn pour les critères dont la donnée manque', () => {
    const m = computeDerivedMetrics({ metric: null, profile: null, quote: null });
    const criteres = buildQuantitativeCriteria(m);
    criteres.forEach(c => expect(c.statut).toBe('warn'));
  });

  it('shareCagr négatif → critère pass + libellé "rachats nets"', () => {
    const m = computeDerivedMetrics({
      metric: { metric: { revenueGrowth5Y: 22.27, revenueShareGrowth5Y: 28.39 } },
      profile: null, quote: null,
    });
    const c = buildQuantitativeCriteria(m)[3]!;
    expect(c.statut).toBe('pass');
    expect(c.explication.toLowerCase()).toContain('rachats');
  });

  it('shareCagr forte dilution → fail', () => {
    const m = computeDerivedMetrics({
      metric: { metric: { revenueGrowth5Y: 10, revenueShareGrowth5Y: 5 } },
      profile: null, quote: null,
    });
    const c = buildQuantitativeCriteria(m)[3]!;
    // (1.10/1.05) - 1 ≈ +4.76% → fail
    expect(c.statut).toBe('fail');
  });

  it('classifie Medpace en pass majoritaire (cas réel)', () => {
    const m = computeDerivedMetrics({
      metric: {
        metric: {
          revenueGrowth5Y: 22.27,
          revenueShareGrowth5Y: 28.39,
          epsGrowth5Y: 31.7,
          pfcfShareTTM: 16.7,
          revenuePerShareTTM: 92.5,
          peTTM: 25.8,
          netProfitMarginTTM: 17.2,
          enterpriseValue: 11207,
          marketCapitalization: 11859,
          roi5Y: 54.6,
          operatingMarginTTM: 18,
          operatingMargin5Y: 14,
          currentRatioAnnual: 0.85,
        },
      },
      profile: { name: 'Medpace' },
      quote: { c: 415.27, d: 0, dp: 0, h: 0, l: 0, pc: 0 },
    });
    const criteres = buildQuantitativeCriteria(m);
    const passCount = criteres.filter(c => c.statut === 'pass').length;
    expect(passCount).toBeGreaterThanOrEqual(9); // au moins 9/11 pour Medpace
  });
});

describe('buildValuation (DCF Buffett)', () => {
  it('renvoie warn quand prix ou P/FCF manque', () => {
    const m = computeDerivedMetrics({ metric: null, profile: null, quote: null });
    const v = buildValuation(m, { targetReturn: 0.15, fcfGrowth: 0.1, targetMultiple: 20 });
    expect(v.statut).toBe('warn');
    expect(v.buyPrice).toBeNull();
  });

  it('calcule le prix d\'achat selon la formule Buffett', () => {
    // Prix 100$, P/FCF 20× → FCF/share = 5$
    const m = computeDerivedMetrics({
      metric: { metric: { pfcfShareTTM: 20 } },
      profile: null,
      quote: { c: 100, d: 0, dp: 0, h: 0, l: 0, pc: 0 },
    });
    const v = buildValuation(m, { targetReturn: 0.15, fcfGrowth: 0.10, targetMultiple: 20 });

    // FCF_5Y = 5 × 1.10^5 = 8.05525
    // Exit  = 20 × 8.05525 = 161.105
    // Buy   = 161.105 / 1.15^5 = 80.10 (env)
    expect(v.buyPrice).toBeCloseTo(80.10, 1);
    expect(v.statut).toBe('fail'); // 100 > buyPrice → trop cher
  });
});

describe('filterNews', () => {
  const make = (headline: string, summary = ''): FinnhubNewsItem => ({
    category: 'company',
    datetime: Math.floor(Date.now() / 1000),
    headline,
    image: '',
    related: 'TEST',
    source: 'Yahoo',
    summary,
    url: 'https://example.com',
  });

  it('drop les class actions et clickbait', () => {
    const news = filterNews([
      make('Class Action Lawsuit Filed Against MEDP'),
      make('MEDP Securities Fraud Alert — Deadline June 2026'),
      make('PACS vs. MEDP: Which Stock Is Better?'),
    ]);
    expect(news).toHaveLength(0);
  });

  it('garde résultats / rachats / dividendes / M&A / mgmt', () => {
    const news = filterNews([
      make('Medpace Q1 2026 Earnings Beat Estimates'),
      make('Company Announces $500M Share Buyback Program'),
      make('Board Declares Quarterly Dividend Increase'),
      make('CEO John Doe Resigns After 15 Years'),
      make('Apple to Acquire Anthropic in $50B Deal'),
    ]);
    expect(news.map(n => n.type).sort()).toEqual(['M&A', 'dividende', 'mgmt', 'rachat', 'résultats']);
  });

  it('cap à 5 items', () => {
    const lots = Array.from({ length: 10 }, (_, i) => make(`Q${(i % 4) + 1} 2026 earnings result ${i}`));
    expect(filterNews(lots)).toHaveLength(5);
  });
});
