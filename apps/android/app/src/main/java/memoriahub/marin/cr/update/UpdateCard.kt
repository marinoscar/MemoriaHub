package memoriahub.marin.cr.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import memoriahub.marin.cr.BuildConfig
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.contract.AvailableUpdate
import memoriahub.marin.cr.util.Brand

/**
 * The Hub's update card (§12.3 item 1, §13.6): "MemoriaHub 2.1.0 is available (you have 2.0.0
 * (100))", size and notes, and **Get the update**, which opens a same-origin, short-lived download
 * link in the browser; the system downloads the APK and hands it to the package installer.
 * Renders nothing while no newer release is known ([UpdateChecker.available]).
 */
@Composable
fun UpdateCard(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val status = remember(context) { MobileApplication.from(context).updateStatus }
    val update by status.available.collectAsState()
    update?.let { UpdateCardContent(it, modifier) }
}

@Composable
private fun UpdateCardContent(update: AvailableUpdate, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember(update.releaseId) { mutableStateOf<String?>(null) }
    var showNotes by rememberSaveable { mutableStateOf(false) }

    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Update available", style = MaterialTheme.typography.titleMedium)
            Text(UpdateText.headline(update, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong()))
            UpdatePolicy.formatSize(update.sizeBytes)?.let {
                Text("Download size $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                "Your browser downloads the APK; open it to install (allow installs from this source if Android asks).",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        error = MobileApplication.from(context).updateStatus.openDownload().exceptionOrNull()?.message
                        busy = false
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (busy) "Getting the download…" else "Get the update") }
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error) }
            val notes = update.notes?.trim().orEmpty()
            if (notes.isNotEmpty()) {
                TextButton(onClick = { showNotes = !showNotes }) { Text(if (showNotes) "Hide what's new" else "What's new") }
                if (showNotes) Text(notes, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** Card text (pure, unit-tested). */
object UpdateText {
    fun headline(update: AvailableUpdate, installedName: String, installedCode: Long): String =
        "${Brand.name} ${update.versionName} is available (you have $installedName ($installedCode))."
}

/** Opens [url] with `ACTION_VIEW` in a browser; false when nothing can open it. */
internal fun openInBrowser(context: Context, url: String): Boolean = try {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: ActivityNotFoundException) {
    false
} catch (_: SecurityException) {
    false
}
