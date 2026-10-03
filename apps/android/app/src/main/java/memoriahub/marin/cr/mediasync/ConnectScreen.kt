package memoriahub.marin.cr.mediasync

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import memoriahub.marin.cr.pairing.ConnectView
import memoriahub.marin.cr.pairing.PairingController
import memoriahub.marin.cr.pairing.PairingPhase
import memoriahub.marin.cr.pairing.PairingUiState
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.permissions.MediaPermissions
import memoriahub.marin.cr.util.Brand

/**
 * Connect (docs/specs/android-media-sync.md §7, §12.4): pairing with the account, the media
 * permission (the shared [MediaPermissionCard], also on Folders) and the Android 13+
 * notification permission. Hosted by [MediaSyncActivity]. [mediaPermissionChanged] lets the host
 * refresh whatever depends on the grant (the ledger, #510).
 */
@Composable
fun ConnectScreen(
    controller: PairingController,
    mediaPermissionChanged: (MediaPermissionState) -> Unit = {},
) {
    val context = LocalContext.current
    val pairing by controller.state.collectAsState()
    var confirmUnpair by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(controller) { controller.openUrl.collect { openInCustomTab(context, it) } }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PairingSection(
            pairing = pairing,
            onPair = controller::startPairing,
            onCancel = controller::cancel,
            onOpenPage = controller::reopenActivationPage,
            onRetryRegistration = controller::retryRegistration,
            onUnpair = { confirmUnpair = true },
        )
        MediaPermissionCard(onChanged = mediaPermissionChanged, showWhenFull = true)
        NotificationPermissionSection()
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = {
                Text(
                    "Media sync stops and this phone's access token is revoked. Photos and videos already " +
                        "uploaded stay in ${Brand.name}.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    controller.unpair()
                }) { Text("Unpair") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }

    pairing.unpairFailure?.let { message ->
        AlertDialog(
            onDismissRequest = controller::dismissUnpairFailure,
            title = { Text("Could not reach the server") },
            text = {
                Text(
                    "$message\n\nYou can remove the pairing from this phone only. The device and its token then " +
                        "stay active on the server until you remove them in ${Brand.name} → Settings → Media sync.",
                )
            },
            confirmButton = {
                TextButton(onClick = { controller.unpair(forgetLocallyOnFailure = true) }) { Text("Remove from this phone") }
            },
            dismissButton = { TextButton(onClick = controller::dismissUnpairFailure) { Text("Cancel") } },
        )
    }
}

@Composable
private fun PairingSection(
    pairing: PairingUiState,
    onPair: () -> Unit,
    onCancel: () -> Unit,
    onOpenPage: () -> Unit,
    onRetryRegistration: () -> Unit,
    onUnpair: () -> Unit,
) {
    val status = pairing.status
    SectionCard(title = "${Brand.name} account") {
        when (pairing.view) {
            ConnectView.NO_SERVER -> ErrorText("Set the server address on the Media sync screen first.")
            ConnectView.BUSY -> when (pairing.phase) {
                PairingPhase.REQUESTING_CODE -> Busy("Requesting a pairing code…")
                PairingPhase.REGISTERING -> Busy("Registering this phone…")
                PairingPhase.UNPAIRING -> Busy("Unpairing…")
                PairingPhase.WAITING_FOR_APPROVAL, PairingPhase.IDLE -> CodeShown(pairing, onOpenPage, onCancel)
            }
            ConnectView.NOT_PAIRED -> {
                Text("Pair this phone with your ${Brand.name} account. You approve it in your browser, where you are already signed in.")
                Notes(pairing)
                Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Pair with ${Brand.name}") }
                if (pairing.canRetryRegistration) {
                    OutlinedButton(onClick = onRetryRegistration, modifier = Modifier.fillMaxWidth()) { Text("Retry registration") }
                }
            }
            ConnectView.PAIRED -> {
                Text("Paired with your ${Brand.name} account.")
                Muted("Token expires ${UiFormat.date(status.tokenExpiresAt)}")
                Notes(pairing)
                Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Re-pair") }
                OutlinedButton(onClick = onUnpair, modifier = Modifier.fillMaxWidth()) { Text("Unpair") }
            }
            ConnectView.TOKEN_NO_DEVICE -> {
                ErrorText("Signed in, but this phone is not registered yet.")
                Notes(pairing)
                Button(onClick = onRetryRegistration, modifier = Modifier.fillMaxWidth()) { Text("Retry registration") }
                OutlinedButton(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Re-pair") }
            }
            ConnectView.EXPIRED -> {
                ErrorText("The server no longer accepts this phone's token. Pair again to resume syncing.")
                Notes(pairing)
                Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text("Re-pair") }
                OutlinedButton(onClick = onUnpair, modifier = Modifier.fillMaxWidth()) { Text("Unpair") }
            }
        }
    }
}

@Composable
private fun CodeShown(pairing: PairingUiState, onOpenPage: () -> Unit, onCancel: () -> Unit) {
    Text("Approve this phone in the browser that just opened. Check that it shows this code:")
    Text(
        pairing.userCode.orEmpty(),
        style = MaterialTheme.typography.headlineMedium,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
    )
    pairing.verificationUri?.let { Muted("Or open $it on any device signed in to ${Brand.name} and enter the code.") }
    pairing.secondsRemaining?.let { Muted("The code expires in about ${UiFormat.minutes(it)}.") }
    pairing.note?.let { Muted(it) }
    Busy("Waiting for approval…")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onOpenPage) { Text("Open sign-in page") }
        OutlinedButton(onClick = onCancel) { Text("Cancel") }
    }
}

@Composable
private fun Notes(pairing: PairingUiState) {
    pairing.note?.let { Text(it) }
    pairing.error?.let { ErrorText(it) }
}

@Composable
private fun NotificationPermissionSection() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = LocalContext.current
    var needed by remember { mutableStateOf(MediaPermissions.notificationsNeedRequest(context)) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        needed = MediaPermissions.notificationsNeedRequest(context)
    }
    if (!needed) return
    SectionCard(title = "Notifications") {
        Text("Allow notifications so ${Brand.name} can tell you when Media sync needs you to pair again.")
        OutlinedButton(onClick = { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Allow notifications") }
    }
}
