package cr.marin.memoriahub.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import cr.marin.memoriahub.core.auth.TokenStore
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.core.util.TimeProvider
import cr.marin.memoriahub.data.repo.SyncRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Runs a full sync pass (reconcile + process the queue) in the background. Promotes
 * to a foreground service only when there are uploads to keep alive — the common
 * nothing-new run stays plain background work (no FGS start, no notification).
 * Returns [Result.retry] on failure so WorkManager re-runs with its own backoff —
 * the engine itself never throws away unfinished work (it's all persisted in Room).
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val engine: SyncEngine,
    private val scheduler: SyncScheduler,
    private val notifications: SyncNotifications,
    private val appConfigStore: AppConfigStore,
    private val syncRepository: SyncRepository,
    private val time: TimeProvider,
    private val tokenStore: TokenStore,
) : CoroutineWorker(appContext, params) {

    // Required even with conditional promotion below: expedited work (WORK_SYNC_NOW)
    // on API < 31 runs as a foreground service and needs this to exist.
    override suspend fun getForegroundInfo(): ForegroundInfo = notifications.foregroundInfo()

    override suspend fun doWork(): Result {
        // Defensive gates: already-enqueued work (e.g. a content-observer trigger) may
        // race the user turning backup off; and a logged-out session (expired/revoked)
        // must stop sync cleanly instead of 401-ing every upload into BLOCKED rows and
        // false "Backup issues" alerts — the sign-in notification owns that story.
        if (!appConfigStore.backupEnabled || !tokenStore.isLoggedIn) return Result.success()

        val trigger = inputData.getString(KEY_TRIGGER) ?: TRIGGER_PERIODIC

        return try {
            // Phase 1 (discovery) is cheap local work — no foreground needed. Only
            // promote (best-effort) when there are actual uploads to keep alive, so
            // the common nothing-new periodic run starts no FGS and shows nothing.
            engine.prepare()
            if (ForegroundPolicy.shouldPromote(syncRepository.pendingWorkCount())) {
                runCatching { setForeground(getForegroundInfo()) }
            }
            val summary = engine.processQueue(trigger)
            // Notification concerns stay out of the engine: alert here when the run
            // just failed items, clear the alert once everything recovered.
            runCatching { notifyIssuesAfterRun(justFailed = summary.failed) }
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        } finally {
            // Keep observing future MediaStore changes after a content-triggered run.
            if (trigger == TRIGGER_CONTENT) {
                runCatching { scheduler.armContentObserver() }
            }
        }
    }

    private suspend fun notifyIssuesAfterRun(justFailed: Int) {
        val failureCount = syncRepository.failureCount()
        if (failureCount == 0) {
            // Everything recovered (e.g. a retry drained the failures): clear stale alerts.
            notifications.cancelIssues()
            return
        }
        // Only alert when this run failed items — old BLOCKED rows alone shouldn't
        // re-nag every 15 minutes; the cooldown covers repeated failing runs.
        if (justFailed == 0) return
        val now = time.nowMillis()
        val shouldNotify = IssueNotificationPolicy.shouldNotify(
            issuesEnabled = appConfigStore.notifyBackupIssues,
            failureCount = failureCount,
            lastNotifiedAtMs = appConfigStore.lastIssueNotifiedAtMs,
            nowMs = now,
        )
        if (shouldNotify) {
            notifications.showIssues(failureCount)
            appConfigStore.lastIssueNotifiedAtMs = now
        }
    }

    companion object {
        const val KEY_TRIGGER = "trigger"
        const val TRIGGER_PERIODIC = "periodic"
        const val TRIGGER_CONTENT = "content"
        const val TRIGGER_MANUAL = "manual"
    }
}
