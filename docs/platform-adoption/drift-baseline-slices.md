# Platform drift report

Generated 2026-11-08T00:46:04.127Z by `scripts/platform-drift.mjs` (schema 1).

| | Root | Commit |
|---|---|---|
| Base | `<EAB slice view of 59e377c>` | not a git checkout |
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
| api | `apps/api/src` | 865 | 8 | 5 | 122 | 730 | 841 | +8065 / -11144 | 1.5% |

## Modules by changed lines

| Area | Module | Files | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|
| api | `db-backup` | 64 | 12 | 39 | 13 | +1891 / -3231 | 0% |
| api | `notifications` | 133 | 15 | 60 | 58 | +1345 / -1922 | 0% |
| api | `nodes` | 70 | 8 | 40 | 22 | +1095 / -1048 | 0% |
| api | `settings` | 47 | 5 | 27 | 15 | +1190 / -610 | 0% |
| api | `auth` | 62 | 17 | 31 | 10 | +504 / -1174 | 7.7% |
| api | `storage` | 125 | 19 | 62 | 43 | +1072 / -567 | 1.2% |
| api | `email` | 58 | 10 | 36 | 12 | +318 / -907 | 0% |
| api | `device-auth` | 19 | 13 | 2 | 2 | +353 / -780 | 11.8% |
| api | `openapi` | 16 | 7 | 0 | 7 | +133 / -320 | 22.2% |
| api | `users` | 16 | 6 | 1 | 8 | +52 / -250 | 12.5% |
| api | `pat` | 8 | 5 | 0 | 2 | +53 / -169 | 16.7% |
| api | `health` | 9 | 1 | 4 | 4 | +37 / -54 | 0% |
| api | `ai` | 262 | 1 | 252 | 9 | +12 / -76 | 0% |
| api | `allowlist` | 10 | 3 | 2 | 3 | +10 / -36 | 28.6% |
| api | `(root)` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| api | `about` | 9 | 0 | 9 | 0 | +0 / -0 | 0% |
| api | `android-app` | 22 | 0 | 0 | 22 | +0 / -0 | n/a |
| api | `burst` | 16 | 0 | 0 | 16 | +0 / -0 | n/a |
| api | `circles` | 14 | 0 | 0 | 14 | +0 / -0 | n/a |
| api | `common` | 53 | 0 | 0 | 53 | +0 / -0 | n/a |
| api | `config` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| api | `credentials` | 19 | 0 | 19 | 0 | +0 / -0 | 0% |
| api | `dedup` | 25 | 0 | 0 | 25 | +0 / -0 | n/a |
| api | `doctor` | 6 | 0 | 0 | 6 | +0 / -0 | n/a |
| api | `enhancement` | 23 | 0 | 0 | 23 | +0 / -0 | n/a |
| api | `enrichment` | 34 | 0 | 0 | 34 | +0 / -0 | n/a |
| api | `export` | 33 | 0 | 33 | 0 | +0 / -0 | 0% |
| api | `face` | 41 | 0 | 0 | 41 | +0 / -0 | n/a |
| api | `geo` | 13 | 0 | 0 | 13 | +0 / -0 | n/a |
| api | `insights` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `jobs` | 70 | 0 | 70 | 0 | +0 / -0 | 0% |
| api | `location-groups` | 17 | 0 | 0 | 17 | +0 / -0 | n/a |
| api | `location-inference` | 21 | 0 | 0 | 21 | +0 / -0 | n/a |
| api | `media` | 102 | 0 | 0 | 102 | +0 / -0 | n/a |
| api | `media-sync` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| api | `memories` | 65 | 0 | 0 | 65 | +0 / -0 | n/a |
| api | `metadata` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `onboarding` | 16 | 0 | 16 | 0 | +0 / -0 | 0% |
| api | `prisma` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| api | `review-runs` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| api | `search` | 15 | 0 | 0 | 15 | +0 / -0 | n/a |
| api | `share` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `social-media` | 12 | 0 | 0 | 12 | +0 / -0 | n/a |
| api | `storage-settings` | 11 | 0 | 0 | 11 | +0 / -0 | n/a |
| api | `tagging` | 19 | 0 | 0 | 19 | +0 / -0 | n/a |
| api | `test-auth` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| api | `user-data` | 27 | 0 | 27 | 0 | +0 / -0 | 0% |
| api | `workflows` | 52 | 0 | 0 | 52 | +0 / -0 | n/a |

## Most changed files (top 50)

| File | Lines +/- |
|---|---|
| `apps/api/src/db-backup/database-restore.service.ts` | +879 / -1146 |
| `apps/api/src/settings/system-settings/system-settings.service.ts` | +838 / -310 |
| `apps/api/src/auth/auth.service.ts` | +297 / -785 |
| `apps/api/src/nodes/nodes.service.ts` | +641 / -326 |
| `apps/api/src/notifications/notifications.service.ts` | +476 / -432 |
| `apps/api/src/nodes/nodes.controller.ts` | +248 / -416 |
| `apps/api/src/db-backup/db-backup-admin.service.ts` | +265 / -380 |
| `apps/api/src/storage/objects/objects.service.ts` | +394 / -242 |
| `apps/api/src/db-backup/db-backup.controller.ts` | +158 / -339 |
| `apps/api/src/notifications/broadcasts/broadcasts.service.ts` | +160 / -310 |
| `apps/api/src/settings/user-settings/user-settings.service.ts` | +260 / -208 |
| `apps/api/src/notifications/notifications.controller.ts` | +173 / -282 |
| `apps/api/src/device-auth/device-auth.service.ts` | +140 / -295 |
| `apps/api/src/email/email-settings.service.ts` | +73 / -291 |
| `apps/api/src/db-backup/pg-dump.util.ts` | +149 / -210 |
| `apps/api/src/db-backup/admin-connection.util.ts` | +134 / -218 |
| `apps/api/src/db-backup/schedule.util.ts` | +28 / -300 |
| `apps/api/src/device-auth/README.md` | +40 / -282 |
| `apps/api/src/notifications/broadcasts/handlers/broadcast-chunk.handler.ts` | +71 / -225 |
| `apps/api/src/notifications/notification-stream.service.ts` | +75 / -181 |
| `apps/api/src/storage/objects/objects.controller.ts` | +152 / -85 |
| `apps/api/src/notifications/broadcasts/broadcasts.controller.ts` | +64 / -167 |
| `apps/api/src/storage/providers/s3/s3-storage.provider.ts` | +159 / -70 |
| `apps/api/src/users/users.service.ts` | +27 / -189 |
| `apps/api/src/db-backup/pg-version.util.ts` | +65 / -150 |
| `apps/api/src/email/templates/layout.ts` | +61 / -148 |
| `apps/api/src/db-backup/dto/db-backup-restore.dto.ts` | +41 / -165 |
| `apps/api/src/nodes/nodes-admin.controller.ts` | +64 / -111 |
| `apps/api/src/db-backup/pg-restore.util.ts` | +77 / -86 |
| `apps/api/src/nodes/node-credential.service.ts` | +74 / -89 |
| `apps/api/src/auth/auth.controller.ts` | +74 / -88 |
| `apps/api/src/email/providers/smtp-email.provider.ts` | +51 / -109 |
| `apps/api/src/pat/pat.service.ts` | +34 / -118 |
| `apps/api/src/notifications/broadcasts/handlers/broadcast-start.handler.ts` | +53 / -97 |
| `apps/api/src/db-backup/db-backup.errors.ts` | +4 / -136 |
| `apps/api/src/openapi/description.ts` | +61 / -78 |
| `apps/api/src/email/providers/ses-email.provider.ts` | +49 / -88 |
| `apps/api/src/storage/processing/object-processing.service.ts` | +69 / -61 |
| `apps/api/src/openapi/register-docs-routes.ts` | +11 / -106 |
| `apps/api/src/notifications/notification-policy.service.ts` | +93 / -23 |
| `apps/api/src/email/email-settings.controller.ts` | +22 / -91 |
| `apps/api/src/notifications/notifications.module.ts` | +29 / -78 |
| `apps/api/src/db-backup/db-backup.module.ts` | +20 / -85 |
| `apps/api/src/openapi/docs-page.ts` | +22 / -78 |
| `apps/api/src/nodes/nodes.module.ts` | +42 / -55 |
| `apps/api/src/auth/dto/auth-user.dto.ts` | +17 / -74 |
| `apps/api/src/health/health.controller.ts` | +37 / -54 |
| `apps/api/src/ai/ai.module.ts` | +12 / -76 |
| `apps/api/src/email/templates/broadcast.email.ts` | +22 / -66 |
| `apps/api/src/db-backup/dto/db-backup-config.dto.ts` | +71 / -16 |

## Zero-drift modules

Modules where every file exists on both sides and is identical or normalised-identical: the candidates for early adoption.

None.
