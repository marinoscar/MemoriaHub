#!/usr/bin/env bash
# =============================================================================
# update.sh — Update MemoriaHub on VPS
# =============================================================================
# Location on VPS: /opt/infra/apps/memoriahub/update.sh
#
# This script:
#   1. Pulls the latest code from origin/<branch>
#   2. Rebuilds Docker images (API + Web)
#   3. Runs Prisma database migrations (deploy — never resets)
#   4. Restarts all services
#   5. Optionally updates VPS proxy nginx config
#   6. Verifies service health
#
# Usage:
#   cd /opt/infra/apps/memoriahub
#   ./update.sh [options]
#
# Options:
#   --no-cache     Force full Docker image rebuild (ignores layer cache)
#   --skip-proxy   Skip VPS proxy config update step
#   --no-color     Disable ANSI output
#   --help, -h     Show help
#
# Overridable via environment variables:
#   MEMORIAHUB_DOMAIN   Domain name          (default: memoriahub.marin.cr)
#   MEMORIAHUB_PORT     Internal host port   (default: 8328)
#   MEMORIAHUB_REPO     Git clone URL        (default: GitHub HTTPS)
#   MEMORIAHUB_REF      Branch/tag           (default: main)
#   MEMORIAHUB_HOME     Install root on VPS  (default: /opt/infra/apps/memoriahub)
#
# Prerequisites:
#   - MemoriaHub installed via infra/deploy/install.sh
#   - .env file configured
#   - Services running (or stopped; up -d is idempotent)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# ANSI color helpers (honor NO_COLOR)
# ---------------------------------------------------------------------------
_use_color() {
  [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]
}

_c() {
  if _use_color; then
    printf '\033[%sm%s\033[0m' "$1" "$2"
  else
    printf '%s' "$2"
  fi
}

GREEN=32; CYAN=36; YELLOW=33; RED=31; BOLD=1; DIM=2

ok()   { printf '%s %s\n'  "$(_c $GREEN  "✔")" "$1"; }
err()  { printf '%s %s\n'  "$(_c $RED    "✖")" "$1" >&2; }
warn() { printf '%s %s\n'  "$(_c $YELLOW "⚠")" "$1"; }
info() { printf '%s %s\n'  "$(_c $CYAN   "ℹ")" "$1"; }
step() { printf '\n%s %s\n' "$(_c $BOLD  "→")" "$(_c $BOLD "$1")"; }
dim()  { printf '  %s\n'   "$(_c $DIM   "$1")"; }

# ---------------------------------------------------------------------------
# Configuration (mirrors install.sh defaults)
# ---------------------------------------------------------------------------
DOMAIN="${MEMORIAHUB_DOMAIN:-memoriahub.marin.cr}"
BRANCH="${MEMORIAHUB_REF:-main}"
HOME_DIR="${MEMORIAHUB_HOME:-/opt/infra/apps/memoriahub}"

REPO_DIR="${HOME_DIR}/repo"
COMPOSE_FILE="${HOME_DIR}/compose.yml"
NGINX_CONF_SRC="${HOME_DIR}/memoriahub.conf"
NGINX_CONF_DST="/opt/infra/proxy/nginx/conf.d/memoriahub.conf"

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
NO_CACHE=false
SKIP_PROXY=false

# ---------------------------------------------------------------------------
# Argument parsing (must happen before logging setup to catch --no-color)
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "${arg}" in
    --no-cache)   NO_CACHE=true ;;
    --skip-proxy) SKIP_PROXY=true ;;
    --no-color)   export NO_COLOR=1 ;;
    --help|-h)
      cat <<EOF

$(_c $BOLD "MemoriaHub Updater")

USAGE
  bash update.sh [options]

OPTIONS
  --no-cache     Force full Docker image rebuild (no layer cache)
  --skip-proxy   Skip updating VPS reverse proxy config
  --no-color     Disable ANSI colors
  --help, -h     Show this help message

ENVIRONMENT VARIABLES
  MEMORIAHUB_DOMAIN   Target domain         (default: memoriahub.marin.cr)
  MEMORIAHUB_PORT     Internal host port    (default: 8328)
  MEMORIAHUB_REF      Branch/tag            (default: main)
  MEMORIAHUB_HOME     Install root on VPS   (default: /opt/infra/apps/memoriahub)

NOTES
  Run install.sh first if this is a fresh VPS.
  This script is idempotent — safe to run repeatedly.

EOF
      exit 0
      ;;
    *) warn "Unknown option: ${arg}"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Logging — tee to timestamped log file; keep last 10
# ---------------------------------------------------------------------------
LOG_DIR="${HOME_DIR}/logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/update-$(date '+%Y%m%d-%H%M%S').log"
exec > >(tee -a "${LOG_FILE}") 2>&1

# Prune old log files (keep newest 10)
# shellcheck disable=SC2012
ls -1t "${LOG_DIR}"/update-*.log 2>/dev/null | tail -n +11 | xargs -r rm -f

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
if [ ! -d "${REPO_DIR}/.git" ]; then
  err "Repository not found at ${REPO_DIR}"
  info "Run install.sh first."
  exit 1
fi

if [ ! -f "${HOME_DIR}/.env" ]; then
  err ".env file not found at ${HOME_DIR}/.env"
  exit 1
fi

if [ ! -f "${COMPOSE_FILE}" ]; then
  err "compose.yml not found at ${COMPOSE_FILE}"
  info "Run install.sh to generate it."
  exit 1
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
printf '\n'
if _use_color; then
  printf '\033[36m  MemoriaHub Updater\033[0m\n'
else
  printf '  MemoriaHub Updater\n'
fi
printf '\n'
info "Log file: ${LOG_FILE}"
info "Domain  : ${DOMAIN}"
info "Home    : ${HOME_DIR}"
printf '\n'

# ---------------------------------------------------------------------------
# Step 1: Pull latest code
# ---------------------------------------------------------------------------
step "[1/6] Pulling latest code"

CURRENT_COMMIT="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
git -C "${REPO_DIR}" fetch origin

REMOTE_COMMIT="$(git -C "${REPO_DIR}" rev-parse --short "origin/${BRANCH}")"

if [ "${CURRENT_COMMIT}" = "${REMOTE_COMMIT}" ] && [ "${NO_CACHE}" = "false" ]; then
  ok "Already at latest commit (${CURRENT_COMMIT})"
  info "Use --no-cache to force a full rebuild anyway."
  printf '\n'
  info "No update needed. Exiting."
  exit 0
fi

if [ "${CURRENT_COMMIT}" != "${REMOTE_COMMIT}" ]; then
  info "Current: ${CURRENT_COMMIT}"
  info "Latest : ${REMOTE_COMMIT}"
fi

git -C "${REPO_DIR}" reset --hard "origin/${BRANCH}"
NEW_COMMIT="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
ok "Updated to ${NEW_COMMIT}"

# Show what changed (if any new commits)
if [ "${CURRENT_COMMIT}" != "${NEW_COMMIT}" ]; then
  CHANGES="$(git -C "${REPO_DIR}" log --oneline "${CURRENT_COMMIT}..${NEW_COMMIT}" 2>/dev/null || echo '(first update)')"
  printf '\n'
  info "Changes:"
  echo "${CHANGES}" | while IFS= read -r line; do dim "${line}"; done
fi

# ---------------------------------------------------------------------------
# Step 2: Rebuild Docker images
# ---------------------------------------------------------------------------
step "[2/6] Rebuilding Docker images"

BUILD_ARGS=""
if [ "${NO_CACHE}" = "true" ]; then
  BUILD_ARGS="--no-cache"
  info "(--no-cache: full rebuild, layer cache bypassed)"
fi

# shellcheck disable=SC2086
docker compose -f "${COMPOSE_FILE}" build ${BUILD_ARGS}
ok "Images rebuilt"

# ---------------------------------------------------------------------------
# Step 3: Run database migrations
# ---------------------------------------------------------------------------
step "[3/6] Running database migrations"

# Stop the API first to avoid migration conflicts with the running app
docker compose -f "${COMPOSE_FILE}" stop api 2>/dev/null || true
info "API stopped for migration"

# prisma-env.js builds DATABASE_URL from POSTGRES_* vars in .env —
# no need to reconstruct the connection string here in bash.
info "Running Prisma migrate deploy..."
docker compose -f "${COMPOSE_FILE}" run --rm -T api npm run prisma:migrate \
  | while IFS= read -r line; do dim "${line}"; done
ok "Migrations complete"

# ---------------------------------------------------------------------------
# Step 4: Restart services
# ---------------------------------------------------------------------------
step "[4/6] Restarting services"

docker compose -f "${COMPOSE_FILE}" up -d
ok "All containers started"

# Restart nginx to re-resolve upstream container IPs after rebuild
docker compose -f "${COMPOSE_FILE}" restart nginx 2>/dev/null || true
ok "Nginx restarted"

info "Waiting for API to become healthy (up to 120 s)..."
API_READY=false
for _i in $(seq 1 60); do
  if docker exec memoriahub-api wget -qO- http://localhost:3000/api/health/live >/dev/null 2>&1; then
    API_READY=true
    break
  fi
  sleep 2
done

if [ "${API_READY}" = "true" ]; then
  ok "API is healthy"
else
  warn "API health check did not pass within 120 s"
  warn "Check logs: docker compose -f ${COMPOSE_FILE} logs api"
fi

# ---------------------------------------------------------------------------
# Step 5: Update VPS proxy config (optional)
# ---------------------------------------------------------------------------
step "[5/6] Updating VPS proxy config"

if [ "${SKIP_PROXY}" = "true" ]; then
  info "Skipped (--skip-proxy)"
else
  if [ -f "${NGINX_CONF_SRC}" ] && [ -d "$(dirname "${NGINX_CONF_DST}")" ]; then
    if diff -q "${NGINX_CONF_SRC}" "${NGINX_CONF_DST}" >/dev/null 2>&1; then
      ok "Proxy config unchanged — no reload needed"
    else
      cp "${NGINX_CONF_SRC}" "${NGINX_CONF_DST}"
      ok "Config copied to ${NGINX_CONF_DST}"

      if docker exec proxy-nginx nginx -t 2>/dev/null; then
        docker exec proxy-nginx nginx -s reload
        ok "VPS proxy reloaded"
      else
        warn "Nginx config test failed — not reloading"
        warn "Check: docker exec proxy-nginx nginx -t"
      fi
    fi
  else
    info "Proxy config destination not found — skipping proxy reload"
    dim "(Normal on first run before install.sh checklist is complete)"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Verify health
# ---------------------------------------------------------------------------
step "[6/6] Verifying services"
sleep 3

RUNNING="$(docker compose -f "${COMPOSE_FILE}" ps --format '{{.Name}}' 2>/dev/null | wc -l)"
info "Containers running: ${RUNNING}"

API_STATUS="$(docker exec memoriahub-api wget -qO- http://localhost:3000/api/health/live 2>/dev/null || echo 'FAIL')"
if echo "${API_STATUS}" | grep -qi "ok\|status\|healthy"; then
  ok "API health: OK"
else
  warn "API health: WARN (response: ${API_STATUS})"
  warn "Check: docker compose -f ${COMPOSE_FILE} logs api"
fi

# Save update state
cat > "${HOME_DIR}/.update-state" << EOF
last_update=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
previous_commit=${CURRENT_COMMIT}
current_commit=${NEW_COMMIT:-${CURRENT_COMMIT}}
branch=${BRANCH}
EOF

printf '\n'
info "${CURRENT_COMMIT} -> ${NEW_COMMIT:-${CURRENT_COMMIT}}"
ok "Update complete — https://${DOMAIN}"
info "Verify: curl https://${DOMAIN}/api/health/live"
info "Log saved to: ${LOG_FILE}"
