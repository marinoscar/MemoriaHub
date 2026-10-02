package memoriahub.marin.cr.sync

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.diagnostics.AppLog

/**
 * One background sync run (docs/specs/android-media-sync.md §10.3). The orchestration lives in
 * [SyncRunner]; this class adds what only WorkManager can: the trigger from the input data, the
 * foreground service with the "Upload progress" notification, the stop reason (Android 15
 * `dataSync` timeout → `partial` + `FGS_TIMEOUT`) and the result mapping (retry while
 * `runAttemptCount < 4`).
 */
class MediaSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    @Volatile private var promoted = false

    override suspend fun doWork(): Result {
        val app = MobileApplication.from(applicationContext)
        val trigger = SyncTrigger.fromWire(inputData.getString(KEY_TRIGGER)) ?: SyncTrigger.MANUAL
        AppLog.i(TAG, "sync.worker.start trigger=${trigger.wire} attempt=${runAttemptCount + 1}")
        val store = app.syncState
        val outcome = try {
            coroutineScope {
                val notifications = launch {
                    app.syncStatus.status.collect { if (promoted) SyncNotifications.updateProgress(applicationContext, it) }
                }
                try {
                    app.newSyncRunner().run(
                        requested = trigger,
                        stop = { if (isStopped) StopReasons.classify(stopReason, effectivePaused(store)) else null },
                        promote = { promote() },
                    )
                } finally {
                    notifications.cancel()
                }
            }
        } finally {
            if (promoted) NotificationManagerCompat.from(applicationContext).cancel(SyncNotifications.PROGRESS_ID)
            if (isStopped) AppLog.w(TAG, "sync.worker.stopped reason=${StopReasons.describe(stopReason)}")
        }
        // TODO(#514): AutoDiagnostics.afterRun(outcome) — uploads a report when a run failed (throttled).
        val result = outcome.toWorkResult(runAttemptCount)
        AppLog.i(TAG, "sync.worker.end outcome=${outcome.kind} result=$result")
        return when (result) {
            WorkResult.SUCCESS -> Result.success()
            WorkResult.RETRY -> Result.retry()
            WorkResult.FAILURE -> Result.failure()
        }
    }

    /** Called by the runner when there is real work (>1 file or >50 MB). A refusal is not fatal (D23). */
    private suspend fun promote() {
        try {
            setForeground(foregroundInfo())
            promoted = true
            AppLog.i(TAG, "sync.foreground.started")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+), IllegalStateException…
            AppLog.w(TAG, "sync.foreground.denied ${e.javaClass.simpleName}")
        }
    }

    /** Also used by WorkManager for expedited work below Android 12 (it runs as a foreground service there). */
    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo()

    private fun foregroundInfo(): ForegroundInfo {
        val app = MobileApplication.from(applicationContext)
        val notification = SyncNotifications.progressNotification(applicationContext, app.syncStatus.status.value)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(SyncNotifications.PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(SyncNotifications.PROGRESS_ID, notification)
        }
    }

    companion object {
        private const val TAG = "Sync"
        const val KEY_TRIGGER = "trigger"
    }
}
