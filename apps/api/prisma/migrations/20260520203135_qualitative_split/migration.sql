-- Migration qualitative_split : sépare QualitativeCache en BusinessAnalysis (lifetime)
-- + ManagementAnalysis (refreshable). Préserve les données existantes via INSERT FROM.

-- 1) Crée BusinessAnalysis
CREATE TABLE "BusinessAnalysis" (
    "ticker" TEXT NOT NULL,
    "business" JSONB NOT NULL,
    "verdictDirect" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessAnalysis_pkey" PRIMARY KEY ("ticker")
);

-- 2) Crée ManagementAnalysis
CREATE TABLE "ManagementAnalysis" (
    "ticker" TEXT NOT NULL,
    "management" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagementAnalysis_pkey" PRIMARY KEY ("ticker")
);

-- 3) Migre les données existantes depuis QualitativeCache
-- data->business doit être un array ; on skip les rows malformées (data NULL ou sans 'business')
INSERT INTO "BusinessAnalysis" ("ticker", "business", "verdictDirect", "createdAt")
SELECT
    "ticker",
    "data"->'business',
    COALESCE("data"->>'verdict_direct', ''),
    "updatedAt"
FROM "QualitativeCache"
WHERE "data" IS NOT NULL
  AND jsonb_typeof("data"->'business') = 'array';

INSERT INTO "ManagementAnalysis" ("ticker", "management", "updatedAt")
SELECT
    "ticker",
    "data"->'management',
    "updatedAt"
FROM "QualitativeCache"
WHERE "data" IS NOT NULL
  AND jsonb_typeof("data"->'management') = 'array';

-- 4) Drop l'ancienne table
DROP TABLE "QualitativeCache";
