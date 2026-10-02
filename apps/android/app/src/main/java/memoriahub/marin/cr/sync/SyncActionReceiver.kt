package memoriahub.marin.cr.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.launch
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.diagnostics.AppLog

/** The "Pause" action of the "Upload progress" notification → `SyncControl.setPaused(true)`. */
class SyncActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_PAUSE) return
        val app = MobileApplication.from(context)
        val pending = goAsync()
        app.appScope.launch {
            try {
                app.syncControl.setPaused(true)
                    .onFailure { AppLog.w(TAG, "sync.notification.pause_failed ${it.message}") }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "Sync"
        const val ACTION_PAUSE = "memoriahub.marin.cr.sync.PAUSE"
    }
}
