package cr.marin.memoriahub.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/** Handles notification action buttons, e.g. "Turn on backup" on the reminder. */
@AndroidEntryPoint
class NotificationActionReceiver : BroadcastReceiver() {

    @Inject
    lateinit var backupController: BackupController

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_TURN_ON_BACKUP) {
            backupController.turnOn()
        }
    }

    companion object {
        const val ACTION_TURN_ON_BACKUP = "cr.marin.memoriahub.action.TURN_ON_BACKUP"
    }
}
