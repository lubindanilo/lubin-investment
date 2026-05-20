/**
 * Wrapper fetch typé + retry + erreurs structurées.
 * Toutes les routes passent par /api/*.
 */
import type {
  AnalyzeResponse,
  WatchlistEntry,
  ValoParams,
  ValuationResult,
  DerivedMetrics,
  TimeseriesResponse,
  PfcfHistoryResponse,
  PublicUser,
} from '@lubin/shared';
import { captureException } from './sentry.js';

/** Erreur typée que les composants peuvent inspecter. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public userMessage: string,
    public details?: string,
  ) {
    super(userMessage);
    this.name = 'ApiError';
  }

  /** true si retry potentiellement productif (network down, 5xx, 429) */
  get retriable(): boolean {
    return this.status === 0 || this.status === 429 || (this.status >= 500 && this.status < 600);
  }
}

interface RequestOpts {
  attempts?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, init: RequestInit = {}, opts: RequestOpts = {}): Promise<T> {
  const { attempts = 2, signal } = opts;
  const baseDelay = 400;
  let lastErr: ApiError | null = null;

  for (let n = 1; n <= attempts; n++) {
    try {
      const res = await fetch(path, {
        ...init,
        signal,
        // credentials:'include' → envoie le cookie auth avec chaque requête.
        // Sans ça, le cookie HttpOnly serait bloqué côté navigateur en cross-origin (dev local).
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        const err = new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.details);
        if (!err.retriable || n === attempts) throw err;
        lastErr = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (e) {
      if (e instanceof ApiError) {
        if (!e.retriable || n === attempts) throw e;
        lastErr = e;
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        throw e;
      } else {
        // Erreur réseau (offline, DNS, etc.) → status 0
        const networkErr = new ApiError(0, 'Pas de connexion au serveur', (e as Error).message);
        if (n === attempts) throw networkErr;
        lastErr = networkErr;
      }
    }
    // Exponential backoff + jitter
    const delay = baseDelay * 2 ** (n - 1) + Math.random() * 200;
    await new Promise<void>(r => setTimeout(r, delay));
  }
  if (lastErr) throw lastErr;
  throw new ApiError(0, 'Échec inattendu de la requête');
}

// Wrapper qui capture vers Sentry les erreurs imprévues.
// 400 (validation) et 401 (non-auth, simplement "pas connecté") sont des comportements normaux → pas de Sentry.
async function safeRequest<T>(path: string, init: RequestInit = {}, opts?: RequestOpts): Promise<T> {
  try {
    return await request<T>(path, init, opts);
  } catch (e) {
    if (e instanceof ApiError && e.status !== 400 && e.status !== 401) captureException(e, { path });
    throw e;
  }
}

export const api = {
  analyze(ticker: string) {
    return safeRequest<AnalyzeResponse>(`/api/analyze?ticker=${encodeURIComponent(ticker)}`);
  },
  revalue(ticker: string, params: ValoParams) {
    return safeRequest<{ valuation: ValuationResult; metrics: DerivedMetrics }>(
      `/api/analyze/revalue`,
      { method: 'POST', body: JSON.stringify({ ticker, params }) },
    );
  },
  refreshQual(ticker: string) {
    return safeRequest<{ qualUpdatedAt: string }>(`/api/analyze/refresh-qual`, {
      method: 'POST',
      body: JSON.stringify({ ticker }),
    });
  },
  timeseries(ticker: string, metric: string, years: number, freq: 'quarterly' | 'annual' = 'quarterly') {
    const q = new URLSearchParams({ ticker, metric, freq, years: String(years) });
    return safeRequest<TimeseriesResponse>(`/api/timeseries?${q}`);
  },
  pfcfHistory(ticker: string, years: number) {
    const q = new URLSearchParams({ ticker, years: String(years) });
    return safeRequest<PfcfHistoryResponse>(`/api/pfcf-history?${q}`);
  },
  watchlist: {
    list: () => safeRequest<WatchlistEntry[]>('/api/watchlist'),
    add: (ticker: string) =>
      safeRequest<WatchlistEntry>('/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ ticker }),
      }),
    refresh: (force = false) =>
      safeRequest<WatchlistEntry[]>(`/api/watchlist/refresh${force ? '?force=true' : ''}`, { method: 'POST' }),
    remove: (ticker: string) =>
      safeRequest<{ ok: true }>(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: 'DELETE' }),
  },
  auth: {
    /** GET /api/auth/me — renvoie le user ou null si pas connecté (au lieu de throw sur 401). */
    me: async (): Promise<PublicUser | null> => {
      try {
        return await safeRequest<PublicUser>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    signup: (email: string, password: string) =>
      safeRequest<PublicUser>('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    login: (email: string, password: string) =>
      safeRequest<PublicUser>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    logout: () => safeRequest<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  },
};
