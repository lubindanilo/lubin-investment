/**
 * Vercel serverless entry point — catch-all route.
 *
 * Le pattern `[...all].ts` capture TOUTES les URLs (sauf celles servies en static
 * depuis apps/web/dist). Sur Vercel, ce fichier est compilé en une seule lambda
 * Node.js qui re-exporte l'Express app — Express se charge du routing interne
 * (/health, /api/analyze, /api/watchlist, /api/timeseries…).
 *
 * Pas de cold start workaround custom : Vercel garde la lambda chaude entre
 * requêtes consécutives, et le rate-limiter Bottleneck + le cache mémoire
 * survivent à la durée de vie de l'instance.
 *
 * Note : `app.listen()` n'est PAS appelé ici — server.ts détecte VERCEL=1
 * et skip le bind. La lambda invoque directement le handler Express via
 * l'interface (req, res) standard que Vercel passe au default export.
 */
import app from '../apps/api/src/server.js';

export default app;
