package memoriahub.marin.cr.mediasync

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.pairing.PairingController
import memoriahub.marin.cr.ui.components.ServerUrlEditor
import memoriahub.marin.cr.update.UpdateCard
import memoriahub.marin.cr.util.AppInfo
import memoriahub.marin.cr.util.Brand

/**
 * The Hub (docs/specs/android-media-sync.md §12.3), top to bottom: Update card, Server, Pairing,
 * Media sync (counts, status line, Start/Stop, Sync now, Folders, Network & power, Files,
 * Diagnostics, health line, target circle), Open MemoriaHub, version footer. A port of
 * evopath's `HealthSyncActivity` hub.
 */
@Composable
internal fun HubScreen(
    hub: HubController,
    pairing: PairingController,
    onNavigate: (MediaSyncScreen) -> Unit,
    onOpenWebApp: () -> Unit,
    onServerChanged: () -> Unit,
) {
    val context = LocalContext.current
    val app = MobileApplication.from(context)
    val state by hub.state.collectAsState()
    val pairingState by pairing.state.collectAsState()
    var editingServer by rememberSaveable { mutableStateOf(false) }
    val appInfo = AppInfo.read(context)
    val status = pairingState.status

    UpdateCard(modifier = Modifier.fillMaxWidth())

    SectionCard(title = "Server") {
        Text(state.serverUrl ?: "Not configured", style = MaterialTheme.typography.bodyLarge)
        OutlinedButton(onClick = { editingServer = true }) { Text(if (state.serverUrl == null) "Set server" else "Change") }
    }

    SectionCard(title = "Pairing") {
        val text = HubState.pairingText(status, UiFormat.date(status.tokenExpiresAt))
        if (status.expired || status.registrationPending) ErrorText(text) else Text(text)
        Button(onClick = { onNavigate(MediaSyncScreen.Connect) }, modifier = Modifier.fillMaxWidth()) {
            Text(HubState.connectLabel(status))
        }
    }

    SectionCard(title = "Media sync") {
        CountsRow(state)
        state.bytesLeftText?.let { Muted(it) }
        StatusLine(state, onNavigate)
        state.progress?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth()) }
        state.lastError?.let { Muted("Last error: $it") }

        when (state.primaryAction) {
            PrimaryAction.STOP -> Button(onClick = { hub.setPaused(true) }, modifier = Modifier.fillMaxWidth()) { Text("Stop syncing") }
            PrimaryAction.START -> Button(onClick = { hub.setPaused(false) }, modifier = Modifier.fillMaxWidth()) { Text("Start syncing") }
            PrimaryAction.NONE -> Unit
        }
        OutlinedButton(onClick = hub::syncNow, enabled = state.canSyncNow, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
        HorizontalDivider()
        OutlinedButton(onClick = { onNavigate(MediaSyncScreen.Folders) }, modifier = Modifier.fillMaxWidth()) {
            Text("Folders (${state.foldersSelected} selected)")
        }
        OutlinedButton(onClick = { onNavigate(MediaSyncScreen.Network) }, modifier = Modifier.fillMaxWidth()) { Text("Network & power") }
        OutlinedButton(onClick = { onNavigate(MediaSyncScreen.Files) }, modifier = Modifier.fillMaxWidth()) { Text("Files") }
        OutlinedButton(onClick = { onNavigate(MediaSyncScreen.Diagnostics) }, modifier = Modifier.fillMaxWidth()) { Text("Diagnostics") }
        HealthLineRow(state.health, onOpen = { onNavigate(MediaSyncScreen.Diagnostics) })
        state.targetCircle?.let { Muted("Uploads go to: $it (change it on the web)") }
    }

    OutlinedButton(onClick = onOpenWebApp, enabled = state.serverUrl != null, modifier = Modifier.fillMaxWidth()) {
        Text("Open ${Brand.name}")
    }

    Text(
        "${Brand.name} ${appInfo.versionName} (${appInfo.versionCode})",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (editingServer) {
        AlertDialog(
            onDismissRequest = { editingServer = false },
            title = { Text("Server address") },
            text = {
                ServerUrlEditor(
                    initialValue = state.serverUrl.orEmpty(),
                    saveLabel = "Save",
                    onSave = { url ->
                        app.serverConfig.setServerUrl(url)
                        editingServer = false
                        onServerChanged()
                    },
                )
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { editingServer = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun CountsRow(state: HubUiState) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        BigCount("Synced", state.synced)
        BigCount("Missing", state.missing)
        SmallCount("Failed", state.failed, error = state.failed > 0)
        SmallCount("Blocked", state.blocked, error = state.blocked > 0)
    }
}

@Composable
private fun BigCount(label: String, value: Int) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(MediaSyncFormat.count(value), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun SmallCount(label: String, value: Int, error: Boolean) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(
            MediaSyncFormat.count(value),
            style = MaterialTheme.typography.titleLarge,
            color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        Text(label, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun StatusLine(state: HubUiState, onNavigate: (MediaSyncScreen) -> Unit) {
    val warn = state.status in setOf(
        HubStatus.PAIRING_EXPIRED, HubStatus.PERMISSION_NEEDED, HubStatus.NOT_PAIRED,
    )
    val color = if (warn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    when {
        state.statusOpensConnect -> TextButton(onClick = { onNavigate(MediaSyncScreen.Connect) }) { Text(state.statusText, color = color) }
        state.statusOpensFolders -> TextButton(onClick = { onNavigate(MediaSyncScreen.Folders) }) { Text(state.statusText, color = color) }
        else -> Text(state.statusText, style = MaterialTheme.typography.bodyMedium, color = color)
    }
}

/** "All checks pass" or "N problems — open Diagnostics" (red when any check fails). */
@Composable
private fun HealthLineRow(health: HealthLineView?, onOpen: () -> Unit) {
    health ?: return
    if (!health.opensDiagnostics) {
        Muted(health.text)
        return
    }
    TextButton(onClick = onOpen) {
        Text(
            health.text,
            color = if (health.severity == HealthSeverity.FAIL) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        )
    }
}
