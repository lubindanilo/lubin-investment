#!/usr/bin/env bash
#
# Check rapide (max 5s) que Docker + Postgres sont là.
# NE BLOQUE PAS le lancement de l'app si quelque chose cloche :
#   - avertit clairement avec une commande de récup
#   - exit 0 quand même pour laisser pnpm dev continuer
#
# Philosophie : "fail gracefully" — mieux vaut une app qui démarre avec un warning
# qu'un script qui hang 90s sur un Docker wedged.

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[db]${NC} $1"; }
warn() { echo -e "${YELLOW}[db]${NC} $1"; }
err()  { echo -e "${RED}[db]${NC} $1" >&2; }

# ── 1. Docker daemon (check rapide avec timeout 5s) ──────────────────
if ! timeout 5 docker info > /dev/null 2>&1; then
  warn "Docker daemon non joignable (timeout 5s)."
  warn ""
  warn "Pour résoudre :"
  warn "  1. Lance Docker Desktop manuellement (double-clic sur l'app)"
  warn "  2. Attends que la baleine du menu bar arrête de bouger"
  warn "  3. Vérifie : docker info | head"
  warn "  4. Si Docker est wedged : menu Troubleshoot → Reset to factory defaults"
  warn ""
  warn "L'app va se lancer quand même mais elle plantera sur les routes DB."
  exit 0  # exit 0 → ne bloque pas pnpm dev
fi
log "Docker daemon OK"

# ── 2. Container Postgres (check rapide) ─────────────────────────────
CONTAINER_STATUS=$(timeout 5 docker inspect -f '{{.State.Status}}' lubin-postgres 2>/dev/null || echo "unknown")

case "$CONTAINER_STATUS" in
  running)
    log "Postgres déjà en cours"
    ;;
  exited|created|paused)
    log "Postgres arrêté ($CONTAINER_STATUS) — démarrage…"
    timeout 10 docker start lubin-postgres > /dev/null 2>&1 || {
      warn "Impossible de démarrer lubin-postgres. Lance manuellement : docker start lubin-postgres"
      exit 0
    }
    ;;
  *)
    warn "Container 'lubin-postgres' absent. Création via docker compose…"
    timeout 30 docker compose up -d postgres > /dev/null 2>&1 || {
      warn "Échec docker compose up. Lance manuellement."
      exit 0
    }
    ;;
esac

# ── 3. Postgres prêt ? (check rapide) ────────────────────────────────
for i in 1 2 3 4 5; do
  if timeout 2 docker exec lubin-postgres pg_isready -U lubin -d lubin_investment > /dev/null 2>&1; then
    log "Postgres prêt"
    exit 0
  fi
  sleep 1
done

warn "Postgres ne répond pas après 5s (mais le container tourne). L'app va essayer quand même."
exit 0
