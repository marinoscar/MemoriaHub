# Platform drift report

Generated 2026-11-08T00:45:51.471Z by `scripts/platform-drift.mjs` (schema 1).

| | Root | Commit |
|---|---|---|
| Base | `<EnterpriseAppBase@59e377c>` | `59e377cbebb60e711fe4d7b0d818715f23af8a59` |
| App | `<MemoriaHub@928ea68>` | `928ea684fe95329d4a81e1e4b47ba3c54354e919` |

## Identity replacements

Every value in this table, base or app, is replaced by its token on both sides before comparing, so these differences are ignored. A row marked "no" is unknown on one side and was not applied (pass the `--base-*`/`--app-*` flags).

| Placeholder | Base | App | Applied as |
|---|---|---|---|
| `__PRODUCT__` | `My App` | `MemoriaHub` | `__PRODUCT__` |
| `__SLUG__` | `my-app` | `memoriahub` | `__SLUG__` |
| `__SLUG_SNAKE__` | `my_app` | `memoriahub` | `__SLUG__` |
| `__SERVICE__` | `my-app-api` | `memoriahub-api` | `__SERVICE__` |
| `__REPO_SLUG__` | `marinoscar/EnterpriseAppBase` | `marinoscar/MemoriaHub` | `__REPO_SLUG__` |
| `__REPO_NAME__` | `EnterpriseAppBase` | `MemoriaHub` | `__PRODUCT__` |
| `__CLI__` | `appctl` | `memoriahub` | `__SLUG__` |
| `__CLI_UPPER__` | `APPCTL` | `MEMORIAHUB` | `__CLI_UPPER__` |
| `__CLI_TITLE__` | `Appctl` | `Memoriahub` | `__CLI_TITLE__` |

## Areas

"Identical" counts identical plus normalised-identical files over every base file in the area (present on both sides, or base-only).

| Area | Root | Base files | Identical | Normalised-identical | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|---|---|
| api | `apps/api/src` | 269 | 0 | 0 | 15 | 254 | 961 | +2141 / -542 | 0% |
| api-test | `apps/api/test` | 369 | 12 | 0 | 24 | 333 | 52 | +901 / -1864 | 3.3% |
| web | `apps/web/src` | 273 | 12 | 1 | 58 | 202 | 743 | +6078 / -5362 | 4.8% |
| cli | `apps/cli/src` | 302 | 0 | 0 | 17 | 285 | 193 | +4482 / -3323 | 0% |
| prisma | `apps/api/prisma` | 64 | 3 | 1 | 2 | 58 | 80 | +289 / -29 | 6.3% |
| infra | `infra` | 32 | 0 | 0 | 7 | 25 | 8 | +150 / -323 | 0% |
| stack-agent | `apps/stack-agent/src` (not in app) | 7 | 0 | 0 | 0 | 7 | 0 | +0 / -0 | 0% |
| android | `apps/android` | 26 | 4 | 1 | 15 | 6 | 176 | +377 / -114 | 19.2% |
| packages | `packages` | 3785 | 0 | 0 | 0 | 3785 | 50 | +0 / -0 | 0% |
| scripts | `scripts` | 16 | 1 | 0 | 1 | 14 | 3 | +21 / -24 | 6.3% |
| github | `.github` | 16 | 4 | 0 | 4 | 8 | 0 | +395 / -392 | 25% |

## Modules by changed lines

| Area | Module | Files | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|
| web | `__tests__` | 424 | 30 | 135 | 251 | +3153 / -4317 | 4.6% |
| cli | `node` | 86 | 9 | 57 | 20 | +1892 / -1539 | 0% |
| cli | `commands` | 28 | 2 | 8 | 18 | +1435 / -562 | 0% |
| api | `common` | 71 | 6 | 18 | 47 | +1455 / -161 | 0% |
| cli | `(root)` | 56 | 5 | 34 | 17 | +409 / -1185 | 0% |
| api-test | `settings` | 16 | 2 | 14 | 0 | +437 / -543 | 0% |
| web | `(root)` | 4 | 4 | 0 | 0 | +334 / -610 | 0% |
| web | `components/navigation` | 6 | 4 | 0 | 2 | +761 / -32 | 0% |
| cli | `tui` | 97 | 1 | 48 | 48 | +746 / -37 | 0% |
| github | `workflows` | 9 | 3 | 6 | 0 | +371 / -373 | 0% |
| api | `openapi` | 18 | 3 | 2 | 13 | +430 / -199 | 0% |
| api-test | `fixtures` | 8 | 4 | 0 | 3 | +64 / -417 | 20% |
| web | `hooks` | 95 | 6 | 2 | 86 | +433 / -38 | 11.1% |
| web | `config` | 7 | 2 | 3 | 2 | +283 / -162 | 0% |
| android | `app` | 188 | 9 | 6 | 173 | +310 / -73 | 0% |
| web | `pages/Admin` | 42 | 2 | 2 | 38 | +331 / -24 | 0% |
| web | `types` | 10 | 1 | 0 | 9 | +252 / -69 | 0% |
| web | `services` | 55 | 2 | 1 | 52 | +273 / -35 | 0% |
| api | `(root)` | 6 | 3 | 2 | 1 | +195 / -106 | 0% |
| prisma | `seed` | 3 | 1 | 2 | 0 | +283 / -14 | 0% |
| api-test | `android-app` | 7 | 1 | 3 | 3 | +195 / -97 | 0% |
| api-test | `integration` | 7 | 1 | 5 | 1 | +0 / -266 | 0% |
| api-test | `storage` | 14 | 1 | 5 | 8 | +35 / -216 | 0% |
| api-test | `openapi` | 3 | 2 | 1 | 0 | +60 / -149 | 0% |
| infra | `otel` | 3 | 1 | 1 | 1 | +16 / -182 | 0% |
| infra | `compose` | 16 | 5 | 10 | 1 | +81 / -90 | 0% |
| infra | `nginx` | 15 | 1 | 13 | 1 | +53 / -51 | 0% |
| api-test | `auth` | 11 | 3 | 7 | 1 | +50 / -46 | 0% |
| web | `theme` | 4 | 3 | 0 | 1 | +76 / -17 | 0% |
| web | `components/common` | 10 | 1 | 0 | 7 | +71 / -22 | 66.7% |
| api | `config` | 4 | 1 | 1 | 2 | +39 / -41 | 0% |
| web | `pages` | 14 | 1 | 2 | 10 | +49 / -22 | 25% |
| api-test | `helpers` | 14 | 3 | 8 | 2 | +29 / -39 | 8.3% |
| web | `contexts` | 6 | 1 | 0 | 5 | +56 / -8 | 0% |
| android | `scripts` | 2 | 1 | 0 | 1 | +32 / -27 | 0% |
| api | `prisma` | 11 | 2 | 9 | 0 | +22 / -35 | 0% |
| api-test | `mocks` | 6 | 2 | 1 | 1 | +10 / -42 | 40% |
| scripts | `(root)` | 19 | 1 | 14 | 3 | +21 / -24 | 6.3% |
| github | `(root)` | 3 | 1 | 1 | 0 | +24 / -19 | 33.3% |
| api-test | `errors` | 1 | 1 | 0 | 0 | +2 / -31 | 0% |
| android | `gradle` | 3 | 1 | 0 | 0 | +28 / -1 | 66.7% |
| prisma | `(root)` | 3 | 1 | 1 | 0 | +6 / -15 | 33.3% |
| android | `(root)` | 9 | 4 | 0 | 2 | +7 / -13 | 42.9% |
| api-test | `rbac` | 4 | 1 | 2 | 0 | +7 / -6 | 25% |
| web | `components/user` | 3 | 1 | 0 | 2 | +6 / -6 | 0% |
| api-test | `(root)` | 16 | 1 | 9 | 0 | +10 / -1 | 37.5% |
| api-test | `test-auth` | 1 | 1 | 0 | 0 | +0 / -8 | 0% |
| api-test | `health` | 1 | 1 | 0 | 0 | +2 / -3 | 0% |
| api | `ai` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| api | `allowlist` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `android-app` | 22 | 0 | 0 | 22 | +0 / -0 | n/a |
| api | `app-registrations` | 21 | 0 | 21 | 0 | +0 / -0 | 0% |
| api | `auth` | 31 | 0 | 0 | 31 | +0 / -0 | n/a |
| api | `burst` | 16 | 0 | 0 | 16 | +0 / -0 | n/a |
| api | `circles` | 14 | 0 | 0 | 14 | +0 / -0 | n/a |
| api | `db-backup` | 25 | 0 | 0 | 25 | +0 / -0 | n/a |
| api | `dedup` | 25 | 0 | 0 | 25 | +0 / -0 | n/a |
| api | `device-auth` | 17 | 0 | 0 | 17 | +0 / -0 | n/a |
| api | `doctor` | 7 | 0 | 1 | 6 | +0 / -0 | 0% |
| api | `email` | 22 | 0 | 0 | 22 | +0 / -0 | n/a |
| api | `enhancement` | 23 | 0 | 0 | 23 | +0 / -0 | n/a |
| api | `enrichment` | 34 | 0 | 0 | 34 | +0 / -0 | n/a |
| api | `examples` | 30 | 0 | 30 | 0 | +0 / -0 | 0% |
| api | `face` | 41 | 0 | 0 | 41 | +0 / -0 | n/a |
| api | `geo` | 13 | 0 | 0 | 13 | +0 / -0 | n/a |
| api | `health` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| api | `identity-extensions` | 6 | 0 | 6 | 0 | +0 / -0 | 0% |
| api | `insights` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `jobs` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api | `location-groups` | 17 | 0 | 0 | 17 | +0 / -0 | n/a |
| api | `location-inference` | 21 | 0 | 0 | 21 | +0 / -0 | n/a |
| api | `media` | 102 | 0 | 0 | 102 | +0 / -0 | n/a |
| api | `media-sync` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| api | `memories` | 65 | 0 | 0 | 65 | +0 / -0 | n/a |
| api | `metadata` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `nodes` | 30 | 0 | 0 | 30 | +0 / -0 | n/a |
| api | `notifications` | 73 | 0 | 0 | 73 | +0 / -0 | n/a |
| api | `onboarding` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api | `pat` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `platform` | 89 | 0 | 89 | 0 | +0 / -0 | 0% |
| api | `platform-extensions` | 64 | 0 | 64 | 0 | +0 / -0 | 0% |
| api | `review-runs` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| api | `search` | 15 | 0 | 0 | 15 | +0 / -0 | n/a |
| api | `settings` | 28 | 0 | 8 | 20 | +0 / -0 | 0% |
| api | `share` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `social-media` | 12 | 0 | 0 | 12 | +0 / -0 | n/a |
| api | `storage` | 63 | 0 | 0 | 63 | +0 / -0 | n/a |
| api | `storage-settings` | 11 | 0 | 0 | 11 | +0 / -0 | n/a |
| api | `tagging` | 19 | 0 | 0 | 19 | +0 / -0 | n/a |
| api | `test-auth` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| api | `users` | 15 | 0 | 0 | 15 | +0 / -0 | n/a |
| api | `workflows` | 52 | 0 | 0 | 52 | +0 / -0 | n/a |
| api-test | `about` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `ai` | 21 | 0 | 21 | 0 | +0 / -0 | 0% |
| api-test | `alerts` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| api-test | `broadcasts` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `circles` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| api-test | `conformance` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `credentials` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `db-backup` | 10 | 0 | 10 | 0 | +0 / -0 | 0% |
| api-test | `device-auth` | 2 | 0 | 1 | 1 | +0 / -0 | 0% |
| api-test | `doctor` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `email` | 3 | 0 | 2 | 1 | +0 / -0 | 0% |
| api-test | `enhancement` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| api-test | `event-bus` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api-test | `examples` | 67 | 0 | 67 | 0 | +0 / -0 | 0% |
| api-test | `exports` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| api-test | `identity` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `jobs` | 18 | 0 | 18 | 0 | +0 / -0 | 0% |
| api-test | `maintenance` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `media` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| api-test | `media-sync` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api-test | `memories` | 12 | 0 | 0 | 12 | +0 / -0 | n/a |
| api-test | `nodes` | 15 | 0 | 15 | 0 | +0 / -0 | 0% |
| api-test | `notifications` | 45 | 0 | 43 | 2 | +0 / -0 | 0% |
| api-test | `onboarding` | 4 | 0 | 4 | 0 | +0 / -0 | 0% |
| api-test | `organizations` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `platform` | 7 | 0 | 7 | 0 | +0 / -0 | 0% |
| api-test | `prisma` | 14 | 0 | 14 | 0 | +0 / -0 | 0% |
| api-test | `retention` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `review-runs` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| api-test | `sharing` | 12 | 0 | 12 | 0 | +0 / -0 | 0% |
| api-test | `telemetry` | 11 | 0 | 11 | 0 | +0 / -0 | 0% |
| api-test | `tenancy` | 8 | 0 | 8 | 0 | +0 / -0 | 0% |
| api-test | `user-data` | 6 | 0 | 6 | 0 | +0 / -0 | 0% |
| api-test | `users` | 2 | 0 | 0 | 1 | +0 / -0 | 100% |
| api-test | `webhooks` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `workflows` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| cli | `android` | 18 | 0 | 0 | 18 | +0 / -0 | n/a |
| cli | `backup` | 16 | 0 | 0 | 16 | +0 / -0 | n/a |
| cli | `convert` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| cli | `date-inference` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| cli | `dates` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| cli | `db` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| cli | `deploy` | 135 | 0 | 135 | 0 | +0 / -0 | 0% |
| cli | `export` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| cli | `http` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| cli | `init` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| cli | `organize` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| cli | `render` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| cli | `repo` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| cli | `reports` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| cli | `scan` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| cli | `screenshots` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| cli | `sync` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| github | `ISSUE_TEMPLATE` | 4 | 0 | 1 | 0 | +0 / -0 | 75% |
| infra | `(root)` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| infra | `aws` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| infra | `deploy` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| packages | `(root)` | 4 | 0 | 4 | 0 | +0 / -0 | 0% |
| packages | `enrichment-compute` | 50 | 0 | 0 | 50 | +0 / -0 | n/a |
| packages | `platform-ai-providers` | 101 | 0 | 101 | 0 | +0 / -0 | 0% |
| packages | `platform-api` | 1838 | 0 | 1838 | 0 | +0 / -0 | 0% |
| packages | `platform-cli` | 398 | 0 | 398 | 0 | +0 / -0 | 0% |
| packages | `platform-contract` | 166 | 0 | 166 | 0 | +0 / -0 | 0% |
| packages | `platform-db` | 157 | 0 | 157 | 0 | +0 / -0 | 0% |
| packages | `platform-infra` | 113 | 0 | 113 | 0 | +0 / -0 | 0% |
| packages | `platform-web` | 1003 | 0 | 1003 | 0 | +0 / -0 | 0% |
| packages | `shared` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| prisma | `catalog` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| prisma | `fragments` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| prisma | `migrations` | 120 | 0 | 38 | 79 | +0 / -0 | 7.3% |
| prisma | `schema.prisma` | 14 | 0 | 13 | 1 | +0 / -0 | 0% |
| stack-agent | `(root)` | 7 | 0 | 7 | 0 | +0 / -0 | 0% |
| web | `assets` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/admin` | 16 | 0 | 0 | 16 | +0 / -0 | n/a |
| web | `components/album` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| web | `components/auth` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/collections` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/datatable` | 44 | 0 | 0 | 44 | +0 / -0 | n/a |
| web | `components/device-activation` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `components/home` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `components/insights` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| web | `components/locations` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/map` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| web | `components/media` | 30 | 0 | 0 | 30 | +0 / -0 | n/a |
| web | `components/memories` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| web | `components/notifications` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| web | `components/people` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| web | `components/pwa` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `components/review` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| web | `components/runs` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `components/search` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| web | `components/settings` | 28 | 0 | 0 | 28 | +0 / -0 | n/a |
| web | `components/share` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `components/workflows` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| web | `constants` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `identity` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| web | `jobs` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `lib` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `nodes` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `pages/Albums` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| web | `pages/Archive` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `pages/Bursts` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/Circles` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `pages/Collections` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `pages/Duplicates` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/Enhancements` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| web | `pages/Insights` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `pages/LocationSuggestions` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `pages/MediaLibrary` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/MediaMapPage` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/Memories` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/Notifications` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/People` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/Places` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| web | `pages/Profile` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `pages/Public` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `pages/Reviews` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `pages/Tags` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `pages/Trash` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `pages/Workflows` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| web | `platform` | 12 | 0 | 12 | 0 | +0 / -0 | 0% |
| web | `platform-extensions` | 38 | 0 | 38 | 0 | +0 / -0 | 0% |
| web | `utils` | 16 | 0 | 1 | 14 | +0 / -0 | 50% |

## Most changed files (top 50)

| File | Lines +/- |
|---|---|
| `apps/cli/src/commands/node.ts` | +1351 / -396 |
| `apps/api/src/common/schemas/settings.schema.ts` | +806 / -135 |
| `apps/cli/src/node/node-engine.ts` | +277 / -570 |
| `apps/cli/src/tui/app.tsx` | +746 / -37 |
| `apps/web/src/App.tsx` | +173 / -593 |
| `apps/web/src/__tests__/components/navigation/NavigationRail.test.tsx` | +240 / -438 |
| `apps/cli/src/node/install-deps.ts` | +527 / -139 |
| `apps/web/src/__tests__/components/admin/UserList.test.tsx` | +323 / -279 |
| `apps/web/src/__tests__/App.test.tsx` | +9 / -589 |
| `apps/api/src/common/types/settings.types.ts` | +528 / -4 |
| `apps/web/src/__tests__/pwa/service-worker.test.ts` | +243 / -281 |
| `apps/cli/src/node/daemon.ts` | +355 / -166 |
| `apps/api/test/settings/user-settings.integration.spec.ts` | +365 / -146 |
| `apps/cli/src/index.ts` | +82 / -428 |
| `apps/web/src/__tests__/mocks/handlers.ts` | +161 / -347 |
| `apps/web/src/__tests__/pages/HomePage.test.tsx` | +140 / -339 |
| `apps/api/test/settings/system-settings.integration.spec.ts` | +72 / -397 |
| `apps/web/src/__tests__/components/admin/AllowlistTable.test.tsx` | +298 / -164 |
| `apps/api/src/openapi/tags.ts` | +276 / -184 |
| `.github/workflows/ci.yml` | +79 / -359 |
| `apps/api/test/fixtures/test-data.factory.ts` | +52 / -370 |
| `apps/cli/src/node/capabilities.ts` | +233 / -173 |
| `apps/web/src/components/navigation/NavigationRail.tsx` | +384 / -4 |
| `apps/cli/src/device-auth.ts` | +145 / -233 |
| `apps/web/src/__tests__/components/navigation/AppBar.test.tsx` | +242 / -134 |
| `apps/web/src/__tests__/config/destinations.test.ts` | +105 / -250 |
| `apps/web/src/__tests__/components/settings/PersonalAccessTokens.test.tsx` | +208 / -146 |
| `apps/cli/src/config.ts` | +111 / -233 |
| `apps/web/src/config/adminSections.tsx` | +235 / -106 |
| `apps/web/src/types/index.ts` | +252 / -69 |
| `apps/web/src/__tests__/hooks/useNavigationPrefs.test.ts` | +285 / -19 |
| `apps/api/prisma/seed.ts` | +283 / -14 |
| `apps/api/test/android-app/android-app.integration.spec.ts` | +195 / -97 |
| `apps/web/src/services/api.ts` | +249 / -22 |
| `apps/api/test/integration/device-auth.integration.spec.ts` | +0 / -266 |
| `apps/web/src/__tests__/hooks/useScrollRestoration.test.ts` | +135 / -126 |
| `apps/web/src/__tests__/components/common/Layout.test.tsx` | +132 / -128 |
| `apps/web/src/__tests__/components/common/MaintenanceGate.test.tsx` | +84 / -169 |
| `apps/api/test/storage/storage.integration.spec.ts` | +35 / -216 |
| `apps/cli/src/commands/login.ts` | +84 / -166 |
| `apps/cli/src/node/memory-watchdog.ts` | +95 / -149 |
| `apps/web/src/__tests__/components/navigation/BottomNav.test.tsx` | +120 / -109 |
| `apps/cli/src/node/logger.ts` | +135 / -91 |
| `apps/cli/src/node/runtime-tuning.ts` | +95 / -108 |
| `apps/web/src/components/navigation/AppBar.tsx` | +190 / -11 |
| `apps/cli/src/device-login.ts` | +59 / -139 |
| `infra/otel/otel-collector-config.yaml` | +16 / -182 |
| `apps/web/src/__tests__/utils/test-utils.tsx` | +63 / -133 |
| `apps/android/app/build.gradle.kts` | +173 / -22 |
| `apps/web/src/pages/Admin/SettingsHubPage.tsx` | +173 / -18 |

## Migrations

Matched by normalised SQL first, then by the name after the 14-digit timestamp.

| Base | App | Shared | Renamed | Same name, different SQL | Base-only | App-only |
|---|---|---|---|---|---|---|
| 40 | 81 | 2 | 1 | 3 | 34 | 75 |

Renamed (same SQL, different id):

- `20260905182958_add_push_subscriptions` is `20260814000000_add_push_subscriptions` in the app

Same name, different SQL:

- `20260831010356_add_notification_deliveries` / `20260814010000_add_notification_deliveries`
- `20260831030721_add_notifications` / `20260805000000_add_notifications`
- `20260907130000_add_notification_broadcasts` / `20260815000000_add_notification_broadcasts`

Base-only:

- `20260830211041_add_credentials`
- `20260831014110_drop_stale_uuid_defaults`
- `20260906120000_add_jobs`
- `20260906190000_add_worker_nodes`
- `20260907120000_add_database_backup_runs`
- `20260907140000_add_backup_run_job_link`
- `20260907150000_add_job_node_secrets`
- `20260907160000_add_backup_run_pg_dump_version`
- `20260908120000_add_job_claim_token`
- `20260926034919_add_ai_platform`
- `20260927000000_revoke_viewer_ai_use`
- `20260927120000_add_user_credentials`
- `20260927130000_add_device_session_credential_link`
- `20260928100000_add_worker_node_vitals`
- `20260930120000_add_job_trace_context`
- `20261006120000_add_retention_created_at_indexes`
- `20261007141244_add_organizations`
- `20261007161956_split_system_org_roles`
- `20261007202337_org_scoped_rls`
- `20261007222406_add_groups`
- `20261008000859_add_grants`
- `20261008012052_add_org_settings`
- `20261008041856_add_org_credentials`
- `20261008052119_add_jobs_org_id`
- `20261008052120_add_jobs_org_id_status_index`
- `20261008080749_add_broadcast_target_org`
- `20261008120000_add_android_app`
- `20261013115831_open_job_reason`
- `20261013154013_ai_usage_feature`
- `20261013195500_add_app_metadata`
- `20261013214001_open_sharing_vocabularies`
- `20261101003924_add_worker_node_events`
- `20261101044654_add_webhooks`
- `20261101050011_add_alerts`

App-only:

- `20260610000000_add_media_domain`
- `20260612000000_add_media_content_hash_unique`
- `20260614170110_add_family_circles`
- `20260615000000_media_oncethisday_index`
- `20260615120000_ai_search`
- `20260617000000_add_face_recognition`
- `20260617100000_add_circle_face_recognition_flag`
- `20260618000000_refactor_face_jobs_to_enrichment_jobs`
- `20260619000000_add_person_profile_picture`
- `20260619100000_auto_tagging`
- `20260619200000_media_tag_source`
- `20260619210000_person_favorite`
- `20260619220000_drop_tag_label_description`
- `20260619233040_drop_search_conversations`
- `20260620000000_add_insights_snapshots`
- `20260620010000_enrichment_jobs_nullable_scope`
- `20260620020000_drop_media_item_title`
- `20260620030000_add_media_embeddings`
- `20260620040000_enrichment_jobs_scheduled_retry`
- `20260620050000_add_burst_detection`
- `20260620210000_perceptual_hash_to_text`
- `20260621020000_add_media_metadata_status`
- `20260621030000_remove_media_classification`
- `20260621030000_storage_provider_config`
- `20260621040000_remove_media_caption`
- `20260621050000_add_geo_provider_and_geocode_status`
- `20260621050000_drop_circle_feature_flags`
- `20260621133548_add_media_archived_at`
- `20260627000000_face_video_columns`
- `20260628000000_person_hidden_at`
- `20260628120000_add_job_stats_rollup`
- `20260628130000_add_media_shares`
- `20260702000000_add_visual_embeddings_and_duplicate_groups`
- `20260702010000_duplicate_groups_captured_at`
- `20260703000000_add_coord_source_and_location_suggestions`
- `20260704000000_add_face_hidden_at`
- `20260705000000_add_media_items_created_at_index`
- `20260705000000_add_media_tag_source_system`
- `20260705000100_add_social_media_detection`
- `20260709000000_add_album_cover_media_item`
- `20260710000000_distributed_worker_nodes`
- `20260712000000_add_face_hidden_reason`
- `20260713120000_add_burst_dup_resolution_tracking`
- `20260713130000_media_locations_index`
- `20260715000000_add_face_embedding_vector`
- `20260716000000_media_gallery_index`
- `20260716010000_add_media_enhancements`
- `20260716010000_worker_node_unique_name`
- `20260716020000_add_node_credentials`
- `20260718000000_add_face_assigned_embedding_index`
- `20260718000000_enrichment_jobs_admin_indexes`
- `20260719000000_add_workflow_tables`
- `20260719010000_enrichment_jobs_stats_perf_indexes`
- `20260724000000_trash_empty_runs`
- `20260725000000_location_suggestion_runs`
- `20260725010000_drop_face_external_id_and_human_provider`
- `20260725020000_drop_face_provider_region`
- `20260726000000_duplicate_group_confidence`
- `20260726010000_review_runs`
- `20260807000000_add_email_settings_permissions`
- `20260808000000_add_enhancement_staging_thumbnail`
- `20260808010000_add_backup_feed_foundations`
- `20260809130452_add_memories`
- `20260809140000_memories_on_this_day_index`
- `20260809150000_add_database_backups`
- `20260810000000_add_memories_ready_notification_type`
- `20260810010000_add_user_avatar_source_and_person_link`
- `20260810120000_remove_v0_backup_permissions`
- `20260811000000_add_location_groups`
- `20260812000000_add_media_transcripts`
- `20260813000000_add_media_enhancement_batches`
- `20260813010000_add_media_enhancement_cancelled_status`
- `20260815010000_add_admin_broadcast_notification_types`
- `20260816000000_add_android_app_and_media_sync`
- `20260816010000_add_android_release_storage_location`

## Prisma models

Base models present in the app: 24 of 46. Total models in the app: 73.

- Missing from the app: `AiModel`, `AiRun`, `AiUsageEvent`, `AlertIncident`, `AlertRule`, `Credential`, `Grant`, `Group`, `GroupInvite`, `GroupMember`, `Invite`, `Job`, `JobNodeSecret`, `Membership`, `OrgCredential`, `OrgSettings`, `Organization`, `UserAiKey`, `UserCredential`, `WebhookDelivery`, `WebhookEndpoint`, `WorkerNodeEvent`
- App-only: `AiProviderCredential`, `Album`, `AlbumItem`, `BurstGroup`, `Circle`, `CircleInvite`, `CircleMember`, `DuplicateGroup`, `EnrichmentJob`, `Face`, `FaceProviderCredential`, `GeoProviderCredential`, `InsightsSnapshot`, `LocationGroup`, `LocationGroupAlias`, `LocationSuggestion`, `MediaEnhancement`, `MediaEnhancementBatch`, `MediaFaceStatus`, `MediaGeocodeStatus`, `MediaItem`, `MediaItemEmbedding`, `MediaMetadataStatus`, `MediaShare`, `MediaSocialStatus`, `MediaSyncDevice`, `MediaSyncDiagnosticReport`, `MediaSyncRun`, `MediaTag`, `MediaTagStatus`, `MediaTranscript`, `Memory`, `MemoryItem`, `MemoryUserState`, `NodeBackupConfig`, `NodeBackupRun`, `Person`, `ReviewRun`, `ReviewRunItem`, `StorageMigrationItem`, `StorageMigrationRun`, `StorageProviderCredential`, `Tag`, `TagLabel`, `TrashEmptyRun`, `TrashEmptyRunItem`, `Workflow`, `WorkflowRun`, `WorkflowRunItem`

Shared models whose fields differ:

| Model | Fields added in the app | Fields removed in the app |
|---|---|---|
| `AuditEvent` | none | `org`, `orgId` |
| `DatabaseBackupRun` | `preRestoreBackupOf` | `createdAt`, `job`, `jobId`, `pgDumpVersion`, `restoresUsingThis`, `updatedAt` |
| `DeviceCode` | none | `collectedAt`, `credentialExpiresAt`, `org`, `orgId`, `pat`, `patId`, `refreshTokens`, `revokedAt` |
| `Notification` | `circle`, `circleId`, `data`, `deliveries`, `dismissedAt`, `type`, `updatedAt` | `eventKey` |
| `NotificationBroadcast` | `canceledBy`, `canceledById`, `critical`, `processedCount`, `recipientCount` | `eventKey`, `recipientsDispatched`, `recipientsTargeted`, `targetOrg`, `targetOrgId` |
| `NotificationDelivery` | `notification`, `notificationId`, `type` | `eventKey`, `recipient` |
| `Permission` | none | `scope` |
| `PersonalAccessToken` | `mediaSyncDevices` | `deviceCodes`, `org`, `orgId` |
| `PushSubscription` | none | `platform` |
| `RefreshToken` | none | `deviceCode`, `deviceCodeId`, `org`, `orgId` |
| `Role` | none | `invites`, `memberships`, `scope` |
| `StorageObject` | `mediaItem`, `migrationItems` | `org`, `orgId` |
| `StorageObjectChunk` | none | `org`, `orgId` |
| `User` | `aiCredentialsUpdated`, `albums`, `androidAppReleasesUploaded`, `avatarSource`, `avatarStorageKey`, `avatarVersion`, `circleInvitesAdded`, `circleInvitesClaimed`, `circleMemberships`, `databaseBackupsCreated`, `databaseBackupsRestored`, `faceCredentialsUpdated`, `geoCredentialsUpdated`, `linkedPerson`, `linkedPersonId`, `locationGroups`, `mediaEnhancementBatchesCreated`, `mediaEnhancementsCreated`, `mediaItems`, `mediaShares`, `mediaSyncDevices`, `memoryUserStates`, `notificationBroadcastsCanceled`, `notificationBroadcastsCreated`, `ownedCircles`, `peopleAdded`, `resolvedBursts`, `resolvedDuplicates`, `resolvedLocationSuggestions`, `reviewRunsStarted`, `storageCredentialsUpdated`, `tags`, `trashEmptyRunsStarted`, `workflowRunsApproved`, `workflowRunsStarted`, `workflowsCreated` | `aiKeys`, `aiModelsUpdated`, `aiRuns`, `aiUsageEvents`, `androidAppReleases`, `broadcastsCreated`, `credentialUpdates`, `databaseBackupRuns`, `databaseRestores`, `grantsGiven`, `grantsReceived`, `grantsRevoked`, `groupInvitesClaimed`, `groupInvitesSent`, `groupMembersAdded`, `groupMemberships`, `groupsCreated`, `invitesAccepted`, `invitesSent`, `memberships`, `metadata`, `orgCredentialUpdates`, `orgSettingsUpdates`, `organizationsCreated`, `userCredentials`, `webhookEndpoints` |
| `WorkerNode` | `backupConfig`, `backupRuns` | `events`, `lastVitals`, `lastVitalsAt` |

## Zero-drift modules

Modules where every file exists on both sides and is identical or normalised-identical: the candidates for early adoption.

None.
