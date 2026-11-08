# VPS deployment: the generated infrastructure files

`infra/` is rendered by `npm run platform:infra:sync` from `@marinoscar/platform-infra`. Do not edit a generated file: `npm run platform:infra:sync -- --check` fails in CI when one differs from the package or the lock. MemoriaHub's differences from the platform live only in the app-owned files below.

## Generated and app-owned files

| Path | Owner | Change it by |
|---|---|---|
| `infra/compose/{base,dev,devdb,prod,vps,test,telemetry,vps.telemetry}.compose.yml`, `worker.compose.yml`, `worker.build.compose.yml` | generated | the platform package (a platform release) |
| `infra/compose/postgres-init/10-application-role.sh` | generated | the platform package |
| `infra/compose/.env.example`, `.env.worker.example` | generated | `infra/compose/app.env.example` (app variables) |
| `infra/nginx/nginx.conf`, `csp.conf`, `csp.dev.conf`, `platform/*` | generated | the platform package |
| `infra/otel/otel-collector-config.yaml`, `telemetry` files | generated | the platform package |
| `infra/platform-infra.lock.json` | generated | `npm run platform:infra:sync` |
| `infra/compose/app.*.compose.yml` | app | the app overlays, listed below |
| `infra/compose/app.env.example` | app | the app's variables |
| `infra/nginx/app.d/**` | app | the app's nginx include points |
| `infra/otel/app-collector.yaml` | app | the collector overlay (comments only today) |
| `infra/aws/**` | app | the S3 bucket helper |
| `infra/deploy/install.sh`, `update.sh` | app | still present until RETRO-F3; see `docs/platform-adoption/deploy-steps.md` |

## App compose overlays

| Overlay | Applies to | What it does |
|---|---|---|
| `app.compreface.compose.yml` | dev, devdb, prod, vps | the CompreFace face sidecar |
| `app.models-volume.compose.yml` | dev, devdb, prod, vps | a named volume for the CLIP model (`MODELS_DIR`) |
| `app.devdb.pgvector.compose.yml` | devdb | the development database uses pgvector |
| `app.test.pgvector.compose.yml` | test | the test database uses pgvector |
| `app.prod.memory-limits.compose.yml` | prod, vps | API 6G, V8 heap 5120 MB, web 128M (`API_MEMORY_LIMIT`, `NODE_OPTIONS`, `WEB_MEMORY_LIMIT`) |
| `app.prod.web-listen.compose.yml` | prod, vps | the production web container listens on 5173 (see local-exceptions) |
| `app.vps.no-stack-agent.compose.yml` | vps | the stack agent (the Docker socket holder) is not started |
| `app.worker.compreface.compose.yml` | worker | the CompreFace sidecar beside the worker |
| `app.worker.memoriahub.compose.yml` | worker | the variables MemoriaHub's worker CLI reads |
| `app.worker.build.compose.yml` | worker | builds the `worker` stage of `apps/cli/Dockerfile` |

Compose applies the overlays only when they are listed. Use the platform's order:

```bash
# dev with the face sidecar and the development database
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml -f app.compreface.compose.yml -f app.devdb.pgvector.compose.yml -f app.models-volume.compose.yml up
```

## Two values became required

The platform's `vps` mode needs two values in `infra/compose/.env` that the hand-written installer did not write:

- `DEPLOY_ROOT`: the deploy's root directory (`/opt/infra/apps/memoriahub` by default).
- `STACK_AGENT_TOKEN`: a random token. Generate it with `openssl rand -hex 32`.

The stack agent is disabled for this app, so nothing listens for the token, but the API refuses to start without it. The deploy (RETRO-F3) writes both on install and on update. Add them by hand to an existing `.env` before the first `deploy update` after this change.

## Ports

- The development stack publishes nginx on `3535` (`NGINX_PORT`), as `AGENTS.md` and `CLAUDE.md` state.
- The VPS binds `127.0.0.1:${APP_BIND_PORT}` (the platform default is `3535`). The installer's historical default, `8328`, is a deploy choice (`docs/platform-adoption/deploy-steps.md`).

## Verifying a change to infra/

```bash
npm run platform:infra:sync -- --check     # generated files and lock
cd apps/cli && npx jest --config jest.config.js test/infra-conformance.spec.ts   # compose config, nginx -t, overlays
```

The conformance suite needs Docker (`docker compose config`) and an nginx binary or a running daemon for `nginx -t`. A missing tool is reported in the test name, not hidden.

## Deploying with the CLI

`memoriahub deploy install` and `memoriahub deploy update` (CLI 1.4.0) run the platform deploy pipeline with MemoriaHub's steps (`database-extensions`, `compreface-healthy`) and checks (`pgvector-available`, `models-dir`); run `memoriahub deploy doctor` first. Defaults match the old `infra/deploy/install.sh`: root `/opt/infra/apps/memoriahub`, host port 8328, domain `memoriahub.marin.cr`; override with `--root`, `--port`, `--domain` or `MEMORIAHUB_HOME`, `MEMORIAHUB_PORT`, `MEMORIAHUB_DOMAIN`. Reference: [apps/cli/README.md](../../apps/cli/README.md#deploying-a-server-memoriahub-deploy). `infra/deploy/install.sh` and `update.sh` are kept as a fallback until a first production deploy with the CLI has been verified.
