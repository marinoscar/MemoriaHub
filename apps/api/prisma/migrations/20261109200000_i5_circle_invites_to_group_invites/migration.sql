-- =============================================================================
-- RETRO-I5 (#583): pending circle invites become platform group invites.
-- =============================================================================
--
-- Every UNCLAIMED `circle_invites` row of a shared circle becomes a PENDING
-- `group_invites` row of the circle's group (a shared circle's id IS its group's
-- id, RETRO-I2), then `circle_invites` is dropped. The data move and the drop are
-- one transaction, so no pending invite can be lost between them:
--
--   id             the circle invite's id (traceable; makes a replay a no-op)
--   group_id       circle_id
--   org_id         the group's organization (the default one)
--   email          lower-cased, trimmed
--   role           circle_admin -> admin, collaborator -> editor, viewer -> viewer
--   invited_by_id  added_by_id
--   created_at     added_at
--   expires_at     NULL (MemoriaHub invites never expired; groups.inviteTtlDays: null)
--
-- SKIPPED (counted in a NOTICE, never an error):
--   - claimed invites (claimed_at set): their member rows exist;
--   - invites of a PERSONAL circle (no group; none should exist, the app refused them);
--   - invites whose address already belongs to a member of the group with a role
--     at least the invite's (accepting would change nothing). An invite that
--     OUTRANKS the member's role IS imported: the next sign-in upgrades the member
--     (groups.inviteRoleMerge 'upgrade-only', the former claim's never-downgrade rule);
--   - an address that already has a pending invite to the group.
--
-- The invitees are claimed by the sharing slice's own listener at sign-up and at
-- every sign-in (groups.autoAcceptInvitesOnSignup / OnSignIn, RETRO-SEAM-INVITE-
-- AUTOCLAIM, EAB #1078), or accepted from GET /api/groups/invites/mine.
--
-- SQL, not the slice's service: the slice has no import path for pre-existing
-- invites (GroupInvitesService.create would re-send every invitation e-mail and
-- re-date the invite), and RETRO-I2 wrote groups and group_members the same way.
-- `circles`, `circle_members` and the `CircleRole` enum stay until RETRO-I6: every
-- content table still carries `circle_id` (FK to circles).
--
-- RE-RUNNABLE: guarded by to_regclass, ON CONFLICT DO NOTHING and DROP IF EXISTS.
-- One transaction under app.rls_bypass: group_invites forces row-level security.
-- Rehearsal counts: docs/runbooks/circles-to-groups.md, "Circle invites to group invites".
-- =============================================================================

BEGIN;
SELECT set_config('app.rls_bypass', 'on', true);

DO $$
DECLARE
  total integer;
  claimed integer;
  personal integer;
  member_already integer;
  imported integer;
BEGIN
  IF to_regclass('public.circle_invites') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE claimed_at IS NOT NULL) INTO total, claimed FROM circle_invites;
  SELECT count(*) INTO personal
  FROM circle_invites ci JOIN circles c ON c.id = ci.circle_id
  WHERE ci.claimed_at IS NULL AND (c.is_personal OR NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = ci.circle_id));
  SELECT count(*) INTO member_already
  FROM circle_invites ci
  JOIN groups g ON g.id = ci.circle_id
  JOIN users u ON lower(u.email) = lower(trim(ci.email))
  JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = u.id
  WHERE ci.claimed_at IS NULL
    AND (CASE gm.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
        >= (CASE ci.role::text WHEN 'circle_admin' THEN 3 WHEN 'collaborator' THEN 2 ELSE 1 END);

  INSERT INTO group_invites (id, group_id, org_id, email, role, invited_by_id, expires_at, created_at)
  SELECT ci.id,
         g.id,
         g.org_id,
         lower(trim(ci.email)),
         CASE ci.role::text WHEN 'circle_admin' THEN 'admin' WHEN 'collaborator' THEN 'editor' ELSE 'viewer' END,
         ci.added_by_id,
         NULL,
         ci.added_at
  FROM circle_invites ci
  JOIN circles c ON c.id = ci.circle_id AND NOT c.is_personal
  JOIN groups g ON g.id = ci.circle_id
  WHERE ci.claimed_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = g.id
        AND lower(u.email) = lower(trim(ci.email))
        AND (CASE gm.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
            >= (CASE ci.role::text WHEN 'circle_admin' THEN 3 WHEN 'collaborator' THEN 2 ELSE 1 END)
    )
    AND NOT EXISTS (
      SELECT 1 FROM group_invites gi
      WHERE gi.group_id = g.id AND gi.email = lower(trim(ci.email))
        AND gi.accepted_at IS NULL AND gi.declined_at IS NULL AND gi.revoked_at IS NULL
    )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS imported = ROW_COUNT;

  RAISE NOTICE 'RETRO-I5: circle_invites % (claimed % dropped; personal-circle % skipped; already a member % skipped); imported % pending group invite(s)',
    total, claimed, personal, member_already, imported;
END $$;

DROP TABLE IF EXISTS "circle_invites";

COMMIT;
