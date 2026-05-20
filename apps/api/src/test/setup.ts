/**
 * Vitest setup : variables d'env minimales pour que les modules qui lisent process.env
 * au load-time ne plantent pas (Finnhub/OpenAI services).
 */
process.env.NODE_ENV ??= 'test';
process.env.FINNHUB_API_KEY ??= 'TEST_FH';
process.env.OPENAI_API_KEY ??= 'TEST_OAI';
process.env.OPENAI_MODEL ??= 'gpt-4o-2024-11-20';
process.env.DATABASE_URL ??= 'postgresql://test@localhost:5432/test';
// Secret factice ≥ 32 chars pour les tests JWT — assertSecret() ne planterait pas sinon
process.env.AUTH_SECRET ??= 'test-secret-must-be-at-least-32-chars-long-' + 'x'.repeat(32);
