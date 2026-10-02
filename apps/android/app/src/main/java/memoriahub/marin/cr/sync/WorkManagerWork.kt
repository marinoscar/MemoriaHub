package memoriahub.marin.cr.sync

import android.content.Context
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import memoriahub.marin.cr.diagnostics.AppLog
import java.util.concurrent.TimeUnit

/** [SyncWork] over WorkManager (docs/specs/android-media-sync.md §10.2). */
class WorkManagerWork(context: Context) : SyncWork {
    private val appContext = context.applicationContext
    private val workManager: WorkManager get() = WorkManager.getInstance(appContext)

    override fun enqueueNow(trigger: SyncTrigger, policy: NowPolicy, constraints: SyncConstraintSpec) {
        val builder = OneTimeWorkRequestBuilder<MediaSyncWorker>()
            .setConstraints(constraints.toConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, MediaSyncScheduler.BACKOFF.seconds, TimeUnit.SECONDS)
            .setInputData(workDataOf(MediaSyncWorker.KEY_TRIGGER to trigger.wire))
            .addTag(MediaSyncScheduler.TAG_ALL)
        // Expedited work accepts only network and storage constraints; a charger-bound run is ordinary work.
        if (constraints.expeditable) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        val existing = when (policy) {
            NowPolicy.REPLACE -> ExistingWorkPolicy.REPLACE
            NowPolicy.KEEP -> ExistingWorkPolicy.KEEP
        }
        workManager.enqueueUniqueWork(MediaSyncScheduler.NOW_WORK, existing, builder.build())
        AppLog.i(TAG, "sync.enqueue.now trigger=${trigger.wire} policy=$policy network=${constraints.networkType} charging=${constraints.requiresCharging}")
    }

    override fun enqueuePeriodic(constraints: SyncConstraintSpec, update: Boolean) {
        val request = PeriodicWorkRequestBuilder<MediaSyncWorker>(
            MediaSyncScheduler.PERIODIC_INTERVAL.toMinutes(), TimeUnit.MINUTES,
            MediaSyncScheduler.PERIODIC_FLEX.toMinutes(), TimeUnit.MINUTES,
        )
            .setConstraints(constraints.toConstraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, MediaSyncScheduler.BACKOFF.seconds, TimeUnit.SECONDS)
            .setInputData(workDataOf(MediaSyncWorker.KEY_TRIGGER to SyncTrigger.PERIODIC.wire))
            .addTag(MediaSyncScheduler.TAG_ALL)
            .build()
        val policy = if (update) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP
        workManager.enqueueUniquePeriodicWork(MediaSyncScheduler.PERIODIC_WORK, policy, request)
        if (update) AppLog.i(TAG, "sync.enqueue.periodic policy=UPDATE network=${constraints.networkType} charging=${constraints.requiresCharging}")
    }

    override fun armContentTrigger(replace: Boolean) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(MediaSyncScheduler.TRIGGER_UPDATE_DELAY.seconds, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(MediaSyncScheduler.TRIGGER_MAX_DELAY.seconds, TimeUnit.SECONDS)
            .build()
        val request = OneTimeWorkRequestBuilder<MediaContentTriggerWorker>()
            .setConstraints(constraints)
            .addTag(MediaSyncScheduler.TAG_ALL)
            .build()
        val policy = if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
        workManager.enqueueUniqueWork(MediaSyncScheduler.TRIGGER_WORK, policy, request)
    }

    override fun cancelAll() {
        workManager.cancelUniqueWork(MediaSyncScheduler.NOW_WORK)
        workManager.cancelUniqueWork(MediaSyncScheduler.TRIGGER_WORK)
        workManager.cancelUniqueWork(MediaSyncScheduler.PERIODIC_WORK)
        AppLog.i(TAG, "sync.cancel.all")
    }

    override fun isPeriodicScheduled(): Boolean = isPending(MediaSyncScheduler.PERIODIC_WORK)

    override fun isContentTriggerArmed(): Boolean = isPending(MediaSyncScheduler.TRIGGER_WORK)

    private fun isPending(name: String): Boolean = try {
        workManager.getWorkInfosForUniqueWork(name).get(2, TimeUnit.SECONDS).any { !it.state.isFinished }
    } catch (e: Exception) {
        AppLog.w(TAG, "sync.work.query.failed name=$name", e)
        false
    }

    private companion object {
        const val TAG = "Sync"
    }
}
