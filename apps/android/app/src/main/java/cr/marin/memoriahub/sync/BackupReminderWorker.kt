package cr.marin.memoriahub.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import cr.marin.memoriahub.core.auth.TokenStore
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.core.util.TimeProvider
import cr.marin.memoriahub.data.repo.SyncRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Daily check that nudges the user when backup is off and new photos/videos are
 * piling up unprotected. Stays scheduled even while backup is off — it is the
 * mechanism that brings users back. Plain background work (no foreground
 * promotion): a read-only MediaStore scan plus a Room count is cheap.
 *
 * Never returns retry — a missed nudge just waits for tomorrow's run.
 */
@HiltWorker
class BackupReminderWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val appConfigStore: AppConfigStore,
    private val tokenStore: TokenStore,
    private val syncRepository: SyncRepository,
    private val notifications: SyncNotifications,
    private val time: TimeProvider,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (!tokenStore.isLoggedIn) return Result.success()

        if (appConfigStore.backupEnabled) {
            // Backup came back on since the reminder was posted; clear any stale nudge.
            notifications.cancelReminder()
            return Result.success()
        }

        val gapCount = runCatching { syncRepository.countNotBackedUp() }.getOrElse { return Result.success() }
        val now = time.nowMillis()
        val shouldRemind = BackupReminderPolicy.shouldRemind(
            remindersEnabled = appConfigStore.notifyBackupReminders,
            lastRemindedAtMs = appConfigStore.lastReminderNotifiedAtMs,
            nowMs = now,
            gapCount = gapCount,
        )
        if (shouldRemind) {
            notifications.showReminder(gapCount)
            appConfigStore.lastReminderNotifiedAtMs = now
        }
        return Result.success()
    }
}
