package memoriahub.marin.cr.mediasync

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.MutableStateFlow
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.diagnostics.DiagnosticsScreen
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.twa.TwaLauncherActivity
import memoriahub.marin.cr.ui.theme.AppTheme

/**
 * The native Media Sync screens (docs/specs/android-media-sync.md §12): one activity with an
 * in-memory screen enum ([MediaSyncScreen]: Hub, Connect, Folders, Network, Files, Diagnostics),
 * a `BackHandler` back to the Hub and a brand-coloured `TopAppBar`; no NavHost (same as evopath's
 * `HealthSyncActivity`).
 *
 * Entry points: the launcher's long-press shortcuts (Media sync, Diagnostics, and the dynamic
 * Sync now / Pause / Resume), `memoriahub://media-sync[/<path>][?action=…]` deep links (the web
 * app, the device-flow `returnUri` `/paired`) and notification content intents (`EXTRA_OPEN`).
 * Routing is the pure [MediaSyncLinks.route] → [MediaSyncActions.target]; `?action=` runs through
 * [HubController.runAction] once the screen is shown.
 */
class MediaSyncActivity : ComponentActivity() {
    private val pairingVm: PairingViewModel by viewModels()
    private val mediaVm: MediaSyncViewModel by viewModels()

    /** The current screen; saved across recreation. */
    private val screen = MutableStateFlow(MediaSyncScreen.Hub)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        pairingVm.onPairingChanged = { mediaVm.hub.refresh(checkHealthAndUpdates = false) }
        screen.value = MediaSyncScreen.named(savedInstanceState?.getString(STATE_SCREEN))
        if (savedInstanceState == null) {
            // Debounced sync on open (#512) and the throttled update check (#514).
            MobileApplication.from(this).onAppOpen()
            handle(intent)
        }

        setContent {
            AppTheme {
                MediaSyncApp(
                    screenFlow = screen,
                    pairingVm = pairingVm,
                    mediaVm = mediaVm,
                    onOpenWebApp = ::openWebApp,
                )
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_SCREEN, screen.value.name)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        // Permissions, pairing or the server may have changed elsewhere (system settings, browser, web).
        pairingVm.controller.refreshStatus()
        mediaVm.hub.refresh()
        when (screen.value) {
            MediaSyncScreen.Folders -> mediaVm.folders.load(keepEdits = true)
            MediaSyncScreen.Network -> mediaVm.network.load()
            MediaSyncScreen.Files -> mediaVm.files.reload()
            else -> Unit
        }
    }

    /** Routes [intent]: screen from the path or `EXTRA_OPEN`, `/paired` polls now, `?action=` runs. */
    private fun handle(intent: Intent?) {
        val route = MediaSyncLinks.route(intent?.dataString, intent?.getStringExtra(MediaSyncLinks.EXTRA_OPEN))
        val target = MediaSyncActions.target(route)
        screen.value = target.screen
        if (target.pokePairing) {
            AppLog.i(TAG, "Returned from the activation page; polling now")
            pairingVm.controller.pokeNow()
        }
        target.action?.let { mediaVm.hub.runAction(it) }
    }

    private fun openWebApp(path: String?) {
        startActivity(
            Intent(this, TwaLauncherActivity::class.java).apply { path?.let { putExtra(TwaLauncherActivity.EXTRA_PATH, it) } },
        )
    }

    private companion object {
        const val TAG = "MediaSync"
        const val STATE_SCREEN = "screen"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MediaSyncApp(
    screenFlow: MutableStateFlow<MediaSyncScreen>,
    pairingVm: PairingViewModel,
    mediaVm: MediaSyncViewModel,
    onOpenWebApp: (String?) -> Unit,
) {
    val screen by screenFlow.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    val navigate: (MediaSyncScreen) -> Unit = { screenFlow.value = it }
    val toHub = { screenFlow.value = MediaSyncScreen.Hub }

    LaunchedEffect(mediaVm) { mediaVm.hub.messages.collect { snackbar.showSnackbar(it) } }
    BackHandler(enabled = screen != MediaSyncScreen.Hub, onBack = toHub)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(screen.title) },
                navigationIcon = {
                    if (screen != MediaSyncScreen.Hub) TextButton(onClick = toHub) { Text("Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when (screen) {
                MediaSyncScreen.Hub -> HubScreen(
                    hub = mediaVm.hub,
                    pairing = pairingVm.controller,
                    onNavigate = navigate,
                    onOpenWebApp = { onOpenWebApp(null) },
                    onServerChanged = {
                        pairingVm.controller.refreshStatus()
                        mediaVm.hub.refresh(checkHealthAndUpdates = true)
                    },
                )
                MediaSyncScreen.Connect -> ConnectScreen(
                    controller = pairingVm.controller,
                    mediaPermissionChanged = { permission ->
                        mediaVm.hub.refresh(checkHealthAndUpdates = false)
                        if (permission != MediaPermissionState.DENIED && pairingVm.state.value.status.paired) mediaVm.hub.syncNow()
                    },
                )
                MediaSyncScreen.Folders -> FoldersScreen(mediaVm.folders, onOpenConnect = { navigate(MediaSyncScreen.Connect) })
                MediaSyncScreen.Network -> NetworkScreen(mediaVm.network, onOpenConnect = { navigate(MediaSyncScreen.Connect) })
                MediaSyncScreen.Files -> FilesScreen(mediaVm.files, onOpenSynced = { onOpenWebApp(MEDIA_WEB_PATH) })
                MediaSyncScreen.Diagnostics -> DiagnosticsScreen(onBack = toHub)
            }
        }
    }
}

/** The web gallery a synced file opens (D20: there is no per-item web route). */
private const val MEDIA_WEB_PATH = "/media"
