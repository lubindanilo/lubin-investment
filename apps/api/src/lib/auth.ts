/**
 * Authentification — JWT (HS256) + bcrypt.
 *
 * Choix techniques :
 *   - bcryptjs (pas bcrypt) → pure JS, pas de native bindings → simplifie le bundle Vercel
 *   - JWT HS256 stocké dans un cookie HttpOnly + SameSite=Lax + Secure en prod
 *   - Pas de refresh token : le cookie a une TTL de 30j et expire d'un coup
 *   - AUTH_SECRET DOIT être ≥ 32 chars, sinon on refuse de booter (cf. assertSecret)
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const BCRYPT_COST = 12;
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 jours

export const COOKIE_NAME = 'auth';
export const COOKIE_MAX_AGE_MS = TOKEN_TTL_SEC * 1000;

interface TokenPayload {
  userId: string;
  email: string;
}

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET manquant ou trop court (< 32 chars). ' +
      'Génère-en un via : node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  return secret;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL_SEC, algorithm: 'HS256' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { userId, email } = decoded as { userId?: unknown; email?: unknown };
    if (typeof userId !== 'string' || typeof email !== 'string') return null;
    return { userId, email };
  } catch {
    // Token expiré, mal signé, etc. — on traite comme non-auth
    return null;
  }
}

/**
 * Options pour res.cookie() — communes login/signup/logout.
 *   - httpOnly : protège contre XSS (le JS ne peut pas lire le cookie)
 *   - secure : HTTPS only en prod (Vercel) ; HTTP toléré en dev local
 *   - sameSite='lax' : protège contre CSRF cross-site, autorise navigation top-level
 *   - path='/' : le cookie est valide sur tout le domaine (web + api en same-origin sur Vercel)
 */
export function cookieOptions(opts: { clear?: boolean } = {}) {
  const isProd = !!process.env.VERCEL || process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: opts.clear ? 0 : COOKIE_MAX_AGE_MS,
  };
}
