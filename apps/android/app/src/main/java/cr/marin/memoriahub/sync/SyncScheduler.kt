package cr.marin.memoriahub.sync

import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import cr.marin.memoriahub.core.storage.AppConfigStore
import java.time.Duration
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Schedules the three sync triggers from the plan:
 *  - a ~15 min periodic safety-net (full reconcile),
 *  - a process-independent MediaStore content-URI observer (re-armed after each fire),
 *  - on-demand "sync now".
 *
 * All paths run the same idempotent engine, so overlapping triggers are harmless.
 *
 * Every sync entry point is gated on the backup toggle here — the single choke point —
 * so call sites (app open, boot, folder changes, manual sync) become no-ops when the
 * user has backup turned off.
 */
@Singleton
class SyncScheduler @Inject constructor(
    private val workManager: WorkManager,
    private val appConfigStore: AppConfigStore,
) {
    /** Call on login, app open, and boot. */
    fun ensureScheduled() {
        if (!appConfigStore.backupEnabled) return
        schedulePeriodic()
        armContentObserver()
    }

    fun syncNow() {
        if (!appConfigStore.backupEnabled) return
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(networkConstraints())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to SyncWorker.TRIGGER_MANUAL))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, MIN_BACKOFF, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniqueWork(WORK_SYNC_NOW, ExistingWorkPolicy.REPLACE, request)
    }

    /** (Re)arms the content-observer one-shot so future MediaStore changes wake a sync. */
    fun armContentObserver() {
        if (!appConfigStore.backupEnabled) return
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(Duration.ofSeconds(CONTENT_DELAY_SECONDS))
            .setTriggerContentMaxDelay(Duration.ofSeconds(CONTENT_MAX_DELAY_SECONDS))
            .build()
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints)
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to SyncWorker.TRIGGER_CONTENT))
            .build()
        workManager.enqueueUniqueWork(WORK_CONTENT_OBSERVER, ExistingWorkPolicy.REPLACE, request)
    }

    /** Cancels sync work only — used when the user turns backup off. */
    fun cancelSyncWork() {
        workManager.cancelUniqueWork(WORK_PERIODIC)
        workManager.cancelUniqueWork(WORK_CONTENT_OBSERVER)
        workManager.cancelUniqueWork(WORK_SYNC_NOW)
    }

    /** Cancels everything this app schedules — used on logout. */
    fun cancelAll() {
        cancelSyncWork()
        workManager.cancelUniqueWork(WORK_REMINDER)
    }

    /**
     * Keeps the daily backup-off reminder check scheduled. Deliberately NOT gated on the
     * backup toggle — the reminder is what nudges users back after they turn backup off.
     * Call whenever the user is logged in (app open, boot).
     */
    fun ensureReminderScheduled() {
        val request = PeriodicWorkRequestBuilder<BackupReminderWorker>(Duration.ofHours(REMINDER_HOURS))
            .build()
        workManager.enqueueUniquePeriodicWork(WORK_REMINDER, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    private fun schedulePeriodic() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(Duration.ofMinutes(PERIODIC_MINUTES))
            .setConstraints(networkConstraints())
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to SyncWorker.TRIGGER_PERIODIC))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, MIN_BACKOFF, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniquePeriodicWork(WORK_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    private fun networkConstraints() = Constraints.Builder()
        // Any connection — wifi + cellular for the MVP (selectable policy is deferred).
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    private companion object {
        const val WORK_PERIODIC = "memoriahub-periodic-sync"
        const val WORK_CONTENT_OBSERVER = "memoriahub-content-observer"
        const val WORK_SYNC_NOW = "memoriahub-sync-now"
        const val WORK_REMINDER = "memoriahub-backup-reminder"
        const val PERIODIC_MINUTES = 15L
        const val REMINDER_HOURS = 24L
        const val MIN_BACKOFF = 30L
        const val CONTENT_DELAY_SECONDS = 5L
        const val CONTENT_MAX_DELAY_SECONDS = 30L
    }
}
