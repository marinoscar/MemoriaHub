/**
 * Typed errors raised by the database backup engine (issue #341, epic #339).
 *
 * These live in their own module so the HTTP layer added by #343 can map them
 * to status codes (`DatabaseBackupAlreadyRunningError` → 409) without importing
 * the runner service — and, more importantly, without re-deriving the P2002
 * detection at a second site that could drift from the one in the runner.
 */

/**
 * Raised when claiming the single-active-run slot loses to a concurrent start.
 *
 * The claim is an INSERT of a `running` `DatabaseBackupRun`; the partial unique
 * index `database_backup_runs_active_uniq_idx` (#340) — on `(status)` WHERE
 * `status IN ('pending','running')` — makes the second inserter fail with
 * Prisma P2002. That is the app-wide, multi-replica-safe concurrency guard: it
 * is the database, not a process-local flag, that decides who wins.
 *
 * `activeRunId` is the run that already holds the slot, so #343's controller can
 * return it in the 409 body and the UI can link straight to the run in flight.
 * It is nullable because the winning run can legitimately finish (and stop
 * matching the index predicate) between the failed INSERT and the lookup.
 */
export class DatabaseBackupAlreadyRunningError extends Error {
  constructor(readonly activeRunId: string | null) {
    super(
      activeRunId
        ? `A database backup run is already in progress (runId=${activeRunId})`
        : 'A database backup run is already in progress',
    );
    this.name = 'DatabaseBackupAlreadyRunningError';
  }
}
