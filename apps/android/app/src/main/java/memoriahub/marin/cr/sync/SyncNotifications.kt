package memoriahub.marin.cr.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import memoriahub.marin.cr.R
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.deeplink.MediaSyncPath
import memoriahub.marin.cr.notifications.MediaSyncNotifications

/**
 * Background-sync notifications (docs/specs/android-media-sync.md §12.5):
 *
 * - "Upload progress" channel (low importance): the foreground-service notification of a long
 *   upload, "Uploading 3 of 120 · IMG_1234.jpg · 45%", with a **Pause** action.
 * - "Sync issues" channel (shared with pairing, #509): "Allow access to photos" when the media
 *   permission is denied at run start (the runner throttles it to once per 24 h).
 * - A low-importance summary after a background run that uploaded something.
 */
object SyncNotifications {
    const val CHANNEL_PROGRESS = "media_sync_progress"
    const val PROGRESS_ID = 5121
    const val PERMISSION_ID = 5122
    const val SUMMARY_ID = 5123

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, "Upload progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while photos and videos are being backed up."
                setShowBadge(false)
            },
        )
        MediaSyncNotifications.ensureChannels(context)
    }

    /** "Uploading 3 of 120 · IMG_1234.jpg · 45%" (pure, JVM-tested). */
    fun progressText(status: SyncStatusView): String {
        if (status.currentFile == null) return "Preparing…"
        val total = status.filesTotal.coerceAtLeast(status.filesDone + 1)
        val index = (status.filesDone + 1).coerceAtMost(total)
        val percent = if (status.bytesTotal > 0) ((status.bytesSent * 100) / status.bytesTotal).coerceIn(0, 100) else 0
        return "Uploading $index of $total · ${status.currentFile} · $percent%"
    }

    fun progressNotification(context: Context, status: SyncStatusView): Notification {
        ensureChannel(context)
        val percent = if (status.bytesTotal > 0) ((status.bytesSent * 100) / status.bytesTotal).toInt().coerceIn(0, 100) else 0
        return NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Backing up photos and videos")
            .setContentText(progressText(status))
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setProgress(100, percent, status.currentFile == null)
            .setContentIntent(MediaSyncNotifications.openMediaSync(context, MediaSyncPath.HUB))
            .addAction(0, "Pause", pauseIntent(context))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun updateProgress(context: Context, status: SyncStatusView) {
        if (!MediaSyncNotifications.canNotify(context)) return
        try {
            NotificationManagerCompat.from(context).notify(PROGRESS_ID, progressNotification(context, status))
        } catch (_: SecurityException) {
            // Notification permission revoked mid-run; the upload continues.
        }
    }

    fun notifyPermissionMissing(context: Context) {
        MediaSyncNotifications.ensureChannels(context)
        if (!MediaSyncNotifications.canNotify(context)) return
        val text = "Media sync can't read your photos and videos. Open Media sync to allow access."
        val notification = NotificationCompat.Builder(context, MediaSyncNotifications.CHANNEL_ISSUES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Allow access to photos")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(MediaSyncNotifications.openMediaSync(context, MediaSyncPath.HUB, requestCode = PERMISSION_ID))
            .setAutoCancel(true)
            .build()
        notifySafely(context, PERMISSION_ID, notification)
    }

    fun notifyUploaded(context: Context, files: Int) {
        ensureChannel(context)
        if (!MediaSyncNotifications.canNotify(context) || files <= 0) return
        val notification = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (files == 1) "1 photo or video backed up" else "$files photos and videos backed up")
            .setContentIntent(MediaSyncNotifications.openMediaSync(context, MediaSyncPath.HUB, requestCode = SUMMARY_ID))
            .setAutoCancel(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        notifySafely(context, SUMMARY_ID, notification)
    }

    private fun pauseIntent(context: Context): PendingIntent {
        val intent = Intent(context, SyncActionReceiver::class.java).setAction(SyncActionReceiver.ACTION_PAUSE)
        return PendingIntent.getBroadcast(context, PROGRESS_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun notifySafely(context: Context, id: Int, notification: Notification) {
        try {
            NotificationManagerCompat.from(context).notify(id, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }
}

/** [SyncRunNotifier] over [SyncNotifications]; the summary honours the store's toggle. */
class AndroidSyncRunNotifier(context: Context, private val store: SyncStateStore) : SyncRunNotifier {
    private val app = context.applicationContext

    override fun permissionMissing() = SyncNotifications.notifyPermissionMissing(app)

    override fun uploaded(files: Int) {
        if (store.summaryNotifications) SyncNotifications.notifyUploaded(app, files)
    }
}
