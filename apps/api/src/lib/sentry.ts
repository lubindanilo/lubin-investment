/**
 * Sentry init — conditionnelle.
 * Si SENTRY_DSN n'est pas défini, c'est un no-op (utile en dev).
 *
 * Pour activer en prod :
 *   1. Crée un compte gratuit sur https://sentry.io (Developer tier = 5k events/mois)
 *   2. Crée un projet "Node.js" → tu obtiens un DSN du type :
 *      https://abc123@o000000.ingest.sentry.io/000000
 *   3. Ajoute-le sur Vercel : vercel env add SENTRY_DSN production
 *   4. Redéploie : vercel --prod
 */
import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (process.env.VERCEL) {
      // En prod sur Vercel, c'est dommage de pas avoir Sentry — log un warn explicite
      console.warn('[sentry] désactivé en PROD — ajoute SENTRY_DSN sur Vercel pour activer le monitoring');
    } else {
      console.log('[sentry] désactivé (SENTRY_DSN absent)');
    }
    return;
  }
  // Détermine l'environnement Sentry à partir du contexte Vercel
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  Sentry.init({
    dsn,
    environment: env,
    tracesSampleRate: env === 'production' ? 0.05 : 0.5, // 5% en prod, 50% en preview/dev
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    // Filtre les erreurs attendues du metier (400, 401, 404) — on ne veut pas spammer Sentry
    beforeSend(event) {
      const status = event.extra?.['status'] as number | undefined;
      if (typeof status === 'number' && (status === 400 || status === 401 || status === 404)) {
        return null;
      }
      return event;
    },
  });
  initialized = true;
  console.log(`[sentry] initialisé (env=${env}, release=${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'n/a'})`);
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(err, { extra: context });
}

export { Sentry };
