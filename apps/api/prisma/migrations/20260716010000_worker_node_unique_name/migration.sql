-- Idempotent worker-node registration (issue #108, Phase 2): enforce one node
-- row per (created_by_id, name) so a restarting containerized replica
-- re-attaches to its existing record instead of minting a duplicate.

-- Pre-dedupe NON-destructively so the unique index can build. For each
-- (created_by_id, name) group, keep the row with the freshest heartbeat
-- (NULL heartbeats sort last) and rename the rest by suffixing the first 8
-- chars of their id. Rows are never deleted here —
-- enrichment_jobs.claimed_by_node_id FKs may still reference them; the stale
-- renamed rows are cleaned up later by the offline-node retention pruner.
UPDATE "worker_nodes"
SET "name" = "name" || '-' || left("id"::text, 8)
WHERE "id" NOT IN (
    SELECT DISTINCT ON ("created_by_id", "name") "id"
    FROM "worker_nodes"
    ORDER BY "created_by_id", "name", "last_heartbeat_at" DESC NULLS LAST
);

-- CreateIndex
CREATE UNIQUE INDEX "worker_nodes_created_by_id_name_key" ON "worker_nodes"("created_by_id", "name");
