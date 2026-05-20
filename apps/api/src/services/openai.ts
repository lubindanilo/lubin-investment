/**
 * Service OpenAI — appelle gpt-4o (ou variant search-preview) pour les critères qualitatifs.
 *
 * Architecture : 2 fonctions SÉPARÉES (split du single-call historique)
 *   - fetchBusinessAnalysis  → 10 critères business + verdict_direct (lifetime cache côté DB)
 *   - fetchManagementAnalysis → 5 critères management (refreshable côté DB)
 *
 * Pourquoi 2 calls : permet de cacher le business à vie sans bloquer le management,
 * et de rafraîchir le management sans re-générer le business. Coût total identique
 * (même contexte, même output) — on paie juste 2 prompts au lieu d'1 quand on génère
 * les deux la 1re fois, mais après le coût est 0 sur les hits cache.
 *
 * Deux modes de modèle :
 *   1. Modèle classique (gpt-4o-2024-11-20) — knowledge cutoff fin 2024
 *   2. Modèle "search" (gpt-4o-search-preview) — recherche web en direct (~2× plus cher)
 *
 * Le passage entre les deux se fait via la var d'env OPENAI_MODEL.
 */
import type { Criterion } from '@lubin/shared';
import { openaiLimiter } from '../lib/limiter.js';
import { fetchWithRetry } from '../lib/retry.js';

const KEY = process.env.OPENAI_API_KEY ?? '';
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-2024-11-20';

if (!KEY) console.warn('[openai] OPENAI_API_KEY non défini — les appels échoueront');

export interface BusinessAnalysisResult {
  verdict_direct: string;
  business: Criterion[];
}

export interface ManagementAnalysisResult {
  management: Criterion[];
}

interface ChiffreContext { nom: string; valeur: string; statut: string }

/** Détection : les variants "search" ont des contraintes différentes (pas de json_object, pas de temperature). */
const isSearchModel = (model: string): boolean => /search/i.test(model);

// ─── Helper commun : appelle OpenAI avec un prompt donné ─────────────────

async function callOpenAi(prompt: string, label: string): Promise<unknown> {
  const useSearch = isSearchModel(MODEL);
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1800,
  };
  if (useSearch) {
    body.web_search_options = { search_context_size: 'medium' };
  } else {
    body.temperature = 0.2;
    body.response_format = { type: 'json_object' };
  }

  const res = await openaiLimiter.schedule(() =>
    fetchWithRetry('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    }, { label: `openai ${useSearch ? 'search' : 'chat'} ${label}`, attempts: 3 })
  );

  const data = await res.json();
  if (data.error) {
    const code = data.error.code ?? '';
    const msg = data.error.message ?? '';
    if (/insufficient_quota|exceeded_quota|billing/i.test(code) || /quota/i.test(msg)) {
      throw new Error(`OpenAI quota : ${msg || 'budget mensuel atteint'}`);
    }
    throw new Error(`OpenAI : ${msg}`);
  }

  const content: string = data.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(content);
  if (!parsed) throw new Error('OpenAI : réponse non-JSON');

  if (useSearch) {
    const annotations = data.choices?.[0]?.message?.annotations as Array<{ type: string }> | undefined;
    const citations = annotations?.filter(a => a.type === 'url_citation').length ?? 0;
    console.log(`[openai search ${label}] ${citations} citations web`);
  }
  return parsed;
}

// ─── Construction des prompts ─────────────────────────────────────────────

function buildContextBlock(ticker: string, company: string, chiffres: ChiffreContext[], sbcShareOfFcf: number | null): string {
  const chiffresStr = chiffres.map(c => `- ${c.nom} : ${c.valeur} (${c.statut})`).join('\n');
  const sbcWarn = sbcShareOfFcf != null && sbcShareOfFcf > 0.15
    ? `\n⚠️ Stock-Based Compensation = ${(sbcShareOfFcf * 100).toFixed(0)}% du FCF (>15%) — vérifier la qualité réelle du FCF.`
    : '';
  return `Tu analyses ${company} (ticker ${ticker}) selon une checklist de quality investing rigoureuse.

Les 10 critères CHIFFRÉS sont déjà calculés à partir de données fondamentales temps réel :
${chiffresStr}${sbcWarn}`;
}

function webSearchHint(): string {
  return isSearchModel(MODEL)
    ? `\n\n🌐 IMPORTANT : utilise la recherche web pour vérifier les infos POST-2024 (CEO actuel, allocations capital récentes, parts de marché, nouvelles, etc.). Cite des dates et sources si pertinent dans tes explications.`
    : `\n\n⚠️ Si une question dépend d'événements 2024-2026 et que tu n'as PAS de connaissance fiable, mets statut "warn" et explication "À vérifier — info post-cutoff".`;
}

// ─── Business analysis (10 critères + verdict_direct) ──────────────────────

export async function fetchBusinessAnalysis(args: {
  ticker: string;
  company: string;
  chiffresContext: ChiffreContext[];
  sbcShareOfFcf: number | null;
}): Promise<BusinessAnalysisResult> {
  const { ticker, company, chiffresContext, sbcShareOfFcf } = args;
  const useSearch = isSearchModel(MODEL);

  const prompt = `${buildContextBlock(ticker, company, chiffresContext, sbcShareOfFcf)}${webSearchHint()}

Tu dois compléter UNIQUEMENT les 10 critères de BUSINESS MODEL ci-dessous + un verdict_direct.

RÈGLES STRICTES de format :
1. "nom" = libellé exact tel que listé ci-dessous, SANS préfixe.
2. "valeur" = une réponse CONCRÈTE et CONCISE (3-7 mots max), pas "N/A" sauf si vraiment impossible. Ex: "Non exposé", "+15%/an", "Switching costs + Échelle".
3. "cible" = la cible tel que listée ci-dessous.
4. "statut" = "pass" / "fail" / "warn".
5. "explication" = 1 phrase concrète${useSearch ? ', avec date si pertinent' : ''}.

BUSINESS MODEL (10 critères, dans cet ordre exact) :
- Non dépendant des matières premières → cible "Pas exposé commodity"
- Non dépendant des taux d'intérêts → cible "Pas sensible aux taux"
- Non dépendant du gouvernement → cible "Pas dépendant public"
- Marché en croissance → cible "Marché final croît"
- Asset light → cible "Peu de CapEx, peu d'actifs"
- Moat → cible "1+ moat parmi 4 types". PRÉCISE LE TYPE dans la valeur.
- Revenus prévisibles → cible "Récurrence / contrats LT"
- Clientèle diversifiée → cible "Top client < 15% du CA"
- Croissance organique → cible "Pas que par M&A"
- Gagne des parts de marché → cible "Gagne vs concurrents"

verdict_direct : 1-2 phrases percutantes citant 2-3 chiffres réels du bloc ci-dessus.

Réponds en JSON STRICT, sans markdown, sans commentaire avant/après. Format exact :
{
  "verdict_direct": "...",
  "business": [10 items dans l'ordre exact ci-dessus]
}`;

  const parsed = await callOpenAi(prompt, `business ${ticker}`) as { verdict_direct?: string; business?: Criterion[] };
  return {
    verdict_direct: parsed.verdict_direct ?? '',
    business: ensureCibles(parsed.business ?? [], BUSINESS_CIBLES),
  };
}

// ─── Management analysis (5 critères) ──────────────────────────────────────

export async function fetchManagementAnalysis(args: {
  ticker: string;
  company: string;
  chiffresContext: ChiffreContext[];
  sbcShareOfFcf: number | null;
}): Promise<ManagementAnalysisResult> {
  const { ticker, company, chiffresContext, sbcShareOfFcf } = args;
  const useSearch = isSearchModel(MODEL);

  const prompt = `${buildContextBlock(ticker, company, chiffresContext, sbcShareOfFcf)}${webSearchHint()}

Tu dois compléter UNIQUEMENT les 5 critères de MANAGEMENT ci-dessous.

RÈGLES STRICTES de format :
1. "nom" = libellé exact tel que listé ci-dessous, SANS préfixe.
2. "valeur" = réponse CONCRÈTE et CONCISE (3-7 mots max). Ex: "Mike Lyons (mai 2025)", "Fondateur 22 ans", "Détient 8% du capital".
3. "cible" = la cible tel que listée ci-dessous.
4. "statut" = "pass" / "fail" / "warn".
5. "explication" = 1 phrase concrète${useSearch ? ', avec date si pertinent (ex: "Mike Lyons CEO depuis mai 2025")' : ''}.

MANAGEMENT (5 critères, dans cet ordre exact) :
- Allocation capital → cible "Rachats actions + M&A créatrices"
- CEO ancienneté → cible "> 5 ans, fondateur idéal"
- CEO transparence → cible "Pas de scandales, communication directe"
- CEO skin in the game → cible "Patrimoine significatif en actions"
- Rachats opportunistes → cible "Buybacks en bas de cycle, pas en haut"

Réponds en JSON STRICT, sans markdown, sans commentaire avant/après. Format exact :
{
  "management": [5 items dans l'ordre exact ci-dessus]
}`;

  const parsed = await callOpenAi(prompt, `management ${ticker}`) as { management?: Criterion[] };
  return {
    management: ensureCibles(parsed.management ?? [], MGMT_CIBLES),
  };
}

// ─── Helpers internes ──────────────────────────────────────────────────────

function extractJson(text: string): { verdict_direct?: string; business?: Criterion[]; management?: Criterion[] } | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

const BUSINESS_CIBLES = [
  'Pas exposé commodity',
  'Pas sensible aux taux',
  'Pas dépendant public',
  'Marché final croît',
  'Peu de CapEx, peu d\'actifs',
  '1+ moat parmi 4 types',
  'Récurrence / contrats LT',
  'Top client < 15% du CA',
  'Pas que par M&A',
  'Gagne vs concurrents',
];

const MGMT_CIBLES = [
  'Rachats actions + M&A créatrices',
  '> 5 ans, fondateur idéal',
  'Pas de scandales, communication directe',
  'Patrimoine significatif en actions',
  'Buybacks en bas de cycle, pas en haut',
];

function ensureCibles(items: Criterion[], cibles: string[]): Criterion[] {
  return items.map((it, i) => ({ ...it, cible: it.cible || cibles[i] || '' }));
}
