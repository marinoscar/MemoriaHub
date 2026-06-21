package cr.marin.memoriahub.ui.main

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import cr.marin.memoriahub.ui.photos.PhotosScreen
import cr.marin.memoriahub.ui.settings.SettingsScreen
import cr.marin.memoriahub.ui.status.SyncStatusScreen

private enum class Tab(val route: String, val label: String, val icon: ImageVector) {
    Photos("photos", "Photos", Icons.Filled.PhotoLibrary),
    Sync("sync", "Backup", Icons.Filled.CloudSync),
    Settings("settings", "Settings", Icons.Filled.Settings),
}

@Composable
fun MainShell(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(hasMediaReadPermission(context)) }
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { granted = hasMediaReadPermission(context) }

    if (!granted) {
        PermissionGate(modifier = modifier, onRequest = { launcher.launch(requiredMediaPermissions()) })
        return
    }

    val navController = rememberNavController()
    Scaffold(
        modifier = modifier,
        bottomBar = {
            val backStack by navController.currentBackStackEntryAsState()
            val current = backStack?.destination
            NavigationBar {
                Tab.entries.forEach { tab ->
                    val selected = current?.hierarchy?.any { it.route == tab.route } == true
                    NavigationBarItem(
                        selected = selected,
                        onClick = {
                            navController.navigate(tab.route) {
                                popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = tab.label) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Tab.Photos.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Tab.Photos.route) { PhotosScreen() }
            composable(Tab.Sync.route) { SyncStatusScreen() }
            composable(Tab.Settings.route) { SettingsScreen() }
        }
    }
}

@Composable
private fun PermissionGate(onRequest: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.Image, contentDescription = null, modifier = Modifier.padding(bottom = 16.dp))
        Text(
            "MemoriaHub needs access to your photos and videos to back them up.",
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(bottom = 24.dp),
        )
        Button(onClick = onRequest) { Text("Grant access") }
    }
}
