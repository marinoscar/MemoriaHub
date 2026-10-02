package memoriahub.marin.cr.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.diagnostics.AppLog

/**
 * Fires when MediaStore's Images or Video collection changes (a new photo or video), after a 15 s
 * quiet period (at most 2 min). It does no uploading itself: it enqueues the "now" work with
 * trigger `content_trigger` and then **re-arms itself**, because content-URI work is one-shot
 * (docs/specs/android-media-sync.md §10.2). The decision is [MediaSyncScheduler.onContentTriggered].
 */
class MediaContentTriggerWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = MobileApplication.from(applicationContext)
        AppLog.i(TAG, "sync.trigger.fired uris=${triggeredContentUris.size} authorities=${triggeredContentAuthorities.size}")
        app.syncScheduler.onContentTriggered()
        return Result.success()
    }

    private companion object {
        const val TAG = "Sync"
    }
}
