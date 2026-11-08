// The files allowed to issue raw SQL ($queryRaw / $executeRaw), each with the reason
// (the `user-owned-data` conformance suite, RETRO-B2 #611). Raw SQL bypasses the
// typed client, so every statement is listed where a reviewer sees it. Paths are
// relative to apps/api/src. A new file with raw SQL fails the suite until it is
// added here with a reason; prefer the typed client.
export const RAW_SQL_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'circles/identity-listeners.ts', why: "Per-user transaction advisory lock (pg_advisory_xact_lock) serialising the personal-circle create and the invite claim; the key is the event's user id." },
  { file: 'common/tenancy/default-org-id.ts', why: 'Reads the default organization id once (RETRO-A5 shim, removed by RETRO-D1).' },
  { file: 'dedup/duplicate-backfill.service.ts', why: 'pgvector candidate queries scoped by circle id; not user data.' },
  { file: 'dedup/duplicate-detection.service.ts', why: 'pgvector KNN queries scoped by circle id; not user data.' },
  { file: 'dedup/duplicate.service.ts', why: 'pgvector similarity queries scoped by circle id; not user data.' },
  { file: 'dedup/visual-embedding.service.ts', why: 'pgvector column reads and writes (Prisma cannot type vector columns), keyed by media item id.' },
  { file: 'doctor/checks/core/pgvector.doctor-check.ts', why: 'Read-only extension probe.' },
  { file: 'doctor/checks/face/pgvector.doctor-check.ts', why: 'Read-only column and index probe.' },
  { file: 'email/email-smtp-secret.store.ts', why: "One jsonb_set on the singleton `global` system_settings row that writes the SMTP ciphertext without clobbering the rest of the document (RETRO-B3 shim, removed by RETRO-D2); the actor id is the authenticated admin." },
  { file: 'face/face-matching.service.ts', why: 'pgvector KNN over face embeddings, scoped by circle id.' },
  { file: 'insights/insights.service.ts', why: 'Storage insight aggregates over the whole deployment.' },
  { file: 'location-groups/location-group-rebuild.handler.ts', why: 'Set-based rebuild of the canonical location columns.' },
  { file: 'media/media.service.ts', why: 'Gallery, map-cluster and aggregate queries Prisma cannot express, scoped by circle id.' },
  { file: 'media/thumbnail-repair.handler.ts', why: 'Candidate scan for missing thumbnails.' },
  { file: 'media-sync/media-sync.service.ts', why: 'Run-retention trim keyed by device id (owner-checked first).' },
  { file: 'memories/curators/circle-month-counts.ts', why: 'Date-bucket aggregates scoped by circle id.' },
  { file: 'memories/curators/on-this-day.curator.ts', why: 'Date-part queries scoped by circle id.' },
  { file: 'memories/curators/person-candidates.ts', why: 'Face aggregates scoped by circle id.' },
  { file: 'memories/curators/theme.curator.ts', why: 'Tag aggregates scoped by circle id.' },
  { file: 'notifications/notifications.service.ts', why: "Counted-event advisory lock and the read-all JSONB snapshot update, both keyed by the caller's user id." },
  { file: 'notifications/producers/share-expiring.service.ts', why: 'Expiry sweep over shares.' },
  { file: 'platform/db-backup/db-backup-system-data.adapter.ts', why: "The first statement of the db-backup slice's system transaction: set_config('app.rls_bypass', 'on', true) for the read-only backup.rls-bypass Doctor count; no ids (RETRO-D4 shim, replaced by PrismaSystemService.runAsSystem in RETRO-D1)." },
  { file: 'platform/settings/settings-data.adapter.ts', why: "The first statement of an org-scoped transaction: set_config('app.org_id'/'app.user_id', ..., true) for the settings slice's SETTINGS_DATA port (RETRO-B3 shim, replaced by PrismaService.runInOrg in RETRO-D1)." },
  { file: 'prisma/prisma.service.ts', why: 'Connection bootstrap and health probes.' },
  { file: 'search/semantic-search.service.ts', why: 'pgvector KNN scoped by circle id.' },
  { file: 'storage-settings/storage-settings.service.ts', why: 'Provider credential row maintenance.' },
  { file: 'tagging/auto-tagging.service.ts', why: 'pgvector embedding upsert keyed by media item id.' },
  { file: 'workflows/runs/workflow-evaluate-item.handler.ts', why: 'Rolling micro-run append with row locks, scoped by workflow id.' },
];
