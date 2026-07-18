-- Assigned-set partial HNSW index for face person-match KNN (issue #133).
--
-- PROBLEM: the pgvector person-match KNN candidate query (see
-- FACE_MATCH_KNN_CANDIDATES / EnrichmentClaimService's face matching path)
-- only ever cares about faces that already belong to a Person
-- (person_id IS NOT NULL) — that's the reference set a newly-detected face
-- is compared against. After a bulk import, the vast majority of rows in
-- `faces` are UNASSIGNED (person_id IS NULL, freshly detected, not yet
-- clustered/labeled). The existing general-purpose HNSW index
-- (`faces_embedding_vec_hnsw_idx`, added in migration
-- 20260715000000_add_face_embedding_vector) covers the whole table, so its
-- graph is dominated by unassigned rows that a person-match query will never
-- want — the KNN walk wastes candidate slots on vectors it always discards,
-- degrading recall/latency for the one query this index exists to serve.
--
-- FIX: mirror the existing archive-matching partial index pattern (see step
-- 7 of 20260715000000_add_face_embedding_vector/migration.sql, which scopes
-- to the UNASSIGNED+archived pool for a different query shape) with a
-- partial index scoped the other way — to the ASSIGNED set
-- (person_id IS NOT NULL) — so Postgres can pick a much smaller, faster
-- index purpose-built for person-match KNN instead of scanning/filtering
-- the full-table index. Same vector_cosine_ops operator class and
-- m/ef_construction values as every other HNSW index in this codebase
-- (faces_embedding_vec_hnsw_idx, faces_embedding_vec_archive_hnsw_idx,
-- media_visual_embedding, media_item_embedding).
--
-- GUC: SET max_parallel_maintenance_workers = 0 is a plain session-level
-- setting — safe to run inside Prisma's migration transaction (unlike
-- CREATE INDEX CONCURRENTLY, which cannot run inside a transaction block at
-- all, which is why this repo deliberately does not use it for hand-authored
-- index migrations). Disabling parallel maintenance workers keeps HNSW
-- index-build memory usage bounded to a single worker, avoiding a burst of
-- parallel maintenance_work_mem allocations on memory-constrained VPS
-- deployments during migration apply.
SET max_parallel_maintenance_workers = 0;

CREATE INDEX "faces_embedding_vec_assigned_hnsw_idx"
  ON "faces" USING hnsw ("embedding_vec" vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE "person_id" IS NOT NULL AND "embedding_vec" IS NOT NULL;
