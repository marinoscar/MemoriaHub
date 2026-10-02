package memoriahub.marin.cr.mediasync

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import memoriahub.marin.cr.contract.NetworkMode

/**
 * Network & power (docs/specs/android-media-sync.md §12.4): Wi-Fi only / Wi-Fi and mobile data,
 * Only while charging, Upload existing (one-way confirm before "Only new ones"), and the local
 * "photos backed up" summary notification switch.
 */
@Composable
internal fun NetworkScreen(network: NetworkController, onOpenConnect: () -> Unit) {
    val state by network.state.collectAsState()
    LaunchedEffect(network) { network.load() }

    if (!state.paired) {
        SectionCard(title = "Not paired") {
            ErrorText("Pair this phone first; these settings are saved to your account.")
            Button(onClick = onOpenConnect, modifier = Modifier.fillMaxWidth()) { Text("Connect") }
        }
    }

    SectionCard(title = "Network") {
        Column(Modifier.selectableGroup()) {
            Choice("Wi-Fi only", "Uploads wait for Wi-Fi (recommended).", state.network == NetworkMode.WIFI) {
                network.setNetwork(NetworkMode.WIFI)
            }
            Choice("Wi-Fi and mobile data", "Large videos can use a lot of mobile data.", state.network == NetworkMode.ANY) {
                network.setNetwork(NetworkMode.ANY)
            }
        }
    }

    SectionCard(title = "Power") {
        ToggleRow(
            "Only while charging",
            state.requireCharging,
            network::setRequireCharging,
            description = "Uploads run only when the phone is plugged in.",
        )
    }

    SectionCard(title = "Upload existing") {
        Column(Modifier.selectableGroup()) {
            Choice(
                "All photos and videos in selected folders",
                "Backs up everything already on the phone, then new ones.",
                state.uploadExisting == UploadExisting.ALL,
            ) { network.chooseUploadExisting(UploadExisting.ALL) }
            Choice(
                "Only new ones taken from now on",
                "Photos and videos taken before this phone was paired are skipped.",
                state.uploadExisting == UploadExisting.FROM_PAIRING,
            ) { network.chooseUploadExisting(UploadExisting.FROM_PAIRING) }
        }
    }

    SectionCard(title = "Notifications") {
        ToggleRow(
            "Backup summary",
            state.summaryNotifications,
            network::setSummaryNotifications,
            description = "\"12 photos backed up\" after a background sync uploads something.",
        )
    }

    state.error?.let { ErrorText(it) }
    state.message?.let { Muted(it) }
    Button(onClick = network::save, enabled = state.canSave, modifier = Modifier.fillMaxWidth()) {
        Text(if (state.saving) "Saving…" else "Save")
    }

    if (state.confirmFromPairing) {
        AlertDialog(
            onDismissRequest = network::cancelFromPairing,
            title = { Text("Only new photos and videos?") },
            text = {
                Text(
                    "Photos and videos taken before this phone was paired will not be uploaded. Files not uploaded " +
                        "yet are skipped; files already uploaded stay where they are.",
                )
            },
            confirmButton = { TextButton(onClick = network::confirmFromPairing) { Text("Only new ones") } },
            dismissButton = { TextButton(onClick = network::cancelFromPairing) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Choice(label: String, description: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().selectable(selected = selected, onClick = onSelect, role = Role.RadioButton),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.titleSmall)
            Muted(description)
        }
    }
}
