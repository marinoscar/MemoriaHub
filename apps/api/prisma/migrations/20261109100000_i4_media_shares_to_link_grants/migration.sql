-- =============================================================================
-- RETRO-I4 (#578): public shares are platform link grants. CONTRACT step.
-- =============================================================================
--
-- `media_shares` rows are imported as `grants` rows (grantee_kind 'link', role
-- 'viewer', token stored as `lnk_<old token>`: SHA-256 hash plus ciphertext under
-- SECRETS_ENCRYPTION_KEY) by `npm run sharing:import-media-shares --workspace=api
-- -- --apply` (scripts/import-media-shares.ts, through the platform's
-- importLegacyToken, which is TypeScript, not SQL). This migration then drops the
-- table, its enum and the two retired permissions.
--
-- RELEASE ORDER (docs/runbooks/circles-to-groups.md, "Public shares to link grants"):
--   1. deploy the code (it no longer reads media_shares);
--   2. run the import (dry run, then --apply);
--   3. apply this migration (npm run prisma:migrate).
--
-- GUARD: the migration REFUSES to run while a media_shares row has no link grant
-- with the matching token hash, so applying it before the import fails loudly
-- instead of destroying every public link. An empty or absent table passes.
--
-- RE-RUNNABLE: every statement is guarded (IF EXISTS).
-- =============================================================================

BEGIN;
SELECT set_config('app.rls_bypass', 'on', true);

DO $$
DECLARE
  missing integer;
BEGIN
  IF to_regclass('public.media_shares') IS NOT NULL THEN
    SELECT count(*) INTO missing
    FROM media_shares m
    WHERE NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.grantee_kind = 'link'
        AND g.link_token_hash = encode(sha256(convert_to('lnk_' || m.token, 'UTF8')), 'hex')
    );
    IF missing > 0 THEN
      RAISE EXCEPTION 'RETRO-I4: % media_shares row(s) are not imported as link grants yet. Run `npm run sharing:import-media-shares --workspace=api -- --apply` first (docs/runbooks/circles-to-groups.md).', missing;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS "media_shares";
DROP TYPE IF EXISTS "ShareTargetType";

-- shares:manage -> sharing:write, shares:manage_any -> sharing:admin (role_permissions cascade).
DELETE FROM "permissions" WHERE "name" IN ('shares:manage', 'shares:manage_any');

COMMIT;
