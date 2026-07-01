package cr.marin.memoriahub.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ForegroundInfo
import cr.marin.memoriahub.MainActivity
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Owns the app's notification channels and builds every backup notification.
 *
 * One channel per category (progress / reminders / issues) so users get free
 * per-category control in system settings, layered under the in-app mute
 * toggles in [cr.marin.memoriahub.core.storage.AppConfigStore].
 */
@Singleton
class SyncNotifications @Inject constructor(
    @param:ApplicationContext private val context: Context,
) {
    fun ensureChannels() {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_PROGRESS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_PROGRESS,
                    "Backup progress",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "Shown while photos are backing up" },
            )
        }
        if (manager.getNotificationChannel(CHANNEL_REMINDERS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_REMINDERS,
                    "Backup reminders",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = "Reminds you when backup is off and new items aren't backed up" },
            )
        }
        if (manager.getNotificationChannel(CHANNEL_ISSUES) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ISSUES,
                    "Backup issues",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = "Alerts you when items fail to back up" },
            )
        }
    }

    fun buildNotification(text: String): Notification {
        ensureChannels()
        return NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setContentTitle("MemoriaHub")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    fun foregroundInfo(text: String = "Backing up photos…"): ForegroundInfo {
        val notification = buildNotification(text)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID_PROGRESS, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID_PROGRESS, notification)
        }
    }

    /** "Backup is off" nudge with a one-tap turn-on action. */
    fun showReminder(gapCount: Int) {
        if (!canNotify()) return
        ensureChannels()
        val items = if (gapCount == 1) "1 new item isn't" else "$gapCount new items aren't"
        val notification = NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setContentTitle("Backup is off")
            .setContentText("$items backed up. Turn on backup to protect your photos and videos.")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("$items backed up. Turn on backup to protect your photos and videos."),
            )
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentIntent(openBackupTabIntent())
            .addAction(0, "Turn on backup", turnOnBackupIntent())
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID_REMINDER, notification)
    }

    fun cancelReminder() {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_REMINDER)
    }

    /** "Items failed to back up" alert pointing at the Backup status screen. */
    fun showIssues(failureCount: Int) {
        if (!canNotify()) return
        ensureChannels()
        val items = if (failureCount == 1) "1 item" else "$failureCount items"
        val notification = NotificationCompat.Builder(context, CHANNEL_ISSUES)
            .setContentTitle("Backup issues")
            .setContentText("$items couldn't be backed up. Tap to review and retry.")
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentIntent(openBackupTabIntent())
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID_ISSUES, notification)
    }

    fun cancelIssues() {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID_ISSUES)
    }

    private fun canNotify(): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun openBackupTabIntent(): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(EXTRA_NAV_TARGET, NAV_TARGET_BACKUP)
        }
        return PendingIntent.getActivity(
            context,
            REQUEST_OPEN_BACKUP,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun turnOnBackupIntent(): PendingIntent {
        val intent = Intent(context, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_TURN_ON_BACKUP
        }
        return PendingIntent.getBroadcast(
            context,
            REQUEST_TURN_ON,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    companion object {
        // Keep the original foreground channel id so existing installs don't accumulate
        // an orphaned channel; only its display name changes.
        const val CHANNEL_PROGRESS = "sync_channel"
        const val CHANNEL_REMINDERS = "backup_reminders"
        const val CHANNEL_ISSUES = "backup_issues"
        const val NOTIFICATION_ID_PROGRESS = 1001
        const val NOTIFICATION_ID_REMINDER = 1002
        const val NOTIFICATION_ID_ISSUES = 1003
        const val EXTRA_NAV_TARGET = "nav_target"
        const val NAV_TARGET_BACKUP = "backup"
        private const val REQUEST_OPEN_BACKUP = 2001
        private const val REQUEST_TURN_ON = 2002
    }
}
