# SSL & Nginx Reverse Proxy Setup for memoriahub.dev.marin.cr

> **Production deployment** (`memoriahub.marin.cr`) is covered in a separate guide:
> [docs/prod-deploy.md](prod-deploy.md). This document covers the development
> environment only.

## Overview

MemoriaHub is deployed behind a two-tier Nginx reverse proxy on the `dev.marin.cr` VPS, sharing the wildcard SSL certificate and subdomain routing infrastructure with the other projects on the host (Knecta, Knotes, Clipboard, ShellKeep, etc.).

This document covers the MemoriaHub-specific configuration. The pattern was adapted from the [ShellKeep SSL/Nginx Setup Guide](https://github.com/marinoscar/shellkeep/blob/main/docs/ssl-nginx-setup.md); MemoriaHub does **not** use the WebSocket terminal routing that ShellKeep needs, but it **does** raise the upload body-size limit for large photo/video uploads.

## Architecture

```
Internet (HTTPS :443)
|
v
Host Nginx (SSL termination, wildcard cert for *.dev.marin.cr)
|
|   map $host -> $backend_port:
|     memoriahub.dev.marin.cr  -> 127.0.0.1:8327
|
v  127.0.0.1:8327
Docker Compose (app-network + devnet)
+-- Nginx container (port 80 -> exposed as 8327, client_max_body_size 10g)
|   +-- /api  -> API container (port 3000)
|   +-- /     -> Web container (Vite dev :5173, or static :80 in prod)
+-- API container (NestJS + Fastify)  [joined to devnet]
+-- Web container (React + Vite)
+-- (no DB container -- uses external PostgreSQL `postgres` via devnet)
```

**Key characteristics:**

- **No database container**: MemoriaHub uses the shared external PostgreSQL container (hostname `postgres`) reachable on the `devnet` Docker network — the same pattern as Knecta and Knotes. The API container is attached to both `app-network` and `devnet`.
- **Large uploads**: the internal Nginx sets `client_max_body_size 10g` so the simple-upload endpoint (`POST /api/storage/objects`) accepts large media. Resumable multipart uploads use pre-signed URLs that go **directly to S3** and bypass Nginx entirely.
- **S3 storage**: media is stored in the dedicated `marin-memoriahub` S3 bucket (AWS credentials shared from the knecta stack). See [`infra/aws/README.md`](../infra/aws/README.md) for bucket provisioning and CORS setup.

## Port Assignment

The authoritative list lives in the host Nginx `map` block (`/etc/nginx/sites-available/dev-wildcard`):

| Project | Port | Subdomain |
|---------|------|-----------|
| ModelGate | 8318 | modelgate.dev.marin.cr |
| Knecta | 8319 | knecta.dev.marin.cr |
| Clipboard | 8320 | clipboard.dev.marin.cr |
| Semantic Convert | 8321 | semantic.dev.marin.cr |
| Verbograph | 8322 | verbograph.dev.marin.cr |
| ShellKeep | 8323 | shellkeep.dev.marin.cr |
| Store Front (raul1) | 8324 | raul1.dev.marin.cr |
| Store Front (raul2) | 8325 | raul2.dev.marin.cr |
| Knotes | 8326 | knotes.dev.marin.cr |
| **MemoriaHub** | **8327** | **memoriahub.dev.marin.cr** |

## Step 1: Update Host Nginx Map

Edit `/etc/nginx/sites-available/dev-wildcard` on the VPS and add MemoriaHub to the `map` block:

```nginx
map $host $backend_port {
    ...
    knotes.dev.marin.cr       8326;
    memoriahub.dev.marin.cr   8327;    # <-- add this
    ...
}
```

Test and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

No DNS changes needed — the wildcard `*.dev.marin.cr` already resolves to the VPS.
No new SSL certificate needed — the wildcard cert covers all subdomains.

> **Note — host Nginx must be running.** The host Nginx is a systemd service (`nginx.service`) that terminates SSL on :443. Its `ExecStartPre` runs `nginx -t` across **all** sites in `sites-enabled/`, so a broken config in *any* unrelated site (e.g. a transient `host not found in upstream` DNS failure) will prevent the whole service from starting and take every subdomain offline. If `https://memoriahub.dev.marin.cr` is unreachable, first check `systemctl status nginx` and `sudo nginx -t`, fix any failing site, then `sudo systemctl start nginx`.

## Step 2: Register Google OAuth Callback

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), add the following as an authorized redirect URI on the shared OAuth client:

```
https://memoriahub.dev.marin.cr/api/auth/google/callback
```

This must match `GOOGLE_CALLBACK_URL` in `infra/compose/.env`.

## Step 3: Create the Database

MemoriaHub uses the shared external PostgreSQL container. Create its database (idempotent — skip if it already exists):

```bash
docker exec postgres psql -U admin -d postgres -c "CREATE DATABASE memoriahub;"
```

## Step 4: Configure Environment

`infra/compose/.env` must contain (see `.env.example` for the full set):

```env
COMPOSE_PROJECT_NAME=memoriahub
APP_URL=https://memoriahub.dev.marin.cr
GOOGLE_CALLBACK_URL=https://memoriahub.dev.marin.cr/api/auth/google/callback
POSTGRES_HOST=postgres
POSTGRES_DB=memoriahub
POSTGRES_USER=admin
S3_BUCKET=marin-memoriahub
```

`POSTGRES_HOST=postgres` refers to the shared PostgreSQL container on the `devnet` network. The `.env` file is loaded into the API container via `env_file` in `base.compose.yml`, so every variable (cookie secret, storage limits, device-flow settings, etc.) is passed through automatically.

## Step 5: Ensure the devnet Network Exists

Shared with Knecta/Knotes and others; create only if missing:

```bash
docker network create devnet
```

## Step 6: Deploy

MemoriaHub runs in **development mode** on this host (matching Knotes/Clipboard): the internal Nginx routes `/` to the Vite dev server (`web:5173`) and `/api` to the NestJS API (`api:3000`).

```bash
cd /home/marinoscar/git/MemoriaHub/infra/compose

# Development (current host mode)
docker compose -f base.compose.yml -f dev.compose.yml up -d --build

# Production (static web build, 127.0.0.1-bound nginx)
docker compose -f base.compose.yml -f prod.compose.yml up -d --build
```

## Step 7: Apply Migrations & Seed

The first deploy must apply the Prisma schema and seed roles/permissions/initial-admin:

```bash
cd /home/marinoscar/git/MemoriaHub/infra/compose
docker compose -f base.compose.yml -f dev.compose.yml exec api npm run prisma:migrate   # migrate deploy
docker compose -f base.compose.yml -f dev.compose.yml exec api npm run prisma:seed
```

## Step 8: Verify

```bash
# Inside the host, against the published container port:
curl http://localhost:8327/api/health/live
# -> {"data":{"status":"ok"}}

# End-to-end through the host Nginx + SSL:
curl https://memoriahub.dev.marin.cr/api/health/live
curl -I https://memoriahub.dev.marin.cr/
```

Then open `https://memoriahub.dev.marin.cr/` and log in with Google (the `INITIAL_ADMIN_EMAIL` account becomes Admin on first login). Swagger UI is at `https://memoriahub.dev.marin.cr/api/docs`.

## Internal Nginx Configuration

MemoriaHub's Docker-internal Nginx (`infra/nginx/nginx.conf`) is the stock two-route reverse proxy (`/api` → API, `/` → Web) with one MemoriaHub-specific addition in the `http` block for large media uploads:

```nginx
# Allow large photo/video uploads through the simple-upload endpoint
# (POST /api/storage/objects). Matches the host nginx limit (10g) and
# the MAX_FILE_SIZE app setting. Resumable multipart uploads go directly
# to S3 via pre-signed URLs and bypass nginx entirely.
client_max_body_size 10g;
```

The host Nginx wildcard config already sets `client_max_body_size 10g`, so both tiers permit large bodies.

## Troubleshooting

**502 Bad Gateway:**
- Containers not running: `cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml ps`
- Port mismatch: verify `8327:80` in `base.compose.yml` matches the host Nginx map entry.

**Site unreachable / connection refused (all subdomains):**
- The host Nginx service is likely down. Check `systemctl status nginx`; run `sudo nginx -t` to find the offending site config; fix it, then `sudo systemctl start nginx`.

**Database connection refused:**
- Ensure `devnet` exists: `docker network ls | grep devnet`
- Verify the API container is on devnet and can reach Postgres: `docker compose exec api sh -c "nc -zv postgres 5432"`
- Verify the `memoriahub` database exists: `docker exec postgres psql -U admin -d postgres -c "\l" | grep memoriahub`

**413 Request Entity Too Large on upload:**
- Confirm `client_max_body_size 10g` is present in `infra/nginx/nginx.conf` (internal) and in the host `dev-wildcard` config.
- For very large files, prefer the resumable upload flow (`POST /api/storage/objects/upload/init`), which streams directly to S3.

**Google OAuth errors:**
- Verify `https://memoriahub.dev.marin.cr/api/auth/google/callback` is registered in Google Cloud Console and matches `GOOGLE_CALLBACK_URL` exactly.

**SSL certificate errors:**
- Check cert validity: `sudo certbot certificates`
- Test renewal: `sudo certbot renew --dry-run`

## File Reference

| File | Purpose |
|------|---------|
| `/etc/nginx/sites-available/dev-wildcard` | Host reverse proxy — subdomain-to-port map + SSL |
| `/etc/letsencrypt/live/dev.marin.cr/` | Wildcard SSL certificate and key |
| `infra/nginx/nginx.conf` | Docker-internal routing (incl. `client_max_body_size 10g`) |
| `infra/compose/base.compose.yml` | Base services (nginx, api on devnet, web); `env_file: .env` |
| `infra/compose/dev.compose.yml` | Development overrides (nginx 8327, hot reload, Vite) |
| `infra/compose/prod.compose.yml` | Production overrides (static build, resource limits) |
| `infra/compose/.env` | Environment variables (DB, Google OAuth, AWS S3) |
