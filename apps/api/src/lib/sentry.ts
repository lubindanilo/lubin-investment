/**
 * Sentry init — conditionnelle.
 * Si SENTRY_DSN n'est pas défini, c'est un no-op (utile en dev).
 *
 * En prod : exporte SENTRY_DSN dans .env pour activer.
 */
import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[sentry] désactivé (SENTRY_DSN absent)');
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
    release: process.env.SENTRY_RELEASE,
  });
  initialized = true;
  console.log('[sentry] initialisé');
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(err, { extra: context });
}

export { Sentry };
