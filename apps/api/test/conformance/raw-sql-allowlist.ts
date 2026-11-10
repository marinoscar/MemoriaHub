// The files allowed to issue raw SQL ($queryRaw / $executeRaw), each with the reason
// (the `user-owned-data` conformance suite, RETRO-B2 #611). Raw SQL bypasses the
// typed client, so every statement is listed where a reviewer sees it. Paths are
// relative to apps/api/src (or to packages/memoriahub-api/src/{media,tagging,search} for those slices,
// RETRO-J5, RETRO-J7). A new file with raw SQL fails the suite until it is
// added here with a reason; prefer the typed client.
export const RAW_SQL_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'common/tenancy/default-org-id.ts', why: 'Reads the default organization id once (RETRO-A5 shim, removed by RETRO-D1).' },
  { file: 'dedup/duplicate-backfill.service.ts', why: 'pgvector candidate queries scoped by circle id; not user data.' },
  { file: 'dedup/duplicate-detection.service.ts', why: 'pgvector KNN queries scoped by circle id; not user data.' },
  { file: 'dedup/duplicate.service.ts', why: 'pgvector similarity queries scoped by circle id; not user data.' },
  { file: 'dedup/visual-embedding.service.ts', why: 'pgvector column reads and writes (Prisma cannot type vector columns), keyed by media item id.' },
  { file: 'doctor/checks/core/pgvector.doctor-check.ts', why: 'Read-only extension probe.' },
  { file: 'doctor/checks/face/pgvector.doctor-check.ts', why: 'Read-only column and index probe.' },
  { file: 'face/face-matching.service.ts', why: 'pgvector KNN over face embeddings, scoped by circle id.' },
  { file: 'insights/insights.service.ts', why: 'Storage insight aggregates over the whole deployment.' },
  { file: 'legacy/media-shares-import.ts', why: 'Data migration only (RETRO-I4): reads the dropped-from-Prisma media_shares table, finds already-imported link grants by token hash, and re-keys share_expiring stamps; no request input, run by the operator script.' },
  { file: 'location-groups/location-group-rebuild.handler.ts', why: 'Set-based rebuild of the canonical location columns.' },
  { file: 'media/media.service.ts', why: 'Gallery, map-cluster and aggregate queries Prisma cannot express, scoped by circle id.' },
  { file: 'media/thumbnail-repair.handler.ts', why: 'Candidate scan for missing thumbnails.' },
  { file: 'media-sync/media-sync.service.ts', why: 'Run-retention trim keyed by device id (owner-checked first). In the media slice package (packages/memoriahub-api/src/media).' },
  { file: 'memories/curators/circle-month-counts.ts', why: 'Date-bucket aggregates scoped by circle id.' },
  { file: 'memories/curators/on-this-day.curator.ts', why: 'Date-part queries scoped by circle id.' },
  { file: 'memories/curators/person-candidates.ts', why: 'Face aggregates scoped by circle id.' },
  { file: 'memories/curators/theme.curator.ts', why: 'Tag aggregates scoped by circle id.' },
  { file: 'notification-producers/share-expiring.service.ts', why: 'Share-expiry idempotency probe: a JSONB containment over the user\'s own notification rows.' },
  { file: 'platform/onboarding/onboarding-data.adapter.ts', why: "The onboarding activation metrics (RETRO-H3, #599): the platform builds ONE aggregate statement over the registered funnel and milestone expressions and this port runs it in a READ ONLY transaction. Counts only, every value a bound parameter, the expressions developer-authored (refused at registration if they contain a semicolon)." },
  { file: 'platform/sharing/record-access.ts', why: "Grants on media items and albums (RETRO-I3, #573): above 1,000 shared records `accessibleWhere` returns the sharing slice's EXISTS condition (`accessibleSql`, the only sanctioned raw access to `grants`), resolved here to a bounded id list (LIMIT 10,000) inside the caller's org-scoped transaction. The table name is a fixed constant, every value a bound parameter." },
  { file: 'prisma/prisma.service.ts', why: 'Connection bootstrap and health probes.' },
  { file: 'semantic-search.service.ts', why: 'pgvector KNN scoped by circle id. In the search slice package (packages/memoriahub-api/src/search).' },
  { file: 'testing/fake-tagging-db.ts', why: 'In-memory fake of the tagging slice database (packages/memoriahub-api/src/tagging/testing): the raw-SQL members are no-op stubs, no SQL runs.' },
  { file: 'testing/fake-search-db.ts', why: 'In-memory fake of the search slice database (packages/memoriahub-api/src/search/testing): the raw-SQL members are stubs that answer a seeded list, no SQL runs.' },
  { file: 'auto-tagging.service.ts', why: 'pgvector embedding upsert keyed by media item id. In the tagging slice package (packages/memoriahub-api/src/tagging).' },
  { file: 'workflows/runs/workflow-evaluate-item.handler.ts', why: 'Rolling micro-run append with row locks, scoped by workflow id.' },
];
