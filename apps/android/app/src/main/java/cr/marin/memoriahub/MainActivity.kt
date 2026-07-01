package cr.marin.memoriahub

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cr.marin.memoriahub.sync.SyncNotifications
import cr.marin.memoriahub.ui.RootDestination
import cr.marin.memoriahub.ui.RootViewModel
import cr.marin.memoriahub.ui.auth.DeviceAuthScreen
import cr.marin.memoriahub.ui.main.MainShell
import cr.marin.memoriahub.ui.serverurl.ServerUrlScreen
import cr.marin.memoriahub.data.repo.DeviceAuthRepository
import cr.marin.memoriahub.ui.theme.MemoriaHubTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.MutableStateFlow
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var deviceAuthRepository: DeviceAuthRepository

    /** In-app navigation requests from notification taps; consumed by [MainShell]. */
    private val navTarget = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handleDeviceCompleteDeepLink(intent)
        handleNavTarget(intent)
        setContent {
            MemoriaHubTheme {
                val target by navTarget.collectAsStateWithLifecycle()
                AppRoot(
                    navTarget = target,
                    onNavTargetConsumed = { navTarget.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeviceCompleteDeepLink(intent)
        handleNavTarget(intent)
    }

    private fun handleNavTarget(intent: Intent?) {
        val target = intent?.getStringExtra(SyncNotifications.EXTRA_NAV_TARGET) ?: return
        navTarget.value = target
    }

    /**
     * When the web activation page returns us via memoriahub://auth/device-complete after
     * approval, wake the device-auth polling loop so login completes immediately instead of
     * waiting for the next poll interval.
     */
    private fun handleDeviceCompleteDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme == "memoriahub" && data.host == "auth") {
            deviceAuthRepository.pokeNow()
        }
    }
}

@Composable
private fun AppRoot(
    navTarget: String? = null,
    onNavTargetConsumed: () -> Unit = {},
    viewModel: RootViewModel = hiltViewModel(),
) {
    val destination by viewModel.destination.collectAsStateWithLifecycle()

    Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
        val contentModifier = Modifier
            .fillMaxSize()
            .padding(padding)
        when (destination) {
            RootDestination.Loading -> Box(contentModifier, contentAlignment = Alignment.Center) {}
            RootDestination.ServerUrl -> ServerUrlScreen(modifier = contentModifier)
            RootDestination.Auth -> DeviceAuthScreen(modifier = contentModifier)
            RootDestination.Main -> {
                LaunchedEffect(Unit) { viewModel.onMainVisible() }
                MainShell(
                    navTarget = navTarget,
                    onNavTargetConsumed = onNavTargetConsumed,
                    modifier = contentModifier,
                )
            }
        }
    }
}
