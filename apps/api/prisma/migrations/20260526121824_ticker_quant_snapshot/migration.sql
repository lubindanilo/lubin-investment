-- Migration ticker_quant_snapshot : cache GLOBAL par ticker du résultat de l'analyse
-- quant. Source unique de vérité partagée entre /api/analyze et /api/watchlist :
-- l'analyse écrit ici, la watchlist lit ici. Plus de divergence possible.

CREATE TABLE "TickerQuantSnapshot" (
    "ticker" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TickerQuantSnapshot_pkey" PRIMARY KEY ("ticker")
);

CREATE INDEX "TickerQuantSnapshot_refreshedAt_idx" ON "TickerQuantSnapshot"("refreshedAt");
