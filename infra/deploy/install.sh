#!/usr/bin/env bash
# =============================================================================
# install.sh — MemoriaHub Production Installer / Updater
# =============================================================================
# Location on VPS: /opt/infra/apps/memoriahub/install.sh
#
# This script:
#   1. Checks required tools (docker, git, curl)
#   2. Creates the application directory structure
#   3. Clones (or updates) the MemoriaHub repository
#   4. Validates that .env exists and lists required prod keys
#   5. Generates production compose.yml and VPS nginx proxy config
#   6. Builds Docker images
#   7. Runs Prisma migrations and seeds via one-off container
#   8. Starts all services (api, web, nginx)
#   9. Verifies service health
#
# Usage:
#   cd /opt/infra/apps/memoriahub
#   chmod +x install.sh
#   ./install.sh [--no-color] [--help]
#
# For updates, run the script again. It pulls latest code, rebuilds images,
# and runs any new migrations idempotently.
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - Cloud-hosted PostgreSQL accessible from the VPS
#   - .env file at ${HOME_DIR}/.env with production values
#     (see step 5 output for the full required-key list)
#
# Overridable via environment variables:
#   MEMORIAHUB_DOMAIN   Domain name          (default: memoriahub.marin.cr)
#   MEMORIAHUB_PORT     Internal host port   (default: 8328)
#   MEMORIAHUB_REPO     Git clone URL        (default: GitHub HTTPS)
#   MEMORIAHUB_REF      Branch/tag           (default: main)
#   MEMORIAHUB_HOME     Install root on VPS  (default: /opt/infra/apps/memoriahub)
#   GITHUB_TOKEN        GitHub PAT for private-repo clones (optional)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# ANSI color helpers (honor NO_COLOR)
# ---------------------------------------------------------------------------
_use_color() {
  [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]
}

_c() {
  # _c <code> <text>
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
# Box printer (ANSI, no external deps)
# ---------------------------------------------------------------------------
print_box() {
  local title="${1:-}"
  shift
  local lines=("$@")
  local width=60
  local pad="  "

  local border_h
  border_h=$(printf '─%.0s' $(seq 1 $width))

  if _use_color; then
    printf '\033[36m╭%s╮\033[0m\n' "$border_h"
    if [[ -n "$title" ]]; then
      local tpad=$(( (width - ${#title} - 2) / 2 ))
      printf '\033[36m│\033[0m%*s\033[1m%s\033[0m%*s\033[36m│\033[0m\n' \
        "$tpad" "" "$title" "$tpad" ""
      printf '\033[36m├%s┤\033[0m\n' "$border_h"
    fi
    for line in "${lines[@]}"; do
      printf '\033[36m│\033[0m %s%-*s \033[36m│\033[0m\n' \
        "${pad}" "$((width - ${#pad} - 1))" "$line"
    done
    printf '\033[36m╰%s╯\033[0m\n' "$border_h"
  else
    printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
    if [[ -n "$title" ]]; then
      printf '| %-*s |\n' "$((width - 1))" "$title"
      printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
    fi
    for line in "${lines[@]}"; do
      printf '| %-*s |\n' "$((width - 1))" "${pad}${line}"
    done
    printf '+%s+\n' "$(printf -- '-%.0s' $(seq 1 $width))"
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --no-color) export NO_COLOR=1 ;;
    --help|-h)
      cat <<EOF

$(_c $BOLD "MemoriaHub Production Installer")

USAGE
  bash install.sh [options]

OPTIONS
  --no-color    Disable ANSI colors
  --help        Show this message

ENVIRONMENT VARIABLES
  MEMORIAHUB_DOMAIN   Target domain         (default: memoriahub.marin.cr)
  MEMORIAHUB_PORT     Internal host port    (default: 8328)
  MEMORIAHUB_REPO     Git clone URL         (default: GitHub HTTPS)
  MEMORIAHUB_REF      Branch/tag            (default: main)
  MEMORIAHUB_HOME     Install root on VPS   (default: /opt/infra/apps/memoriahub)
  GITHUB_TOKEN        GitHub PAT for private repos (optional)

NOTES
  Place .env at \${MEMORIAHUB_HOME}/.env before running.
  Re-running this script is safe — it pulls latest code and reruns migrations.

EOF
      exit 0
      ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# Configuration (all overridable via environment)
# ---------------------------------------------------------------------------
DOMAIN="${MEMORIAHUB_DOMAIN:-memoriahub.marin.cr}"
HOST_PORT="${MEMORIAHUB_PORT:-8328}"
REPO_URL="${MEMORIAHUB_REPO:-https://github.com/marinoscar/MemoriaHub.git}"
BRANCH="${MEMORIAHUB_REF:-main}"
HOME_DIR="${MEMORIAHUB_HOME:-/opt/infra/apps/memoriahub}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

REPO_DIR="${HOME_DIR}/repo"
COMPOSE_FILE="${HOME_DIR}/compose.yml"
NGINX_CONF="${HOME_DIR}/memoriahub.conf"

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
printf '\n'
if _use_color; then
  printf '\033[36m  MemoriaHub Production Installer\033[0m\n'
else
  printf '  MemoriaHub Production Installer\n'
fi
printf '\n'
info "Domain   : ${DOMAIN}"
info "Port     : ${HOST_PORT}"
info "Home dir : ${HOME_DIR}"
printf '\n'

# ---------------------------------------------------------------------------
# Step 1: Check required tools
# ---------------------------------------------------------------------------
step "[1/9] Checking required tools"

check_tool() {
  local name="$1"
  if ! command -v "$name" &>/dev/null; then
    err "$name is required but not found."
    case "$name" in
      docker) warn "Install Docker: https://docs.docker.com/engine/install/" ;;
      git)    warn "Install git via your package manager (e.g. apt install git)" ;;
      curl)   warn "Install curl via your package manager (e.g. apt install curl)" ;;
    esac
    exit 1
  fi
  local version
  version="$("$name" --version 2>&1 | head -1)"
  ok "$name  $(_c $DIM "$version")"
}

check_tool docker
check_tool git
check_tool curl

# Verify `docker compose` (v2 plugin) works
if ! docker compose version &>/dev/null; then
  err "docker compose (v2 plugin) is not available."
  warn "Install: https://docs.docker.com/compose/install/"
  exit 1
fi
COMPOSE_VER="$(docker compose version --short 2>/dev/null || docker compose version 2>&1 | head -1)"
ok "docker compose  $(_c $DIM "$COMPOSE_VER")"

# ---------------------------------------------------------------------------
# Step 2: Create directory structure
# ---------------------------------------------------------------------------
step "[2/9] Creating directory structure"

mkdir -p "${HOME_DIR}/repo"
mkdir -p "${HOME_DIR}/logs"
ok "Directories ready: ${HOME_DIR}/{repo,logs}"

# ---------------------------------------------------------------------------
# Step 3: Clone or update the repository
# ---------------------------------------------------------------------------
step "[3/9] Fetching source code"

if [ -d "${REPO_DIR}/.git" ]; then
  info "Repository exists — fetching latest from origin/${BRANCH}..."
  git -C "${REPO_DIR}" fetch origin
  git -C "${REPO_DIR}" reset --hard "origin/${BRANCH}"
  NEW_COMMIT="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
  ok "Updated to ${NEW_COMMIT}"
else
  info "Cloning ${REPO_URL} @ ${BRANCH}..."
  CLONE_URL="${REPO_URL}"
  if [[ -n "${GITHUB_TOKEN}" ]]; then
    CLONE_URL="${REPO_URL/https:\/\/github.com\//https:\/\/${GITHUB_TOKEN}@github.com\/}"
    info "Using GITHUB_TOKEN for authentication"
  fi
  git clone --branch "${BRANCH}" "${CLONE_URL}" "${REPO_DIR}" 2>&1 \
    | grep -v "^$" | while IFS= read -r line; do dim "$line"; done
  ok "Cloned repository"
fi

# ---------------------------------------------------------------------------
# Step 4: Validate .env
# ---------------------------------------------------------------------------
step "[4/9] Validating environment file"

if [ ! -f "${HOME_DIR}/.env" ]; then
  err ".env file not found at ${HOME_DIR}/.env"
  printf '\n'
  info "Create it from the template:"
  dim "  cp ${REPO_DIR}/infra/compose/.env.example ${HOME_DIR}/.env"
  dim "  nano ${HOME_DIR}/.env"
  printf '\n'
  info "Required production keys:"
  dim "  NODE_ENV=production"
  dim "  APP_URL=https://${DOMAIN}"
  dim "  GOOGLE_CALLBACK_URL=https://${DOMAIN}/api/auth/google/callback"
  printf '\n'
  dim "  # Cloud PostgreSQL"
  dim "  POSTGRES_HOST=<your-cloud-pg-host>"
  dim "  POSTGRES_PORT=5432"
  dim "  POSTGRES_USER=<user>"
  dim "  POSTGRES_PASSWORD=<password>"
  dim "  POSTGRES_DB=<dbname>"
  dim "  POSTGRES_SSL=true"
  printf '\n'
  dim "  # Secrets (generate with: openssl rand -base64 32)"
  dim "  JWT_SECRET=<min-32-chars>"
  dim "  COOKIE_SECRET=<min-32-chars>"
  printf '\n'
  dim "  # Google OAuth"
  dim "  GOOGLE_CLIENT_ID=<client-id>"
  dim "  GOOGLE_CLIENT_SECRET=<client-secret>"
  dim "  INITIAL_ADMIN_EMAIL=<your-email>"
  printf '\n'
  dim "  # Storage (S3-compatible)"
  dim "  STORAGE_PROVIDER=s3"
  dim "  S3_BUCKET=marin-memoriahub"
  dim "  S3_REGION=<region>"
  dim "  AWS_ACCESS_KEY_ID=<key-id>"
  dim "  AWS_SECRET_ACCESS_KEY=<secret-key>"
  dim "  MAX_FILE_SIZE=10737418240"
  dim "  ALLOWED_MIME_TYPES=image/*,video/*"
  printf '\n'
  dim "  # App configuration"
  dim "  GEO_PROVIDER=offline"
  dim "  DEVICE_PAT_TTL_DAYS=90"
  dim "  COMPOSE_PROJECT_NAME=memoriahub"
  printf '\n'
  info "Then run this script again."
  exit 1
fi

ok ".env file found"

# ---------------------------------------------------------------------------
# Step 5: Generate production compose.yml
# ---------------------------------------------------------------------------
step "[5/9] Generating production compose.yml"

# NOTE: quoted heredoc delimiter ('COMPOSE_EOF') so no shell expansion occurs.
# All values are literal Docker Compose YAML — container names and image refs
# must not be expanded by the shell.
cat > "${COMPOSE_FILE}" << 'COMPOSE_EOF'
# =============================================================================
# MemoriaHub — Production Docker Compose
# =============================================================================
# Generated by infra/deploy/install.sh
# Do not edit manually — re-run the installer to regenerate.
# =============================================================================

services:
  # ---------------------------------------------------------------------------
  # Nginx — Internal reverse proxy (routes /api -> api, / -> web)
  # Binds to 127.0.0.1 only; VPS host-level nginx proxies here over HTTPS.
  # ---------------------------------------------------------------------------
  nginx:
    container_name: memoriahub-nginx
    image: nginx:alpine
    ports:
      - "127.0.0.1:MEMORIAHUB_HOST_PORT:80"
    volumes:
      - ./repo/infra/nginx/nginx.prod.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - api
      - web
    restart: unless-stopped
    networks:
      - memoriahub-internal

  # ---------------------------------------------------------------------------
  # API — NestJS Backend (Fastify)
  # Connects to cloud PostgreSQL via POSTGRES_* env vars in .env.
  # No devnet needed — cloud DB is reachable directly.
  # ---------------------------------------------------------------------------
  api:
    container_name: memoriahub-api
    build:
      # Repo-root context: apps/api depends on the @memoriahub/enrichment-compute
      # npm workspace, so the build needs the root manifests + the workspace
      # member visible (matches infra/compose and deploy.yml). An apps/api-scoped
      # context breaks the install.
      context: ./repo
      dockerfile: apps/api/Dockerfile
      target: production
    env_file:
      - .env
    environment:
      # Node.js V8 old-space heap cap — a SEPARATE ceiling from the container
      # `memory` limit below. Size it under the container limit with ~1 GB of
      # off-heap headroom: max-old-space-size ≈ container_mem_MB − 1024. See #102.
      - NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=5120}
    restart: unless-stopped
    deploy:
      resources:
        limits:
          # `.env`-parameterized (Docker Compose auto-reads the sibling .env for
          # ${VAR} interpolation). Defaults sized to real production load. See #102.
          memory: ${API_MEMORY_LIMIT:-6G}
          cpus: "${API_CPU_LIMIT:-4.0}"
    networks:
      - memoriahub-internal

  # ---------------------------------------------------------------------------
  # Web — React Frontend (static files served by nginx on :80)
  # ---------------------------------------------------------------------------
  web:
    container_name: memoriahub-web
    build:
      context: ./repo/apps/web
      dockerfile: Dockerfile
      target: production
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: ${WEB_MEMORY_LIMIT:-128M}
    networks:
      - memoriahub-internal

# =============================================================================
# Networks
# =============================================================================
networks:
  # Isolated internal network — no external postgres needed (cloud DB)
  memoriahub-internal:
    driver: bridge
COMPOSE_EOF

# Substitute the host port placeholder (can't expand inside quoted heredoc)
sed -i "s/MEMORIAHUB_HOST_PORT/${HOST_PORT}/g" "${COMPOSE_FILE}"

ok "compose.yml generated at ${COMPOSE_FILE}"

# ---------------------------------------------------------------------------
# Step 6: Generate VPS reverse-proxy nginx config
# ---------------------------------------------------------------------------
step "[6/9] Generating VPS nginx proxy config"

# NOTE: unquoted heredoc delimiter (NGINX_EOF) so ${DOMAIN} and ${HOST_PORT}
# are expanded by the shell. Nginx's own dollar-sign variables ($host,
# $remote_addr, $proxy_add_x_forwarded_for, $scheme, $server_name,
# $request_uri) are backslash-escaped so they appear LITERALLY in the
# generated file and are interpreted by nginx at runtime.

cat > "${NGINX_CONF}" << NGINX_EOF
# =============================================================================
# ${DOMAIN} — VPS Reverse Proxy Config
# =============================================================================
# Generated by infra/deploy/install.sh
# Copy to: /opt/infra/proxy/nginx/conf.d/memoriahub.conf
# =============================================================================

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    # Large media uploads (matches internal nginx + MAX_FILE_SIZE app setting)
    client_max_body_size 10g;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # API routes
    location /api {
        proxy_pass http://127.0.0.1:${HOST_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }

    # Frontend (React SPA)
    location / {
        proxy_pass http://127.0.0.1:${HOST_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}

# HTTP -> HTTPS redirect + ACME challenge
server {
    listen 80;
    server_name ${DOMAIN};

    # Let's Encrypt ACME challenge
    location /.well-known/acme-challenge/ {
        root /opt/infra/proxy/webroot;
    }

    location / {
        return 301 https://\$server_name\$request_uri;
    }
}
NGINX_EOF

ok "memoriahub.conf generated at ${NGINX_CONF}"

# ---------------------------------------------------------------------------
# Step 7: Build Docker images
# ---------------------------------------------------------------------------
step "[7/9] Building Docker images"

docker compose -f "${COMPOSE_FILE}" build
ok "Images built"

# ---------------------------------------------------------------------------
# Step 8: Run Prisma migrations and seed
# ---------------------------------------------------------------------------
step "[8/9] Running database migrations and seed"

info "Running Prisma migrate deploy..."
# prisma-env.js (apps/api/scripts/) constructs DATABASE_URL from the
# POSTGRES_* vars in .env — no need to reconstruct it here in bash.
docker compose -f "${COMPOSE_FILE}" run --rm -T api npm run prisma:migrate \
  | while IFS= read -r line; do dim "$line"; done
ok "Migrations complete"

info "Running Prisma seed..."
docker compose -f "${COMPOSE_FILE}" run --rm -T api npm run prisma:seed \
  | while IFS= read -r line; do dim "$line"; done
ok "Seed complete"

# ---------------------------------------------------------------------------
# Step 9: Start services and verify health
# ---------------------------------------------------------------------------
step "[9/9] Starting services"

docker compose -f "${COMPOSE_FILE}" up -d
ok "Containers started"

info "Waiting for API to become healthy (up to 120 s)..."
API_READY=false
for _i in $(seq 1 60); do
  if docker exec memoriahub-api wget -qO- http://localhost:3000/api/health/live >/dev/null 2>&1; then
    API_READY=true
    break
  fi
  sleep 2
done

printf '\n'
RUNNING=$(docker compose -f "${COMPOSE_FILE}" ps --format '{{.Name}}' 2>/dev/null | wc -l)
info "Containers running: ${RUNNING}"

if [ "${API_READY}" = "true" ]; then
  ok "API health check passed"
else
  warn "API health check did not pass within 120 s"
  warn "Check logs: docker compose -f ${COMPOSE_FILE} logs api"
fi

# Final health read for display
API_STATUS="$(docker exec memoriahub-api wget -qO- http://localhost:3000/api/health/live 2>/dev/null || echo 'UNREACHABLE')"
info "API health response: ${API_STATUS}"

# ---------------------------------------------------------------------------
# First-install checklist
# ---------------------------------------------------------------------------
print_box "First-Install Checklist" \
  "1. Copy proxy config:" \
  "   cp ${NGINX_CONF}" \
  "      /opt/infra/proxy/nginx/conf.d/" \
  "" \
  "2. Issue TLS certificate:" \
  "   certbot certonly --webroot \\" \
  "     -w /opt/infra/proxy/webroot \\" \
  "     -d ${DOMAIN} \\" \
  "     --config-dir /opt/infra/proxy/letsencrypt" \
  "" \
  "3. Reload VPS proxy:" \
  "   docker exec proxy-nginx nginx -t" \
  "   docker exec proxy-nginx nginx -s reload" \
  "" \
  "4. Register Google OAuth redirect URI:" \
  "   https://${DOMAIN}/api/auth/google/callback" \
  "" \
  "5. Confirm DNS ${DOMAIN} -> this VPS" \
  "" \
  "6. Verify:" \
  "   curl https://${DOMAIN}/api/health/live" \
  "" \
  "Internal URL : http://127.0.0.1:${HOST_PORT}" \
  "External URL : https://${DOMAIN}"
