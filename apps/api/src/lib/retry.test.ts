/**
 * Tests du retry exponentiel.
 */
import { describe, it, expect, vi } from 'vitest';
import { withRetry, HttpError } from './retry.js';

describe('withRetry', () => {
  it('renvoie la valeur si la première tentative réussit', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retry sur HttpError 429 puis renvoie le succès', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError(429, 'rate limited'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1, attempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retry sur 5xx puis succès', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new HttpError(503, 'unavailable'))
      .mockRejectedValueOnce(new HttpError(502, 'bad gateway'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1, attempts: 4 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('ne retry PAS sur 400/401/404 (erreurs client)', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(404, 'not found'));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('jette la dernière erreur après épuisement des tentatives', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(500, 'down'));
    await expect(withRetry(fn, { baseDelayMs: 1, attempts: 2 })).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retry sur erreurs réseau (TypeError fetch failed)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
  });
});
