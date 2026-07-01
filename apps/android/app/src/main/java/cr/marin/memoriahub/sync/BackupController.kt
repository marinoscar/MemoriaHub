package cr.marin.memoriahub.sync

import cr.marin.memoriahub.core.storage.AppConfigStore
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The single place that flips backup on/off, so the settings toggle, the
 * backup-off banner, and notification actions all behave identically.
 *
 * Turning off cancels sync work but leaves the reminder worker scheduled — the
 * reminder is what nudges the user back when new photos pile up unbacked-up.
 */
@Singleton
class BackupController @Inject constructor(
    private val appConfigStore: AppConfigStore,
    private val syncScheduler: SyncScheduler,
) {
    fun turnOn() {
        // Set the pref first: the scheduler gates every entry point on it.
        appConfigStore.setBackupEnabled(true)
        syncScheduler.ensureScheduled()
        syncScheduler.syncNow()
    }

    fun turnOff() {
        appConfigStore.setBackupEnabled(false)
        syncScheduler.cancelSyncWork()
    }
}
