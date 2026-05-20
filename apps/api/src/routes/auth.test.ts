/**
 * Tests d'auth — utilise supertest + Prisma mocké.
 *
 * Stratégie :
 *   - On mocke @prisma/client pour ne pas dépendre d'une DB réelle pendant les tests.
 *   - Un store en mémoire simule findUnique/create sur User.
 *   - Tests : signup ok, signup email duplicate, login ok, login wrong password,
 *             login email inexistant (générique), /me sans cookie, /me avec cookie, logout clears cookie.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// ─── Mock Prisma (DOIT être défini AVANT l'import de server.js) ────────────
interface FakeUser { id: string; email: string; passwordHash: string; createdAt: Date }
const userStore = new Map<string, FakeUser>();      // key = email
const userById = new Map<string, FakeUser>();       // key = id
let nextId = 1;

vi.mock('@prisma/client', () => {
  return {
    PrismaClient: class FakePrisma {
      user = {
        findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
          if (where.email) return userStore.get(where.email) ?? null;
          if (where.id) return userById.get(where.id) ?? null;
          return null;
        }),
        create: vi.fn(async ({ data }: { data: { email: string; passwordHash: string } }) => {
          const u: FakeUser = {
            id: `user_${nextId++}`,
            email: data.email,
            passwordHash: data.passwordHash,
            createdAt: new Date(),
          };
          userStore.set(u.email, u);
          userById.set(u.id, u);
          return u;
        }),
      };
      watchlistEntry = {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
        update: vi.fn(),
      };
    },
  };
});

// L'import doit venir APRÈS le vi.mock pour que le mock soit pris en compte
const { app } = await import('../server.js');

beforeEach(() => {
  userStore.clear();
  userById.clear();
  nextId = 1;
});

describe('POST /api/auth/signup', () => {
  it('crée un user + set cookie sur signup valide', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('alice@example.com');
    expect(res.body.passwordHash).toBeUndefined(); // jamais exposé
    expect(res.headers['set-cookie']?.[0]).toMatch(/^auth=/);
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');
  });

  it('refuse email déjà utilisé (409)', async () => {
    await request(app).post('/api/auth/signup').send({ email: 'bob@example.com', password: 'password123' });
    const res = await request(app).post('/api/auth/signup').send({ email: 'bob@example.com', password: 'password123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/déjà utilisé/i);
  });

  it('refuse password < 8 chars (400)', async () => {
    const res = await request(app).post('/api/auth/signup').send({ email: 'carol@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('refuse email invalide (400)', async () => {
    const res = await request(app).post('/api/auth/signup').send({ email: 'pas-un-email', password: 'password123' });
    expect(res.status).toBe(400);
  });

  it('normalise l\'email en lowercase + trim', async () => {
    const res = await request(app).post('/api/auth/signup').send({ email: '  DAVID@Example.COM  ', password: 'password123' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('david@example.com');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/signup').send({ email: 'eve@example.com', password: 'password123' });
  });

  it('login valide → 200 + cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'eve@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('eve@example.com');
    expect(res.headers['set-cookie']?.[0]).toMatch(/^auth=/);
  });

  it('mauvais password → 401 message générique', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'eve@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/email ou mot de passe invalide/i);
  });

  it('email inexistant → 401 même message générique (anti énumération)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/email ou mot de passe invalide/i);
  });
});

describe('GET /api/auth/me', () => {
  it('renvoie 401 sans cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('renvoie le user avec cookie valide', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send({ email: 'frank@example.com', password: 'password123' });
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('frank@example.com');
  });
});

describe('POST /api/auth/logout', () => {
  it('clear le cookie auth', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send({ email: 'grace@example.com', password: 'password123' });
    const res = await agent.post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Le cookie est explicitement vidé (Max-Age=0 ou Expires dans le passé)
    expect(res.headers['set-cookie']?.[0]).toMatch(/auth=;/);
  });
});

describe('Watchlist scope', () => {
  it('GET /api/watchlist refuse sans cookie (401)', async () => {
    const res = await request(app).get('/api/watchlist');
    expect(res.status).toBe(401);
  });
});
