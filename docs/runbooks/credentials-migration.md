# Runbook: Move encrypted provider secrets into the platform credential store

**Audience:** the operator of a deployment upgrading to the release that adopts the platform
credentials slice (RETRO-B4, issue #617, epic #565).
**Applies to:** `face` and `geo` now; `storage`, `smtp`, `ses` and `push_vapid` are planned here and
applied by RETRO-D1, D2 and D3 together with the reader switch of each slice. AI keys
(`ai_provider_credentials`) are RETRO-E3.

Source of truth:

- `apps/api/src/legacy/legacy-credentials-migration.ts` (plan, apply, rules) and `legacy-credentials-pg.ts`
  (the SQL that reads each legacy source and writes the settings document).
- `apps/api/scripts/migrate-legacy-credentials.ts` (the command).
- `apps/api/src/legacy/legacy-credentials-migration.spec.ts` (every rule below, on fixtures encrypted by the legacy cipher).
- `apps/api/test/credentials/provider-credentials.db.spec.ts` (real Postgres: encrypted row, legacy table untouched, last4 only, no secret in logs).

## 1. What changes

| Secret | Legacy home | Now | Non-secret half |
|---|---|---|---|
| Google Maps key | `geo_provider_credentials` (`google`) | `credentials` `geo_provider/google` | `geo.google.{enabled,baseUrl}` in the `global` settings row |
| Face provider key (none for CompreFace, which is keyless) | `face_provider_credentials` | `credentials` `face_provider/<provider>` (only when a key exists) | `face.providers.compreface.{enabled,baseUrl}` |
| Storage secret access key | `storage_provider_credentials` | `storage/default` (D1) | stays with D1 |
| SMTP password | `system_settings.global.email.smtpPassword` | `smtp/default` (D2) | stays with D2 |
| SES secret | the S3 row (reused) | `email_ses/default` (D2) | stays with D2 |
| VAPID private key | `system_settings` row `webPush` | `push_vapid/default` (D3) | stays with D3 |

The legacy cipher stores base64 `[iv][tag][ciphertext]` under the master key. The platform cipher uses its own
envelope and a per-purpose sub-key, so each row is **decrypted with the legacy cipher and re-encrypted by
`CredentialsService.setSecret`**. Both use `SECRETS_ENCRYPTION_KEY`: use the key that encrypted the legacy rows.
No migration (schema change) is part of this step: the `credentials` table exists since RETRO-A5.

## 2. Rules the command enforces

- **Dry run by default.** `--apply` is explicit. A dry run prints, per legacy row, what it would write and
  the last-four hint (`••••1234`; `••••` for a secret shorter than eight characters). Never a secret.
- **All or nothing on decryption.** If `SECRETS_ENCRYPTION_KEY` cannot decrypt any requested row, the command
  exits 1, names the row (`geo_provider_credentials/google (<row id>)`) and writes nothing.
- **Round trip.** After each write the secret is read back through `getSecret` and compared. A mismatch fails.
- **Idempotent.** A target already holding the same secret is reported `already present` and left alone. The
  non-secret half is **set-if-absent**: a value an admin saved after cut-over is never overwritten.
- **Legacy rows are never modified or deleted.**
- `storage`, `smtp`, `ses` and `push_vapid` refuse `--apply` until their slice switches its reader.

## 3. Procedure

1. Take a database backup (Admin Database Backup, or `pg_dump`). Make sure the API has started once on the new
   release so the `global` settings row exists, and `SECRETS_ENCRYPTION_KEY` is the production value.
2. **Rehearse on a restored backup first** (the A5 rehearsal copy).
3. Dry run, from the repository root (or `npm run credentials:migrate-legacy --workspace=api -- ...`):

   ```bash
   npm run credentials:migrate-legacy -- --purpose geo
   npm run credentials:migrate-legacy -- --purpose face
   npm run credentials:migrate-legacy -- --purpose all     # also shows the D1/D2/D3 plans
   ```

   Expect `would write N` and zero `undecryptable`.
4. Apply (face and geo): `npm run credentials:migrate-legacy -- --purpose face --purpose geo --apply`.
   One log line per credential: purpose, name, hint, legacy row id.
5. Re-run the apply: every line must read `already present`.
6. Verify in the admin UI: `/admin/settings/geo` shows the key as `••••<last4>` and **Test connection** passes
   for Google; `/admin/settings/face` **Test connection** passes. A geocode job still resolves the key
   (server and worker node).
7. Doctor (`/admin/settings/doctor`) is green for `geo.reverse-provider` and `face.detection`.

The legacy tables stay in place until the follow-up PR that drops `face_provider_credentials` and
`geo_provider_credentials` (a `migration-lock` PR, after production ran this command).

## 4. Rollback

Revert the release: the old readers still read the legacy tables, which this command never touched. To remove the
written rows as well:

```sql
DELETE FROM credentials WHERE purpose IN ('face_provider', 'geo_provider');
```

The `face.providers` / `geo.google` settings keys are harmless to leave (the old code ignores unknown keys).

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `SECRETS_ENCRYPTION_KEY cannot decrypt: <row>` | The key differs from the one that encrypted the row, or the row was altered | Use the production key. If the row is lost, re-enter the key in the admin UI instead of migrating it |
| `Refusing to apply: storage not applicable yet` | The purpose is planned only | Run it with the slice that switches the reader (D1, D2, D3) |
| `The system_settings "global" row does not exist yet` | The API never started on this database | Start the API once, then re-run |
| Admin page shows the key as not configured after migrating | The migration ran against another database, or `geo.google.enabled` was set false | Check the target database; the switch is the **Enabled** toggle on the card |
