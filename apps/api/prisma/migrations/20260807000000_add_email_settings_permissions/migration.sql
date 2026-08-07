-- Issue #293: `email_settings:read` / `email_settings:write` never reached any
-- database that was installed before commit 18811b28 (2026-07-14) added them to
-- prisma/seed.ts.
--
-- Permissions have only ever been created by the seed, and update.sh runs
-- `prisma migrate deploy` WITHOUT the seed, so an already-installed deployment
-- never picked them up. The result in production: an admin opening
-- /admin/settings/email got "Missing permissions: email_settings:read", because
-- email-settings.controller.ts guards its routes on permissions that did not
-- exist as rows.
--
-- This migration backfills the two rows and their admin grants so the fix
-- travels through the normal deploy path. It is idempotent: a freshly seeded
-- database already has both rows and every statement below no-ops.
--
-- Going forward RbacReconcileService (src/common/services/rbac-reconcile.service.ts)
-- reconciles the whole catalog on every API boot, so a future permission does
-- not need a hand-written migration like this one.

INSERT INTO "permissions" ("id", "name", "description")
VALUES
  (
    gen_random_uuid(),
    'email_settings:read',
    'View email provider configuration and test connectivity'
  ),
  (
    gen_random_uuid(),
    'email_settings:write',
    'Configure email provider credentials, set active provider, and send test emails'
  )
ON CONFLICT ("name") DO NOTHING;

-- Grant both to the admin role (the only role they belong to, per the catalog).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" = 'admin'
  AND p."name" IN ('email_settings:read', 'email_settings:write')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
