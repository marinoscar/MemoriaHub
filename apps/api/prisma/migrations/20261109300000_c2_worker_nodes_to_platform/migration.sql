-- RETRO-C2 (issue #581): the worker-node fleet moves onto the platform nodes slice
-- (@marinoscar/platform-api/nodes). The platform tables `worker_nodes` and `node_credentials` were
-- created empty by platform migrations 0003-0040 beside MemoriaHub's own, which RETRO-A5 renamed to
-- `mh_legacy_worker_nodes` / `mh_legacy_node_credentials`.
--
-- In one transaction:
--
--   1. Copies every `mh_legacy_worker_nodes` row into `worker_nodes`, keeping its uuid
--      (`node_backup_configs` / `node_backup_runs` and the CLI's stored node id depend on it).
--      A node that was `online` or `draining` becomes `offline`: it spoke the retired control-plane
--      protocol, so it must re-register (re-attach by owner and name keeps the same row) before it
--      can claim. `disabled` stays disabled.
--   2. Copies every `mh_legacy_node_credentials` row into `node_credentials`, unchanged (same
--      `nod_` prefix, same sha256 hex of the raw token): a node keeps authenticating with the token
--      it was enrolled with, no re-enrolment.
--   3. Re-points the two Local Media Backup foreign keys from the legacy table to `worker_nodes`
--      (ON DELETE CASCADE, as before).
--   4. Drops the two legacy tables and the `MhLegacyNodeStatus` enum. The drops have no CASCADE: a
--      foreign key this migration did not account for makes it fail and roll back.
--
-- The count check aborts (rolling everything back) if a row went missing. Never edit this file once
-- committed: platform.lock records it, and comments count.

BEGIN;

SELECT set_config('app.rls_bypass', 'on', true);

-- 1. worker_nodes
INSERT INTO "worker_nodes" (
  "id", "name", "hostname", "platform", "cli_version", "eligible_types", "concurrency",
  "status", "capabilities", "registered_at", "last_heartbeat_at", "created_by_id"
)
SELECT
  l."id", l."name", l."hostname", l."platform", l."cli_version", l."eligible_types", l."concurrency",
  (CASE WHEN l."status"::text IN ('online', 'draining') THEN 'offline' ELSE l."status"::text END)::"NodeStatus",
  l."capabilities", l."registered_at", l."last_heartbeat_at", l."created_by_id"
FROM "mh_legacy_worker_nodes" l;

-- 2. node_credentials
INSERT INTO "node_credentials" (
  "id", "user_id", "name", "token_hash", "token_prefix", "expires_at", "last_used_at", "created_at", "revoked_at"
)
SELECT
  l."id", l."user_id", l."name", l."token_hash", l."token_prefix", l."expires_at", l."last_used_at",
  l."created_at", l."revoked_at"
FROM "mh_legacy_node_credentials" l;

-- 3. Local Media Backup follows the platform table.
ALTER TABLE "node_backup_configs" DROP CONSTRAINT "node_backup_configs_node_id_fkey";
ALTER TABLE "node_backup_runs" DROP CONSTRAINT "node_backup_runs_node_id_fkey";
ALTER TABLE "node_backup_configs"
  ADD CONSTRAINT "node_backup_configs_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "worker_nodes"("id") ON DELETE CASCADE;
ALTER TABLE "node_backup_runs"
  ADD CONSTRAINT "node_backup_runs_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "worker_nodes"("id") ON DELETE CASCADE;

-- Nothing may be lost: every legacy row has its twin, and every backup row still resolves.
DO $$
DECLARE
  nodes_missing integer;
  credentials_missing integer;
BEGIN
  SELECT count(*) INTO nodes_missing
    FROM "mh_legacy_worker_nodes" l
   WHERE NOT EXISTS (SELECT 1 FROM "worker_nodes" w WHERE w."id" = l."id");
  SELECT count(*) INTO credentials_missing
    FROM "mh_legacy_node_credentials" l
   WHERE NOT EXISTS (
     SELECT 1 FROM "node_credentials" c WHERE c."id" = l."id" AND c."token_hash" = l."token_hash"
   );
  IF nodes_missing > 0 OR credentials_missing > 0 THEN
    RAISE EXCEPTION 'RETRO-C2: % worker node(s) and % node credential(s) were not copied', nodes_missing, credentials_missing;
  END IF;
END $$;

-- 4. Retire the legacy tables.
DROP TABLE "mh_legacy_node_credentials";
DROP TABLE "mh_legacy_worker_nodes";
DROP TYPE "MhLegacyNodeStatus";

COMMIT;
