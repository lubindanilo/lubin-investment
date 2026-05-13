/**
 * Vitest setup : variables d'env minimales pour que les modules qui lisent process.env
 * au load-time ne plantent pas (Finnhub/OpenAI services).
 */
process.env.NODE_ENV ??= 'test';
process.env.FINNHUB_API_KEY ??= 'TEST_FH';
process.env.OPENAI_API_KEY ??= 'TEST_OAI';
process.env.OPENAI_MODEL ??= 'gpt-4o-2024-11-20';
process.env.FMP_API_KEY ??= 'TEST_FMP';
process.env.DATABASE_URL ??= 'postgresql://test@localhost:5432/test';
