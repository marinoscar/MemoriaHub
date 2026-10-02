package memoriahub.marin.cr.mediasync

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.deeplink.MediaSyncRoute
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ui.theme.AppTheme

/**
 * The native Media Sync screens (`memoriahub://media-sync[/…]`, `EXTRA_OPEN`).
 *
 * Issue #509 ships the minimal host: every route shows Connect, and `/paired` (the device-flow
 * `returnUri` the activation page redirects to after approval) brings the user back here and polls
 * the pending code at once ([PairingViewModel] → `pokeNow()`). Issue #513 extends this activity
 * with the Hub and the other screens (in-memory screen enum, `BackHandler`, `?action=`), the
 * shortcuts' target class, and the onCreate/onResume hooks of §12.3; route parsing is already
 * [MediaSyncLinks.route].
 */
class MediaSyncActivity : ComponentActivity() {
    private val pairingVm: PairingViewModel by viewModels()

    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)

        setContent {
            AppTheme {
                Scaffold(topBar = { TopAppBar(title = { Text("Media sync") }) }) { padding ->
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .verticalScroll(rememberScrollState())
                            .padding(16.dp),
                    ) {
                        ConnectScreen(pairingVm.controller)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        pairingVm.controller.refreshStatus()
    }

    /** Routes [intent]; returns the route (#513 switches screens on it). */
    private fun handle(intent: Intent?): MediaSyncRoute {
        val route = MediaSyncLinks.route(intent?.dataString, intent?.getStringExtra(MediaSyncLinks.EXTRA_OPEN))
        if (route.isPairingReturn) {
            AppLog.i(TAG, "Returned from the activation page; polling now")
            pairingVm.controller.pokeNow()
        }
        return route
    }

    private companion object {
        const val TAG = "MediaSync"
    }
}
