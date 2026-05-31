/**
 * Série de prix compacte (closes mensuels ~1 an) pour les sparklines du screener.
 * Yahoo /v8/finance/chart (public, pas de crumb). Résout le symbole via yahooResolve
 * (US → bare, EU → suffixe). Renvoie [] en cas d'échec — non bloquant.
 */
import { yahooLimiter } from '../lib/limiter.js';
import { resolveYahooTicker } from './yahooResolve.js';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Lubin-Investment/0.1';

export async function getSparkSeries(ticker: string, months = 13): Promise<number[]> {
  return yahooLimiter.schedule(async () => {
    try {
      const resolved = await resolveYahooTicker(ticker).catch(() => null);
      const sym = resolved?.symbol ?? ticker;
      const period2 = Math.floor(Date.now() / 1000);
      const period1 = period2 - 400 * 24 * 3600; // ~13 mois
      const url = `${CHART_BASE}/${encodeURIComponent(sym)}?interval=1mo&period1=${period1}&period2=${period2}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) return [];
      const data = await res.json() as { chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> } };
      const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (!Array.isArray(closes)) return [];
      return closes.filter((v): v is number => typeof v === 'number' && v > 0).slice(-months);
    } catch {
      return [];
    }
  });
}
