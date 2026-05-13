/**
 * Smoke test du serveur Express : health + 404.
 * Pas d'appels externes — les services ne sont pas touchés.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';

describe('GET /health', () => {
  it('renvoie 200 + JSON avec les flags d\'env', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('lubin-investment-api');
    expect(res.body.env).toMatchObject({
      openai: true,
      finnhub: true,
      fmp: true,
      db: true,
    });
  });
});

describe('404 fallback', () => {
  it('renvoie 404 + JSON propre sur route inconnue', async () => {
    const res = await request(app).get('/route-qui-n-existe-pas');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});

describe('validation /api/analyze', () => {
  it('renvoie 400 sur ticker invalide', async () => {
    const res = await request(app).get('/api/analyze?ticker=invalid!ticker');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ticker/i);
  });
});

describe('validation /api/analyze/revalue', () => {
  it('renvoie 400 sur payload manquant', async () => {
    const res = await request(app).post('/api/analyze/revalue').send({});
    expect(res.status).toBe(400);
  });
});
