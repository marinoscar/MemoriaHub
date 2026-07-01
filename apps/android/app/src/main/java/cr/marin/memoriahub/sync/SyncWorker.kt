package cr.marin.memoriahub.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import cr.marin.memoriahub.core.storage.AppConfigStore
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Runs a full sync pass (reconcile + process the queue) in the background. Promotes
 * to a foreground service so long uploads survive and show progress. Returns
 * [Result.retry] on failure so WorkManager re-runs with its own backoff — the engine
 * itself never throws away unfinished work (it's all persisted in Room).
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val engine: SyncEngine,
    private val scheduler: SyncScheduler,
    private val notifications: SyncNotifications,
    private val appConfigStore: AppConfigStore,
) : CoroutineWorker(appContext, params) {

    override suspend fun getForegroundInfo(): ForegroundInfo = notifications.foregroundInfo()

    override suspend fun doWork(): Result {
        // Defensive gate: already-enqueued work (e.g. a content-observer trigger) may race
        // the user turning backup off. Bail without foreground promotion and without
        // re-arming the observer.
        if (!appConfigStore.backupEnabled) return Result.success()

        val trigger = inputData.getString(KEY_TRIGGER) ?: TRIGGER_PERIODIC
        // Best-effort promotion to foreground; the run proceeds regardless.
        runCatching { setForeground(getForegroundInfo()) }

        return try {
            engine.runSync(trigger = trigger, fullScan = trigger == TRIGGER_PERIODIC)
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

    companion object {
        const val KEY_TRIGGER = "trigger"
        const val TRIGGER_PERIODIC = "periodic"
        const val TRIGGER_CONTENT = "content"
        const val TRIGGER_MANUAL = "manual"
    }
}
