# Deploy steps: the bash installers and their replacements

Issue #566 (RETRO-F2) retires the hand-written VPS installers in `infra/deploy/`. This page maps every behaviour of `install.sh` (first install) and `update.sh` (update) to where it goes, so the deploy pipeline that RETRO-F3 wires can be checked against it line by line.

**Status.** `infra/deploy/install.sh` and `infra/deploy/update.sh` are still in the repository. RETRO-F3 (#577) added the replacement: `memoriahub deploy install|update` (platform pipeline plus the app steps `database-extensions` and `compreface-healthy`, checks `pgvector-available` and `models-dir`). The scripts are intentionally still here as a fallback until the CLI deploy has run once on a real VPS; delete them in the PR that records that run. The platform generates `STACK_AGENT_TOKEN`/`DEPLOY_ROOT` and writes `APP_BIND_PORT` from `--port`, so the `stack-agent-token` and `public-port` steps needed no app code. `deploy install` defaults the port to 8328 (the old installer's), not the platform's 3535, and says so.

## Defaults to preserve

| Name | Installer default | Where it goes |
|---|---|---|
| Domain | `MEMORIAHUB_DOMAIN` = `memoriahub.marin.cr` | the `--domain` option of the deploy |
| Host port | `MEMORIAHUB_PORT` = `8328` | `APP_BIND_PORT` in `.env` (the loopback port the host proxy forwards to; `vps.compose.yml` binds `127.0.0.1:${APP_BIND_PORT}`) |
| Home | `MEMORIAHUB_HOME` = `/opt/infra/apps/memoriahub` | the `--root` option; `DEPLOY_ROOT` in `.env` |
| Compose project | `COMPOSE_PROJECT_NAME=memoriahub` | `.env` |

The platform's template default for `APP_BIND_PORT` is `3535`. A new `.env` copied from `.env.example` therefore binds 3535 unless the deploy writes `8328`. RETRO-F3 must choose one and say so in the deploy output.

## `install.sh` (first install, nine steps)

| Installer step | What it does today | Replacement |
|---|---|---|
| `[1/9] Checking required tools` | Requires docker, docker compose, git and openssl; exits if one is missing. | Platform `preflight` step (tool list from the platform; add any MemoriaHub-only tool to the app's preflight, F3). |
| `[2/9] Creating directory structure` | Creates `HOME_DIR` and its subdirectories. | Platform layout step under `--root`. |
| `[3/9] Fetching source code` | Clones the repository into `HOME_DIR/repo`. | Platform `checkout` step (the tag or branch is an input to the deploy). |
| `[4/9] Validating environment file` | Requires `HOME_DIR/.env`; if missing, prints the template and exits. Checks the production keys: `NODE_ENV`, `APP_URL`, `GOOGLE_CALLBACK_URL`, `POSTGRES_HOST/PORT/USER/PASSWORD/DB/SSL`, `JWT_SECRET`, `COOKIE_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `INITIAL_ADMIN_EMAIL`, `STORAGE_PROVIDER`, `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `MAX_FILE_SIZE`, `ALLOWED_MIME_TYPES`, `GEO_PROVIDER`, `DEVICE_PAT_TTL_DAYS`, `COMPOSE_PROJECT_NAME`. | Platform `environment` and `validate-environment` steps (the platform reads the declared keys from `.env.example`). App-specific required keys: the list above, plus `DEPLOY_ROOT` and `STACK_AGENT_TOKEN`, which the `vps` mode requires and the deploy generates (F3). |
| `[5/9] Generating production compose.yml` | Writes a hand-made `HOME_DIR/compose.yml` from a heredoc. | **Retired.** The `vps` mode composes the platform files and the app overlays (`composeFilesForMode('vps')`, `infra/compose/app.*.compose.yml`). No copy is written to `HOME_DIR`. |
| `[6/9] Generating VPS nginx proxy config` | Writes the host proxy vhost `memoriahub.conf` for `DOMAIN` (TLS terminated on the host, forwarding to `127.0.0.1:8328`). | Platform `proxy-bootstrap` step. The vhost must forward to `127.0.0.1:${APP_BIND_PORT}`. F3 decides whether the platform writes the vhost or the operator keeps the host file. |
| `[7/9] Building Docker images` | `docker compose build`. | Platform `build` step (api and web). The worker image is not built on the server. |
| `[8/9] Running database migrations and seed` | `docker compose run --rm -T api npm run prisma:migrate`, then `npm run prisma:seed`. | Platform `migrate` and `seed` steps: one-off API container, the same `npm run prisma:*` scripts (they build `DATABASE_URL` from `POSTGRES_*`). |
| `[9/9] Starting services` | `docker compose up -d`, then polls the API for up to 120 s. | Platform `start` and `health` steps. |

## `update.sh` (update, six steps)

| Updater step | What it does today | Replacement |
|---|---|---|
| Pre-flight | Checks the same tools and `.env`; keeps the last 10 log files under `HOME_DIR`. | Platform `preflight`; log retention is the platform's (F3 confirms). |
| `[1/6] Pull latest code` | `git pull` in `HOME_DIR/repo`; prints the new commits. | Platform `checkout` of the target tag. |
| `[2/6] Rebuild Docker images` | Rebuilds the images. | Platform `build`. |
| `[3/6] Run database migrations` | Stops the API first, to avoid migrating under a running application, then runs `prisma:migrate`. | Platform `migrate`, with the API stopped first. **Keep the order.** |
| `[4/6] Restart services` | `docker compose up -d`, then restarts nginx so it re-resolves the upstream container IPs after a rebuild. | Platform `start`, followed by an nginx restart. **Keep the nginx restart:** nginx caches upstream addresses for the life of the process. |
| `[5/6] Update VPS proxy config` | Copies the vhost when it differs, runs `nginx -t` on the proxy, reloads only when the test passes. | Platform `proxy-bootstrap` on update. **Keep "do not reload when `nginx -t` fails".** |
| `[6/6] Verify health` | Polls the API health route. | Platform `health`. |

`update.sh` also writes an update-state file at the end of a run (the "Save update state" step). Nothing in this repository reads it; F3 decides whether anything replaces it.

## Steps the platform does not provide (for RETRO-F3 to register)

| App step | Why | Check |
|---|---|---|
| `compreface-ready` | Face detection needs the `compreface-core` sidecar (`app.compreface.compose.yml`). The platform health check does not know it. | `compreface-core` reports healthy, or the face feature stays off. The sidecar has no health check in the API stack; add one in the overlay if the deploy must gate on it. |
| `database-extensions` | The `vector` extension is needed by the migrations. The deploy's database is external (cloud PostgreSQL), so the platform's `devdb` image does not apply. | The database has `pgvector` available (`pg_available_extensions`); the Doctor check `face.pgvector` reports the same. |
| `stack-agent-token` | `vps.compose.yml` requires `STACK_AGENT_TOKEN` and `DEPLOY_ROOT` in `.env`. The stack agent itself is disabled by `app.vps.no-stack-agent.compose.yml`, so the token is set but nothing listens for it. | Both values are non-empty before `compose config` runs. Existing installs need both added (see `docs/deployment/vps.md`). |
| `public-port` | The host proxy must match `APP_BIND_PORT`. | The proxy vhost forwards to the same port `.env` binds. |

## What the deploy does not change

- `.env` stays on the server, outside git. The deploy never writes a secret into a repository file.
- The database is not migrated by the API at startup. Migrations remain an explicit step (the `migrate` above).
- The worker bundle is not part of the server deploy. It is run on each worker host (`docs/worker-node-setup.md`).
