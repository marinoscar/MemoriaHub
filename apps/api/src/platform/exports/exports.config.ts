import { Prisma } from '@prisma/client';
import { APP_SLUG } from '@app/shared';
import { ExportsModule } from '@marinoscar/platform-api/exports';

import { registerMemoriaHubExportSources } from '../../app-registrations/exports';
import { ExportsHostModule } from './exports-host.module';

// =============================================================================
// The platform's exports slice (RETRO-H2, #596)
// =============================================================================
//
// `GET /api/exports/sources`, `POST /api/exports`, `GET /api/exports` and `GET /api/exports/:id`
// (every route `@Auth()`; the PERMISSION is the source's, checked by the service), the
// `export.run` and `export.purge` job types (server-only, PERMANENT strings) and the daily
// expiry cron (which only enqueues). Files go under the slice's own key prefixes
// (`exports/users/...`, `exports/orgs/...`, registered by `forRoot`), downloads are signed URLs
// valid `downloadUrlTtlSeconds`, files are deleted after `retentionDays`.
//
// SOURCES, in dialog order:
//   user-data            the platform's: the caller's own rows of every user-owned model the
//                        registry (`app-registrations/user-owned-models.ts`) marks
//                        `export: 'include'`. Media, albums, tags, people and circles are
//                        `exclude` there (shared circle content); faces and the embedding
//                        tables have no user key, so they are never in the registry at all.
//   org-data             the platform's (`org_members:read`): the active organization's rows.
//   memoriahub-media, memoriahub-albums, memoriahub-memories, memoriahub-people
//                        MemoriaHub's (`memoriahub-export.sources.ts`, `media:read`).
//
// `datamodel` is the generated client's runtime datamodel; it omits `Unsupported` columns (the
// embedding vectors), which therefore never export. The app sources are registered AFTER
// `forRoot`, so `user-data` stays the first (default) source in the dialog, and before the
// application is created (the registry freezes at bootstrap).
//
// Ports: `ExportsHostModule` (bypass client, notifier, and the storage shim until RETRO-D1).
// =============================================================================

/** Days an export file is kept. */
export const EXPORT_RETENTION_DAYS = 7;
/** Lifetime of a signed download URL. */
export const EXPORT_DOWNLOAD_URL_TTL_SECONDS = 300;

export const exportsModule = ExportsModule.forRoot({
  imports: [ExportsHostModule],
  datamodel: Prisma.dmmf.datamodel,
  appSlug: APP_SLUG,
  retentionDays: EXPORT_RETENTION_DAYS,
  downloadUrlTtlSeconds: EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  maxInFlightPerSubject: 3,
  pageSize: 500,
  platformSources: { userData: true, orgData: true },
});

registerMemoriaHubExportSources();
