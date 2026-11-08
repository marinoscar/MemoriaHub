# Runbook: email configuration (platform email slice)

**Applies to:** the release that adopts the platform email slice (RETRO-D2, issue #570) and later.
**Code:** `apps/api/src/platform/email/` (composition, `AppEmailSender`), `apps/api/src/email-templates/`
(MemoriaHub's three templates), `apps/api/src/legacy/email-settings-migration.ts` and
`apps/api/scripts/migrate-email-settings.ts` (the one-time carry-over). The admin page is the platform's
`EmailSettingsPage` at `/admin/settings/email`.

## What changed

| | Before | After |
|---|---|---|
| Routes | `GET`/`PUT /api/email-settings`, `POST /api/email-settings/test` (app) | Same paths, the platform's controller |
| Permission | `email_settings:read` / `email_settings:write` | `system_settings:read` / `system_settings:write` (the `email_settings:*` strings are retired) |
| Settings | `email.*` keys of the `global` settings row | The `email` row of `system_settings`: `provider`, `enabled`, `fromAddress`, `fromName`, `transports.smtp`, `transports.ses` |
| SMTP password | `email.smtpPassword` in the `global` row, legacy cipher | Credential `smtp/default` (credential store) |
| SES keys | Borrowed the S3 storage credential at send time | The SES transport's own: `transports.ses.accessKeyId` and credential `email_ses/default` (copied once from the S3 key pair by the migration) |
| SES region | `email.sesRegion`, else the S3 region | `transports.ses.region`, else `AWS_SES_REGION` (the migration fills the region from `sesRegion`, else the S3 region) |
| Test send | To any recipient typed in the form | To the signed-in admin's own address only (no recipient field) |
| Templates | App layout | Platform layout, MemoriaHub brand colour `#1976d2`; names unchanged (`circle-invitation`, `membership-confirmation`, `memory-digest`); broadcasts use the platform `broadcast` template |

Sends stay fire-and-forget: a failed or unconfigured email never fails the circle invite, the member add or the
invite claim. The digest keeps its `List-Unsubscribe` and `List-Unsubscribe-Post` headers (the platform transports
pass message headers through).

## After the upgrade: carry the configuration over

Until this runs (or an admin saves `/admin/settings/email`), the deployment sends **no** email: the platform reads
its own `email` row, which does not exist yet.

1. Rehearse on a restored backup first (see [database restore](database-restore.md)).
2. Dry run (prints key paths and last-4 hints, never a secret):

   ```bash
   docker compose ... exec api npm run email:migrate-settings
   ```

   Read the plan: `[settings] would set: provider, enabled, fromAddress, ..., transports.smtp.host, ...` and one
   line per secret (`smtp/default`, `email_ses/default`).
3. Apply:

   ```bash
   docker compose ... exec api npm run email:migrate-settings -- --apply
   ```

4. Verify: open `/admin/settings/email`, check the transport and sender, and press **Send test email**. It goes to
   your own address. The Doctor check `email.config` should pass.

The command is idempotent and set-if-absent, settings and secrets alike: a second run writes nothing, and a value or
secret an admin already saved on the platform page is never overwritten. It needs `SECRETS_ENCRYPTION_KEY` (the key that encrypted the legacy password)
and exits 1, writing nothing, when a legacy secret cannot be decrypted.

A legacy field the platform schema refuses (for example a malformed from address) is reported under
`left out (refused by the platform schema)` and not written; fix it on the page.

## SES: rotate both keys together

The SES transport used to read the S3 storage key pair at send time. The migration copies that pair once (decision 1
of #570), after which the two are independent. When you rotate the AWS key of the S3 provider, also enter the new
access key id and secret under SES on `/admin/settings/email`: the command only fills empty values and never
replaces a stored credential, so re-running it does not pick up a rotated key. The IAM user still needs `ses:SendEmail` and `ses:SendRawEmail`. A non-AWS S3 endpoint
(MinIO, R2) never had working SES keys; choose SMTP instead.

## Environment variables

None is read for runtime email configuration. `AWS_SES_REGION` is only the SES region fallback. `EMAIL_PROVIDER`,
`SMTP_*` and `EMAIL_FROM_*` now seed only the legacy `email.*` block (read-only, kept for rollback) and are removed
from `infra/compose/app.env.example` in the cleanup release, after the migration is verified on every deployment.

## Rollback

Revert the release. The legacy `email.*` keys, the inline-encrypted SMTP password and the S3 credential are left
untouched by the migration, so the previous release reads them as before. The platform `email` row and the two
credentials it wrote are inert for the old code.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No email after the upgrade, Doctor `email.config` fails | The migration has not run | Run it (above) or configure the page |
| Test send: `Email sending is disabled` | `enabled` is false in the `email` row | Turn on sending, save |
| Test send: `No SES region is configured` | No region on the page and no `AWS_SES_REGION` | Set the region on the page |
| Test send: `535 Authentication failed` | SMTP password not carried over or wrong | Re-run the migration dry run (is `smtp/default` listed?) or re-enter the password |
| `CANNOT DECRYPT` in the dry run | `SECRETS_ENCRYPTION_KEY` differs from the one that encrypted the legacy secret | Use the original key |

More: the platform email slice README (`@marinoscar/platform-api/email`), [credentials migration](credentials-migration.md).
