# Lubin Investment

Application web d'analyse fondamentale d'actions (style Interactive Brokers, theme clair).

- 25 critères de quality investing : 10 chiffrés (calculés depuis Finnhub) + 14 qualitatifs (GPT) + 1 valorisation DCF
- Watchlist persistante avec P/FCF et score chiffres en temps réel
- News filtrées des 60 derniers jours
- Cache qualitatif 30 jours (1 appel GPT par ticker)

## Stack

- **Frontend** : Vite + React + TypeScript + Pure CSS
- **Backend** : Node + Express + TypeScript
- **DB** : Postgres (Docker en local, Neon en prod)
- **ORM** : Prisma
- **Monorepo** : pnpm workspaces
- **APIs externes** (clés côté serveur uniquement) : OpenAI, Finnhub, Financial Modeling Prep

## Structure

```
lubin-investment/
├── apps/
│   ├── web/                     # React frontend (port 5173)
│   └── api/                     # Express backend (port 3001)
├── packages/
│   └── shared/                  # Types TS partagés
├── cron/                        # (Phase 4 — jobs schedulés)
├── docker-compose.yml           # Postgres local
├── .env.example
└── pnpm-workspace.yaml
```

## Setup local (premier lancement)

### 1. Pré-requis

- Node 22+
- pnpm 9+ (installé via `corepack enable && corepack prepare pnpm@latest --activate`)
- Docker Desktop

### 2. Install des dépendances

```bash
cd lubin-investment
pnpm install
```

### 3. Variables d'environnement

```bash
cp .env.example .env
# Édite .env et remplis OPENAI_API_KEY, FINNHUB_API_KEY, FMP_API_KEY (optionnel)
```

### 4. Démarrer Postgres

```bash
pnpm db:up           # docker compose up postgres en arrière-plan
pnpm db:migrate      # crée les tables (WatchlistEntry, QualitativeCache)
```

### 5. Lancer le dev

```bash
pnpm dev             # lance Vite (web) + Express (api) en parallèle
```

- Web : http://localhost:5173
- API : http://localhost:3001
- Health-check API : http://localhost:3001/health

## Scripts utiles

| Commande | Effet |
|---|---|
| `pnpm dev` | **Tout-en-un** : auto-start Docker + Postgres puis lance Web + API en parallèle |
| `pnpm dev:web` | Frontend seul (auto-start DB aussi) |
| `pnpm dev:api` | Backend seul (auto-start DB aussi) |
| `pnpm clean` | Tue tous les processus zombies sur ports 3001/5173 (utile après un crash) |
| `pnpm db:up` | Force-start Docker + Postgres (idempotent, safe à appeler) |
| `pnpm db:down` | Arrête Postgres (Docker reste) |
| `pnpm db:logs` | Tail des logs Postgres |
| `pnpm db:migrate` | Applique les migrations Prisma (à faire après chaque modif du schema) |
| `pnpm db:studio` | UI graphique Prisma pour explorer la DB |
| `pnpm build` | Build de tous les packages |
| `pnpm test` | Tests Vitest (33 tests sur l'API) |

### Démarrage zéro-effort

Tu peux `pnpm dev` même si Docker Desktop n'est pas ouvert : le hook `predev`
(via `scripts/ensure-db.sh`) :
1. Lance Docker.app si nécessaire (attend jusqu'à 60 s qu'il soit prêt)
2. Démarre le container `lubin-postgres` si arrêté, le crée si absent
3. Vérifie que Postgres répond avant de passer la main à `pnpm dev`

Tu fermes ton Mac, tu reviens demain, `pnpm dev` → tout repart tout seul.

## Endpoints API

| Méthode | Route | Effet |
|---|---|---|
| GET | `/health` | Health-check + check des clés |
| GET | `/api/analyze?ticker=MEDP` | Analyse complète (chiffres + qualitatif + valo + news) |
| POST | `/api/analyze/revalue` | Recalcule la valo avec params `{ ticker, params: ValoParams }` |
| POST | `/api/analyze/refresh-qual` | Force re-fetch GPT pour `{ ticker }` (bypass cache) |
| GET | `/api/watchlist` | Liste la watchlist |
| POST | `/api/watchlist` | Ajoute `{ ticker }` |
| DELETE | `/api/watchlist/:ticker` | Retire |
| POST | `/api/watchlist/refresh` | Refresh tous les snapshots |

## Tests

```bash
pnpm --filter @lubin/api run test          # tests Vitest backend (run unique)
pnpm --filter @lubin/api run test:watch    # mode watch
```

20 tests couvrent :
- `derivedMetrics` : calculs purs (10 critères chiffrés + valuation DCF)
- `filterNews` : whitelist Bettin / blacklist clickbait
- `retry` : retry exponentiel sur 429/5xx, abandon sur 4xx
- Routes `/health`, `/api/analyze` (validation 400, 404)

## Résilience (Phase 2)

### Rate limiting

| Scope | Limite | Réponse si dépassé |
|---|---|---|
| `/api/*` (global) | 100 req/min/IP | 429 |
| `/api/analyze*` | 10 req/min/IP | 429 |
| `/api/watchlist` POST/DELETE | 30 req/min/IP | 429 |
| Finnhub (outbound) | 50 req/min, concurrence 5 | queue interne |
| OpenAI (outbound) | 60 req/min, concurrence 3 | queue interne |
| FMP (outbound) | 30 req/min, concurrence 3 | queue interne |

### Retry exponentiel

Sur appels Finnhub/FMP/OpenAI :
- 3 tentatives par défaut (`fetchWithRetry`)
- Backoff : 400ms → 800ms → 1600ms + jitter ±25 %
- Retry sur 429, 5xx, erreurs réseau (fetch failed, ECONNRESET…)
- **Pas** de retry sur 4xx hors 429

### Monitoring Sentry

Optionnel — défini par les vars d'env :
- `SENTRY_DSN` (backend)
- `VITE_SENTRY_DSN` (frontend)

Si vide, désactivé (logs `[sentry] désactivé` au boot).

### Frontend UX d'erreur

- `<ErrorBoundary>` capture les erreurs React, propose recharger/réessayer
- `<ToastProvider>` + `useToast()` pour notifs non-bloquantes
- `api.ts` typé : `ApiError` avec `status` + `retriable` + bouton "Réessayer" auto-affiché
- Messages adaptés : 429 → "patiente une minute", 0 → "API offline", 5xx → "réessaie"

## Déploiement (Vercel + Neon)

Le code est **prêt pour la prod** sans modification : il suffit de remplacer
le Postgres local par un Neon cloud le jour où tu veux déployer.

### Étapes pour passer à Neon (10 min)

1. **Crée un compte Neon** : https://neon.tech (free tier 0.5 GB)
2. **Crée un projet** : `lubin-investment`, région `eu-central-1`
3. **Récupère la connection string** : Project → Connection details → copy
4. **Mets à jour `.env`** :
   ```bash
   DATABASE_URL="postgresql://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require"
   ```
5. **Applique les migrations** :
   ```bash
   pnpm db:migrate
   ```
6. C'est tout. L'app pointe maintenant sur Neon. Tu peux déployer
   le frontend sur Vercel et l'API sur Vercel Functions ou Railway.

Le code Prisma + Express + React est exactement le même, c'est juste
l'URL de la DB qui change.

## Roadmap

- ✅ **Phase 1** : Monorepo, API server-side, Postgres, watchlist, analyse complète
- ✅ **Phase 2** : Rate limiting, retry, Sentry, tests, error UX
- ✅ **Phase 2.5** : Auto-start DB, cache earnings-aware, timeseries histogrammes
- ⏸ **Phase 3** : Auth multi-user (Clerk ou Auth.js)
- ⏸ **Phase 4** : Cron auto-refresh watchlist + alertes email + déploiement Vercel/Neon

## Sources de données

- **Finnhub** (free 60 req/min) : metric (TTM + 5Y), profile2, quote, company-news
- **Financial Modeling Prep** (free profile only) : nom officiel de la boîte (optionnel)
- **OpenAI** : qualitatif (14 critères) + verdict_direct

## Sécurité

- ✅ Clés API **jamais exposées au browser** (envoi server-side uniquement)
- ✅ Validation des inputs via Zod
- ✅ CORS configuré pour http://localhost:5173 en dev
- ⏸ Rate limiting (Phase 2)
- ⏸ Auth (Phase 3)
