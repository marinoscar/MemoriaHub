package cr.marin.memoriahub

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cr.marin.memoriahub.ui.RootDestination
import cr.marin.memoriahub.ui.RootViewModel
import cr.marin.memoriahub.ui.auth.DeviceAuthScreen
import cr.marin.memoriahub.ui.serverurl.ServerUrlScreen
import cr.marin.memoriahub.ui.theme.MemoriaHubTheme
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            MemoriaHubTheme {
                AppRoot()
            }
        }
    }
}

@Composable
private fun AppRoot(viewModel: RootViewModel = hiltViewModel()) {
    val destination by viewModel.destination.collectAsStateWithLifecycle()

    Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
        val contentModifier = Modifier
            .fillMaxSize()
            .padding(padding)
        when (destination) {
            RootDestination.Loading -> Box(contentModifier, contentAlignment = Alignment.Center) {}
            RootDestination.ServerUrl -> ServerUrlScreen(modifier = contentModifier)
            RootDestination.Auth -> DeviceAuthScreen(modifier = contentModifier)
            // The bottom-nav main shell (photos / sync / settings) is wired in a later milestone.
            RootDestination.Main -> {
                LaunchedEffect(Unit) { viewModel.onMainVisible() }
                Box(contentModifier, contentAlignment = Alignment.Center) {
                    Text("Signed in — sync UI coming next")
                }
            }
        }
    }
}
