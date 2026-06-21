package cr.marin.memoriahub.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import cr.marin.memoriahub.core.auth.TokenStore
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/** Re-arms sync scheduling after reboot so backup resumes without opening the app. */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject
    lateinit var scheduler: SyncScheduler

    @Inject
    lateinit var tokenStore: TokenStore

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && tokenStore.isLoggedIn) {
            scheduler.ensureScheduled()
        }
    }
}
