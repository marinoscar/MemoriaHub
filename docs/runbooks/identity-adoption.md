# Runbook: Identity on the Platform (RETRO-B2)

RETRO-B2 (issue [#611](https://github.com/marinoscar/MemoriaHub/issues/611), epic #565, program #555). MemoriaHub's sign-in, sessions, users, allowlist, personal access tokens, device flow and RBAC are the identity slice of `@marinoscar/platform-api`; the avatar state moved to an app-owned table. This page is what to run on a database before and after the migration, and how it was rehearsed. Run it as part of RETRO-A6 (the production train), after the A5 baseline.

## What changes in the database

Only one migration is new: `20261108030000_move_user_avatar_off_users`. It creates `user_profiles`, copies every user whose avatar state differs from the defaults (`avatar_source <> 'oauth'`, a stored key or version, or a person link), then drops `users.avatar_source`, `avatar_storage_key`, `avatar_version`, `linked_person_id`, the index and the foreign key, in one transaction. The identity tables themselves are untouched: platform migrations `0003` to `0040` (installed by A5) already added the default organization, the role scopes and the memberships (`0023`, `0024`).

The seed (`npm run prisma:seed`, now the platform seed over `prisma/catalog/permissions.json`) reconciles the roles, the permissions and their grants: upserts only. `infra/deploy/update.sh` runs it after `migrate deploy`.

## Before: pre-flight on the production copy

1. `SELECT count(*) FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id);` Users with NO role at all. Platform `0024` (step 4) gives every user the default org role (`viewer`), so they GAIN the viewer permissions. Every sign-up got `viewer`, so there should be none. If there are, decide: disable them (`is_active = false`) before the migration, or accept the gain with `--accept-roleless-viewer` below.
2. Take the snapshot: `node scripts/verify-identity-transform.mjs snapshot --out before.json` (uses `POSTGRES_*`; plain SQL; prints no secret).
3. `SELECT count(*) FROM users WHERE avatar_source <> 'oauth' OR avatar_storage_key IS NOT NULL OR avatar_version IS NOT NULL OR linked_person_id IS NOT NULL;` remember the number.

## Run

```bash
cd apps/api
npm run prisma:migrate          # the platform 0003-0040 on a fresh A5 copy, then the avatar migration
npm run prisma:seed
node scripts/verify-identity-transform.mjs verify --before before.json [--accept-roleless-viewer]
npm run db:check && npm run db:check:database
```

`verify` computes each user's effective permissions with the platform's own resolver (`resolveEffectiveAccess`, single-organization mode) and compares them with the snapshot, proves the PATs, refresh tokens, device codes, allowlist and node credentials kept their ids and hashes, that `media_sync_devices.pat_id` still points at its token, and that every non-default avatar state is in `user_profiles` (its count must equal the number from pre-flight step 3). Exit 0 means identical. Permissions that did not exist before (`organizations:*`, `org_members:*`, `org_invites:*`, `org_settings:*`) are reported as a NOTICE, not a failure.

## Rehearsal evidence (synthetic database)

PostgreSQL 16.15 with pgvector, a database built like A5's: the 82 app migrations, the old role catalog (`rbac.catalog.ts` matrix, 43 permissions, 63 grants) and `apps/api/scripts/fixtures/identity-transform-old-state.sql` (9 invented users: admin, contributor, viewer, no role, admin plus contributor, disabled, uploaded avatar, person avatar, person link only; refresh tokens live and revoked; a CLI PAT and an Android PAT linked to a media-sync device; a pending device code with `returnUri: memoriahub://pairing` and an approved one; a claimed and a pending allowlist entry; a node credential).

| Step | Result |
|---|---|
| `prisma migrate deploy` | 39 migrations applied (38 platform + the avatar one), no error, data in place |
| `verify` before the seed | 9 users compared, 0 lost permissions; the roleless user GAINED the 9 viewer permissions (the platform's step 4), reported and refused without `--accept-roleless-viewer`; credentials and avatars identical |
| `prisma:seed` (twice) | 51 permissions, 71 grants, idempotent |
| `verify` after the seed, `--accept-roleless-viewer` | `OK`; 3 non-default avatar states expected, 3 `user_profiles` rows; 8 new platform permissions noted as held by the two administrators |
| `db:check` / `db:check:database` | `ok (40 installed platform migration(s))` / `ok (121 ledger row(s) match the files)` |
| `db:drift` | the app's pre-existing legacy-table drift only (177 statements: renamed foreign keys, UUID defaults, HNSW and `media_visual_embedding`); nothing about `users`, `user_profiles` or any platform table |

## After: smoke

- Sign in (a real Google account on staging). `GET /api/auth/me` returns the permissions the user had; `extensions.memoriahub.timezone` is the stored zone or `null`.
- The first sign-in of a NEW user creates exactly one personal circle, and a pending circle invite for that address is claimed.
- CLI: `memoriahub login` with an existing PAT still works (`GET /api/auth/me`).
- Android: pair a test device (device flow with `clientInfo.tokenType: 'pat'`, `returnUri: memoriahub://...`); the token response carries `credentialType: 'pat'`, and the Custom Tab returns to the app.
- A worker node with a `nod_` credential claims jobs; the same credential on `GET /api/media` is refused (403).
- Another user's media-sync device answers 404.

## Rollback

Revert the PR on a database that never ran the avatar migration. Otherwise restore the backup taken in the A6 window and revert: the avatar columns are gone from `users`, and nothing else in the identity tables changed.
