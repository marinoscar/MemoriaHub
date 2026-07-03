package cr.marin.memoriahub.ui.settings

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun SettingsScreen(
    onOpenFolders: () -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // POST_NOTIFICATIONS is runtime-requested on Android 13+. The in-app toggle is
    // persisted regardless; on permanent denial we point at system settings below.
    var notificationsPermitted by remember { mutableStateOf(hasNotificationPermission(context)) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { notificationsPermitted = hasNotificationPermission(context) }
    val requestNotificationPermissionIfNeeded = {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationsPermitted) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall)

        Text(
            "Backup",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
        )
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = if (state.backupEnabled) {
                CardDefaults.cardColors()
            } else {
                // Backup off must be unmissable, even inside Settings.
                CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                )
            },
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                ToggleRow(
                    title = "Back up photos & videos",
                    subtitle = if (state.backupEnabled) {
                        "Backup is on — new photos and videos upload automatically"
                    } else {
                        "Backup is off — nothing on this device is being backed up"
                    },
                    checked = state.backupEnabled,
                    onCheckedChange = viewModel::setBackupEnabled,
                    subtitleColor = if (state.backupEnabled) {
                        MaterialTheme.colorScheme.outline
                    } else {
                        MaterialTheme.colorScheme.onErrorContainer
                    },
                )
            }
        }

        Section("Account") {
            Text(state.displayName ?: state.email ?: "—", style = MaterialTheme.typography.bodyLarge)
            if (state.displayName != null && state.email != null) {
                Text(state.email!!, style = MaterialTheme.typography.bodySmall)
            }
            Text(
                state.serverUrl ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier.padding(top = 4.dp),
            )
        }

        Section("Backup circle") {
            if (state.error != null) {
                Text(state.error!!, color = MaterialTheme.colorScheme.error)
            }
            state.circles.forEach { circle ->
                Row(
                    selected = circle.id == state.targetCircleId,
                    onSelect = { viewModel.selectCircle(circle.id) },
                    label = if (circle.isPersonal) "${circle.name} (personal)" else circle.name,
                )
            }
            if (state.circles.isEmpty() && !state.loading) {
                Text("No circles available", style = MaterialTheme.typography.bodySmall)
            }
        }

        Section("Backup folders") {
            androidx.compose.foundation.layout.Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onOpenFolders)
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("Synced folders", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Choose which device folders are backed up",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                )
            }
        }

        Section("Notifications") {
            ToggleRow(
                title = "Backup reminders",
                subtitle = "Remind me when backup is off and new items aren't backed up",
                checked = state.remindersEnabled,
                onCheckedChange = { enabled ->
                    viewModel.setRemindersEnabled(enabled)
                    if (enabled) requestNotificationPermissionIfNeeded()
                },
            )
            ToggleRow(
                title = "Backup issues",
                subtitle = "Alert me when items fail to back up",
                checked = state.issuesEnabled,
                onCheckedChange = { enabled ->
                    viewModel.setIssuesEnabled(enabled)
                    if (enabled) requestNotificationPermissionIfNeeded()
                },
            )
            if (!notificationsPermitted) {
                Text(
                    "Notifications are blocked for MemoriaHub. Allow them in system settings for reminders and alerts to appear.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            androidx.compose.foundation.layout.Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                        )
                    }
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("System notification settings", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Fine-tune sound, vibration, and per-category behavior",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.outline,
                    )
                }
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                )
            }
        }

        Button(
            onClick = viewModel::logout,
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 32.dp),
        ) {
            Text("Log out")
        }
    }
}

private fun hasNotificationPermission(context: android.content.Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    subtitleColor: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Unspecified,
) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = subtitleColor.takeIf { it != androidx.compose.ui.graphics.Color.Unspecified }
                    ?: MaterialTheme.colorScheme.outline,
            )
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Text(
        title,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 24.dp, bottom = 8.dp),
    )
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) { content() }
    }
}

@Composable
private fun Row(selected: Boolean, onSelect: () -> Unit, label: String) {
    androidx.compose.foundation.layout.Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onSelect)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(label, modifier = Modifier.padding(start = 8.dp))
    }
}
