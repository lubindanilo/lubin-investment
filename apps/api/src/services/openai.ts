/**
 * Service OpenAI — appelle gpt-4o (ou variant search-preview) pour les 14 critères qualitatifs.
 *
 * Deux modes :
 *   1. Modèle classique (gpt-4o-2024-11-20, etc.) — knowledge cutoff fin 2024
 *      → Réponses pour les boîtes connues mais infos 2025-2026 absentes.
 *   2. Modèle "search" (gpt-4o-search-preview, etc.) — recherche web en direct
 *      → CEO actuels, news 2026, allocations capital récentes. Coût ~2× plus cher.
 *
 * Le passage entre les deux se fait juste en changeant `OPENAI_MODEL` ou cfg.gptModel.
 * Le code détecte automatiquement et adapte la requête (les search models ne supportent
 * pas response_format json_object ni temperature).
 */
import type { Criterion } from '@lubin/shared';
import { openaiLimiter } from '../lib/limiter.js';
import { fetchWithRetry } from '../lib/retry.js';

const KEY = process.env.OPENAI_API_KEY ?? '';
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-2024-11-20';

if (!KEY) console.warn('[openai] OPENAI_API_KEY non défini — les appels échoueront');

export interface QualitativeResult {
  verdict_direct: string;
  business: Criterion[];
  management: Criterion[];
}

interface ChiffreContext { nom: string; valeur: string; statut: string }

/** Détection : les variants "search" ont des contraintes différentes (pas de json_object, pas de temperature). */
const isSearchModel = (model: string): boolean => /search/i.test(model);

export async function fetchQualitative(args: {
  ticker: string;
  company: string;
  chiffresContext: ChiffreContext[];
  sbcShareOfFcf: number | null;
}): Promise<QualitativeResult> {
  const { ticker, company, chiffresContext, sbcShareOfFcf } = args;
  const useSearch = isSearchModel(MODEL);

  const chiffres = chiffresContext.map(c => `- ${c.nom} : ${c.valeur} (${c.statut})`).join('\n');
  const sbcWarn = sbcShareOfFcf != null && sbcShareOfFcf > 0.15
    ? `\n⚠️ Stock-Based Compensation = ${(sbcShareOfFcf * 100).toFixed(0)}% du FCF (>15%) — vérifier la qualité réelle du FCF.`
    : '';

  const webSearchHint = useSearch
    ? `\n\n🌐 IMPORTANT : utilise la recherche web pour vérifier les infos POST-2024 (CEO actuel, allocations capital récentes, parts de marché, nouvelles, etc.). Cite des dates et sources si pertinent dans tes explications.`
    : `\n\n⚠️ Si une question dépend d'événements 2024-2026 et que tu n'as PAS de connaissance fiable, mets statut "warn" et explication "À vérifier — info post-cutoff".`;

  const prompt = `Tu analyses ${company} (ticker ${ticker}) selon une checklist de quality investing rigoureuse.

Les 10 critères CHIFFRÉS sont déjà calculés à partir de données fondamentales temps réel :
${chiffres}${sbcWarn}${webSearchHint}

Tu dois compléter UNIQUEMENT les 14 critères QUALITATIFS suivants.

RÈGLES STRICTES de format :
1. "nom" = libellé exact tel que listé ci-dessous, SANS préfixe "B1." "M2." etc.
2. "valeur" = une réponse CONCRÈTE et CONCISE (3-7 mots max), pas "N/A" sauf si vraiment impossible. Ex: "Non exposé", "+15%/an", "Mike Lyons (mai 2025)", "Fondateur 22 ans", "Détient 8% du capital".
3. "cible" = la cible/critère tel que listé ci-dessous.
4. "statut" = "pass" / "fail" / "warn".
5. "explication" = 1 phrase concrète${useSearch ? ', avec date si pertinent (ex: "Mike Lyons CEO depuis mai 2025")' : ''}.

BUSINESS MODEL (10 critères, dans cet ordre exact) :
- Non dépendant des matières premières → cible "Pas exposé commodity"
- Non dépendant des taux d'intérêts → cible "Pas sensible aux taux"
- Non dépendant du gouvernement → cible "Pas dépendant public"
- Marché en croissance → cible "Marché final croît"
- Asset light → cible "Peu de CapEx, peu d'actifs"
- Moat → cible "1+ moat parmi 4 types". PRÉCISE LE TYPE dans la valeur (ex: "Switching costs + Échelle").
- Revenus prévisibles → cible "Récurrence / contrats LT"
- Clientèle diversifiée → cible "Top client < 15% du CA"
- Croissance organique → cible "Pas que par M&A"
- Gagne des parts de marché → cible "Gagne vs concurrents"

MANAGEMENT (5 critères, dans cet ordre exact) :
- Allocation capital → cible "Rachats actions + M&A créatrices"
- CEO ancienneté → cible "> 5 ans, fondateur idéal"
- CEO transparence → cible "Pas de scandales, communication directe"
- CEO skin in the game → cible "Patrimoine significatif en actions"
- Rachats opportunistes → cible "Buybacks en bas de cycle, pas en haut"

verdict_direct : 1-2 phrases percutantes citant 2-3 chiffres réels du bloc ci-dessus.

Réponds en JSON STRICT, sans markdown, sans commentaire avant/après. Format exact :
{
  "verdict_direct": "...",
  "business": [10 items dans l'ordre exact ci-dessus],
  "management": [5 items dans l'ordre exact ci-dessus]
}`;

  // ─── Construction du body adaptée au type de modèle ───
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2200,
  };
  if (useSearch) {
    // Search models : pas de temperature, pas de response_format JSON
    // On peut leur indiquer la qualité de contexte qu'on veut
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
    }, { label: `openai ${useSearch ? 'search' : 'chat'}`, attempts: 3 })
  );

  const data = await res.json();
  if (data.error) {
    // Surfaçage explicite des erreurs quota OpenAI pour qu'analyze.ts puisse les détecter
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

  // Log discret pour vérifier que la recherche web a vraiment été déclenchée
  if (useSearch) {
    const annotations = data.choices?.[0]?.message?.annotations as Array<{ type: string; url_citation?: { url: string } }> | undefined;
    const citations = annotations?.filter(a => a.type === 'url_citation').length ?? 0;
    console.log(`[openai search] ${citations} citations web pour ${ticker}`);
  }

  return {
    verdict_direct: parsed.verdict_direct ?? '',
    business: ensureCibles(parsed.business ?? [], BUSINESS_CIBLES),
    management: ensureCibles(parsed.management ?? [], MGMT_CIBLES),
  };
}

/**
 * Extraction robuste de JSON depuis une réponse GPT.
 * Gère : JSON pur, JSON entouré de markdown ```json```, JSON après du texte explicatif.
 */
function extractJson(text: string): { verdict_direct?: string; business?: Criterion[]; management?: Criterion[] } | null {
  if (!text) return null;
  // Tentative 1 : parse direct
  try { return JSON.parse(text); } catch {}
  // Tentative 2 : strip markdown fences ```json ... ```
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  // Tentative 3 : premier objet JSON équilibré
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
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
