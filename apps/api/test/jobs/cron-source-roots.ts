// =============================================================================
// The source roots the `cron-enqueue-only` and `on-event-no-io` scans read
// (RETRO-C9, #612)
// =============================================================================
//
// EAB keeps this list in `apps/api/test/jobs/cron-source-roots.ts` too: the
// app's own source tree plus the platform slice roots it mounts, so the three
// permanent platform exemptions (`jobs/tasks/job-stuck-reset.task.ts`,
// `jobs/tasks/temp-file-janitor.task.ts`, `nodes/tasks/node-secret-sweep.task.ts`)
// are pinned to their slice roots.
//
// MemoriaHub consumes the PUBLISHED `@marinoscar/platform-api`, which ships only
// `dist/` (`.js` and `.d.ts`). The scans read `.ts` sources, and a `.d.ts` has
// no `@Cron` body, so no installed slice root can be scanned and the three
// platform exemptions cannot be pinned (an exemption whose file is not scanned
// fails its own "on the record" case). The platform's crons are scanned by the
// platform's own CI; this app scans its own tree. Same seam gap as the
// telemetry conformance check 5 (docs/platform-adoption/local-exceptions.md).
// =============================================================================

import { join } from 'node:path';

/** `apps/api/src`: every `@Cron` and `@OnEvent` this app declares. */
export const API_SOURCE_ROOT = join(__dirname, '..', '..', 'src');

/**
 * The media slice of `@marinoscar/memoriahub-api` (RETRO-J5, #613): the workspace package ships
 * `.ts` sources, so its crons and event listeners are scanned like the app's own. Paths in the
 * findings and in the raw-SQL allowlist are relative to this root (`media-sync/media-sync.service.ts`).
 */
export const MEDIA_SLICE_SOURCE_ROOT = join(__dirname, '..', '..', '..', '..', 'packages', 'memoriahub-api', 'src', 'media');

/**
 * The package's domain slices moved by RETRO-J10 (#624) (insights, location, dedup, burst, social,
 * enhancement): each root is scanned like the app's own tree and its raw-SQL allowlist paths are
 * relative to it.
 */
const SLICES_ROOT = join(__dirname, '..', '..', '..', '..', 'packages', 'memoriahub-api', 'src');
export const J10_SLICE_SOURCE_ROOTS: readonly string[] = ['insights'].map((slice) => join(SLICES_ROOT, slice));

/** Every root the two scans read. */
export const CRON_SOURCE_ROOTS: readonly string[] = [API_SOURCE_ROOT, MEDIA_SLICE_SOURCE_ROOT, ...J10_SLICE_SOURCE_ROOTS];
