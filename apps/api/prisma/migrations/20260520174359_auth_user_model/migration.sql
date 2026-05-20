-- Migration auth_user_model : ajoute User + scope WatchlistEntry par userId.
--
-- ⚠️ Cette migration TRUNCATE WatchlistEntry car on ajoute une colonne userId
-- NOT NULL sans default. À la date de la migration, /api/watchlist renvoyait
-- [] côté prod (vérifié manuellement) donc aucune donnée n'est perdue.
-- QualitativeCache reste intact (partagée entre tous les utilisateurs).

-- 1) On vide WatchlistEntry pour pouvoir poser le NOT NULL userId
TRUNCATE TABLE "WatchlistEntry" RESTART IDENTITY;

-- 2) Drop l'ancien unique(ticker) — on le remplacera par un composite (userId, ticker)
DROP INDEX "WatchlistEntry_ticker_idx";
DROP INDEX "WatchlistEntry_ticker_key";

-- 3) Ajoute la colonne userId (NOT NULL sans default = OK puisque table vide)
ALTER TABLE "WatchlistEntry" ADD COLUMN "userId" TEXT NOT NULL;

-- 4) Crée le modèle User
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- 5) Index unique sur email (lookups login + signup)
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- 6) Index sur userId pour les queries findMany scoped (charge la watchlist d'un user)
CREATE INDEX "WatchlistEntry_userId_idx" ON "WatchlistEntry"("userId");

-- 7) Unique composite (userId, ticker) — un user ne peut avoir le même ticker deux fois
CREATE UNIQUE INDEX "WatchlistEntry_userId_ticker_key" ON "WatchlistEntry"("userId", "ticker");

-- 8) Foreign key avec CASCADE — supprimer un user supprime sa watchlist
ALTER TABLE "WatchlistEntry"
  ADD CONSTRAINT "WatchlistEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
