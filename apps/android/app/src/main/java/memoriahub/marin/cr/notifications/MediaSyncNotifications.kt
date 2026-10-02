package memoriahub.marin.cr.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import memoriahub.marin.cr.R
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.deeplink.MediaSyncPath
import memoriahub.marin.cr.mediasync.MediaSyncActivity
import memoriahub.marin.cr.pairing.PairingNotifier
import memoriahub.marin.cr.util.Brand

/**
 * Notification channels and the pairing notification (docs/specs/android-media-sync.md §12.5).
 * The "Sync issues" channel is shared: #512 adds the "Upload progress" channel and the other
 * issue notifications (permission lost, blocked uploads, battery) here, each with its own id.
 */
object MediaSyncNotifications {
    const val CHANNEL_ISSUES = "media_sync_issues"
    const val PAIRING_EXPIRED_ID = 5091

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ISSUES, "Sync issues", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Problems that stop Media sync, such as an expired pairing."
            },
        )
    }

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun notifyPairingExpired(context: Context) {
        ensureChannels(context)
        if (!canNotify(context)) return
        val text = "Your ${Brand.name} server no longer accepts this phone. Open Media sync to pair again."
        val notification = NotificationCompat.Builder(context, CHANNEL_ISSUES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Pairing expired — re-pair")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(openMediaSync(context, MediaSyncPath.CONNECT))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(PAIRING_EXPIRED_ID, notification)
        } catch (_: SecurityException) {
            // Notification permission revoked between the check and the call.
        }
    }

    fun cancelPairingExpired(context: Context) {
        NotificationManagerCompat.from(context).cancel(PAIRING_EXPIRED_ID)
    }

    /** Content intent opening [MediaSyncActivity] on [open] (`EXTRA_OPEN`). */
    fun openMediaSync(context: Context, open: MediaSyncPath, requestCode: Int = open.ordinal): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(MediaSyncLinks.uri()), context, MediaSyncActivity::class.java)
            .putExtra(MediaSyncLinks.EXTRA_OPEN, open.segment.ifEmpty { "hub" })
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}

/** [PairingNotifier] over [MediaSyncNotifications]. */
class AndroidPairingNotifier(context: Context) : PairingNotifier {
    private val app = context.applicationContext

    override fun notifyPairingExpired() = MediaSyncNotifications.notifyPairingExpired(app)

    override fun cancelPairingExpired() = MediaSyncNotifications.cancelPairingExpired(app)
}
