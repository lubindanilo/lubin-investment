/**
 * Middleware d'authentification — lit le cookie JWT et attache req.user.
 *
 * Deux variantes :
 *   - requireAuth  : 401 si pas de cookie / cookie invalide
 *   - optionalAuth : laisse passer, req.user vaut undefined si pas auth
 *
 * Module augmentation pour étendre Express.Request avec `user`.
 */
import type { Request, Response, NextFunction } from 'express';
import { COOKIE_NAME, verifyToken } from '../lib/auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { userId: string; email: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expirée ou invalide' });
    return;
  }
  req.user = payload;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAME];
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.user = payload;
  }
  next();
}
