/**
 * Sentry React — init conditionnelle.
 * Activé uniquement si VITE_SENTRY_DSN est défini en build.
 */
import * as Sentry from '@sentry/react';

let initialized = false;

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
  });
  initialized = true;
  console.log('[sentry] React initialisé');
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (initialized) Sentry.captureException(err, { extra: context });
}

export { Sentry };
