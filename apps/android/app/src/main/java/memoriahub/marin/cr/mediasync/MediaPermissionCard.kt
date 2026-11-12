package memoriahub.marin.cr.mediasync

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import memoriahub.marin.cr.permissions.MediaPermissionAction
import memoriahub.marin.cr.permissions.MediaPermissionPrompts
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.permissions.MediaPermissions
import memoriahub.marin.cr.util.Brand

/**
 * The media-permission card shared by Connect and Folders (docs/specs/android-media-sync.md
 * §11.1, §12.4), so the two cannot drift. It requests the permission in place with the system
 * dialog; once Android stops showing the dialog (permanently denied, see
 * [MediaPermissions.nextAction]) the button opens the app's system settings instead.
 *
 * The grant is re-read after every request result and on every resume (back from system
 * settings); [onChanged] fires whenever it differs from what the card last showed, so the host
 * refreshes whatever depends on it.
 *
 * With full access the card shows a one-line "allowed" status when [showWhenFull] (Connect) and
 * nothing otherwise (Folders). [partialHint] adds a host-specific line under partial access.
 */
@Composable
internal fun MediaPermissionCard(
    onChanged: (MediaPermissionState) -> Unit,
    showWhenFull: Boolean,
    partialHint: String? = null,
) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val prompts = remember(context) { MediaPermissionPrompts.create(context) }
    val currentOnChanged by rememberUpdatedState(onChanged)

    fun read(): Pair<MediaPermissionState, MediaPermissionAction> {
        val state = MediaPermissions.state(context)
        prompts.observe(state)
        return state to prompts.nextAction(state, MediaPermissions.shouldShowRationale(activity))
    }

    var current by remember { mutableStateOf(read()) }

    fun refresh(notifyAlways: Boolean) {
        val before = current.first
        current = read()
        if (notifyAlways || current.first != before) currentOnChanged(current.first)
    }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        prompts.markAsked()
        refresh(notifyAlways = true)
    }

    // Back from system settings (or anywhere else the grant could change).
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refresh(notifyAlways = false)
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val request = { launcher.launch(MediaPermissions.requestSet().toTypedArray()) }
    val openSettings = { MediaPermissions.openAppSettings(context) }
    val (permission, action) = current

    when (permission) {
        MediaPermissionState.FULL -> if (showWhenFull) {
            SectionCard(title = TITLE) { Text("Access to all photos and videos: allowed.") }
        }
        MediaPermissionState.PARTIAL -> SectionCard(title = TITLE) {
            Text("Only the photos and videos you selected sync.")
            partialHint?.let { Muted(it) }
            Button(onClick = request, modifier = Modifier.fillMaxWidth()) { Text("Allow access to all photos") }
            TextButton(onClick = openSettings) { Text("Open app settings") }
        }
        MediaPermissionState.DENIED -> SectionCard(title = TITLE) {
            if (action == MediaPermissionAction.OPEN_SETTINGS) {
                Text(
                    "Access to photos and videos was denied, and Android no longer asks again. " +
                        "Turn it on in app settings: Permissions → Photos and videos → Allow.",
                )
                Button(onClick = openSettings, modifier = Modifier.fillMaxWidth()) { Text("Open app settings") }
            } else {
                Text("${Brand.name} needs access to your photos and videos to back them up.")
                Button(onClick = request, modifier = Modifier.fillMaxWidth()) { Text("Allow access to photos and videos") }
            }
        }
    }
}

private const val TITLE = "Photos and videos"

/** The hosting activity, for `shouldShowRequestPermissionRationale`; null outside one. */
internal tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
