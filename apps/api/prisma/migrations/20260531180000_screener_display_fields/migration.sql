-- Champs d'affichage du screener (vue dense : secteur, cours, variation, sparkline).
-- Idempotent (IF NOT EXISTS) : sûr même si les colonnes ont déjà été ajoutées hors migration.
ALTER TABLE "ScreenerTicker" ADD COLUMN IF NOT EXISTS "sector" TEXT;
ALTER TABLE "ScreenerTicker" ADD COLUMN IF NOT EXISTS "price" DOUBLE PRECISION;
ALTER TABLE "ScreenerTicker" ADD COLUMN IF NOT EXISTS "dayChangePct" DOUBLE PRECISION;
ALTER TABLE "ScreenerTicker" ADD COLUMN IF NOT EXISTS "spark" JSONB;
