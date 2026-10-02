package memoriahub.marin.cr.diagnostics

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PersistableBundle
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.launch
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.deeplink.MediaSyncPath
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.permissions.MediaPermissions
import memoriahub.marin.cr.util.Brand
import java.time.Instant
import java.time.ZoneId

/**
 * Diagnostics (docs/specs/android-media-sync.md §13.3), same layout as evopath's: summary card
 * with pass/warn/fail counts and Run self-test; the checks (fail, warn, pass, skip) each with its
 * fix button; the per-folder inventory; recent local runs; report actions; the live log.
 *
 * Hosted by `MediaSyncActivity` (#513) inside its scrolling screen column and top bar; [onBack]
 * returns to the Hub (also used by the "Set server" fix, whose editor is on the Hub).
 */
@Composable
fun DiagnosticsScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val app = remember(context) { MobileApplication.from(context) }
    val health = app.diagnostics
    val state by health.state.collectAsState()
    val result = state.result
    val scope = rememberCoroutineScope()
    var confirmReset by rememberSaveable { mutableStateOf(false) }
    var rerunOnResume by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        health.runSelfTest(ifOlderThan = DiagnosticsHealth.AUTO_RERUN)
        health.refreshLocal()
    }

    // Back from a settings screen a fix opened: run the self-test again.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && rerunOnResume) {
                rerunOnResume = false
                health.runSelfTest()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (MediaPermissions.state(context) == MediaPermissionState.DENIED) {
            // Permanently denied: the system shows nothing; the user must flip it in app settings.
            rerunOnResume = true
            DiagnosticsIntents.openAppDetails(context)
        } else {
            health.runSelfTest()
        }
    }

    fun perform(action: CheckAction) {
        val server = app.serverConfig.serverUrl
        when (action) {
            CheckAction.SET_SERVER -> onBack()
            CheckAction.REPAIR -> DiagnosticsIntents.openMediaSync(context, MediaSyncPath.CONNECT)
            CheckAction.GRANT_MEDIA -> permissionLauncher.launch(MediaPermissions.requestSet().toTypedArray())
            CheckAction.CHOOSE_FOLDERS -> DiagnosticsIntents.openMediaSync(context, MediaSyncPath.FOLDERS)
            CheckAction.NETWORK_SETTINGS -> DiagnosticsIntents.openMediaSync(context, MediaSyncPath.NETWORK)
            CheckAction.RESUME -> health.resume()
            CheckAction.RETRY_FAILED -> health.retryFailed()
            CheckAction.SYNC_NOW -> health.syncNow()
            CheckAction.BATTERY_SETTINGS -> {
                rerunOnResume = true
                DiagnosticsIntents.openBatterySettings(context)
            }
            CheckAction.NOTIFICATION_SETTINGS -> {
                rerunOnResume = true
                DiagnosticsIntents.openNotificationSettings(context)
            }
            CheckAction.GET_UPDATE -> scope.launch {
                app.updateStatus.checkNow(force = true)
                val opened = app.updateStatus.openDownload()
                health.message(opened.exceptionOrNull()?.message ?: "The download opened in the browser.")
            }
            CheckAction.OPEN_WEB_SETTINGS -> server?.let { DiagnosticsIntents.openWeb(context, "$it$WEB_SETTINGS_PATH") }
            CheckAction.OPEN_ANDROID_APP_ADMIN -> server?.let { DiagnosticsIntents.openWeb(context, "$it$ANDROID_ADMIN_PATH") }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        SummaryCard(state = state, onRun = { health.runSelfTest() })

        if (result != null) {
            Section(title = "Checks") {
                result.checks.sortedBy { severityOrder(it.verdict) }.forEachIndexed { index, check ->
                    if (index > 0) HorizontalDivider()
                    CheckRow(check, onAction = ::perform)
                }
            }
            InventoryCard(result.folders)
        }

        RecentRunsCard(state.runs)

        Section(title = "Actions") {
            Button(onClick = { health.syncNow() }, modifier = Modifier.fillMaxWidth()) { Text("Sync now") }
            OutlinedButton(
                onClick = { health.upload() },
                enabled = state.report != null && !state.uploading,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (state.uploading) "Uploading…" else "Upload report") }
            state.uploadedId?.let { id ->
                Text("Report uploaded (id ${id.take(8)}…).")
                Muted("Your administrator sees it on the web, on this phone's Media sync page.")
                TextButton(onClick = { perform(CheckAction.OPEN_WEB_SETTINGS) }) { Text("Open Media sync settings") }
            }
            state.uploadError?.let { ErrorText(it) }
            OutlinedButton(
                onClick = { state.report?.let { shareReport(context, it.text, result?.generatedAt) } },
                enabled = state.report != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Share report") }
            OutlinedButton(
                onClick = {
                    state.report?.let {
                        copyToClipboard(context, it.text)
                        health.message("Report copied to the clipboard.")
                    }
                },
                enabled = state.report != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Copy to clipboard") }
            OutlinedButton(onClick = { confirmReset = true }, modifier = Modifier.fillMaxWidth()) { Text("Reset local sync state") }
            state.message?.let { Muted(it) }
        }

        LogCard(state.log, onRefresh = { health.refreshLocal() })
    }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("Reset local sync state?") },
            text = {
                Text(
                    "${Brand.name} forgets which files it has seen on this phone and rescans the selected folders on the " +
                        "next sync. Pairing and the run history are kept. Nothing is deleted on the server, and files " +
                        "already there are recognized and not uploaded twice.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmReset = false
                    health.resetLocalSyncState()
                }) { Text("Reset") }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("Cancel") } },
        )
    }
}

private const val WEB_SETTINGS_PATH = "/settings/media-sync"
private const val ANDROID_ADMIN_PATH = "/admin/settings/android"

internal fun severityOrder(status: CheckStatus) = when (status) {
    CheckStatus.FAIL -> 0
    CheckStatus.WARN -> 1
    CheckStatus.PASS -> 2
    CheckStatus.SKIP -> 3
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun Muted(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ErrorText(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
}

@Composable
private fun statusColor(status: CheckStatus): Color = when (status) {
    CheckStatus.PASS -> Color(0xFF2E7D32)
    CheckStatus.WARN -> Color(0xFFB26A00)
    CheckStatus.FAIL -> MaterialTheme.colorScheme.error
    CheckStatus.SKIP -> MaterialTheme.colorScheme.outline
}

private fun statusSymbol(status: CheckStatus) = when (status) {
    CheckStatus.PASS -> "✓"
    CheckStatus.WARN -> "!"
    CheckStatus.FAIL -> "✕"
    CheckStatus.SKIP -> "–"
}

@Composable
private fun StatusIcon(status: CheckStatus) {
    Box(
        modifier = Modifier
            .size(24.dp)
            .background(statusColor(status), CircleShape)
            .semantics { contentDescription = status.wire },
        contentAlignment = Alignment.Center,
    ) {
        Text(statusSymbol(status), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
    }
}

@Composable
private fun SummaryCard(state: DiagnosticsUiState, onRun: () -> Unit) {
    val result = state.result
    Section(title = "Self-test") {
        if (result != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Count(CheckStatus.PASS, result.passCount, "pass")
                Count(CheckStatus.WARN, result.warnCount, "warn")
                Count(CheckStatus.FAIL, result.failCount, "fail")
            }
            Text(result.summary, style = MaterialTheme.typography.bodyLarge)
            Muted("Ran ${Checks.age(result.generatedAt, Instant.now())}.")
        } else if (!state.running) {
            Muted("Not run yet.")
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = onRun, enabled = !state.running) { Text(if (state.running) "Checking…" else "Run self-test") }
            if (state.running) CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        }
    }
}

@Composable
private fun Count(status: CheckStatus, n: Int, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        StatusIcon(status)
        Text("$n $label", style = MaterialTheme.typography.titleSmall)
    }
}

@Composable
private fun CheckRow(check: CheckResult, onAction: (CheckAction) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(vertical = 4.dp)) {
        StatusIcon(check.verdict)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.weight(1f)) {
            Text(check.label, style = MaterialTheme.typography.titleSmall)
            Text(check.detail, style = MaterialTheme.typography.bodyMedium)
            val problem = check.verdict == CheckStatus.FAIL || check.verdict == CheckStatus.WARN
            check.remedy?.takeIf { problem }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic)
            }
            Text(check.id, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, fontFamily = FontFamily.Monospace)
            val action = check.action
            if (action != null && problem) {
                OutlinedButton(onClick = { onAction(action) }) { Text(action.label) }
            }
        }
    }
}

@Composable
private fun InventoryCard(folders: List<FolderInventory>) {
    Section(title = "Folders") {
        if (folders.isEmpty()) Muted("No folder is selected.")
        folders.forEachIndexed { index, f ->
            if (index > 0) HorizontalDivider()
            Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                Text(f.name, style = MaterialTheme.typography.titleSmall)
                if (!f.present) {
                    Text("No longer on this phone.", color = statusColor(CheckStatus.WARN), style = MaterialTheme.typography.bodyMedium)
                } else {
                    Text(InventoryText.line(f), style = MaterialTheme.typography.bodyMedium)
                }
                f.relativePath?.let { Muted(it) }
            }
        }
    }
}

/** Inventory line text (pure). */
internal object InventoryText {
    fun line(f: FolderInventory): String = listOfNotNull(
        "${f.photoCount} photos",
        "${f.videoCount} videos",
        "${f.uploaded}/${f.total} uploaded",
        f.lastFile?.let { "last $it" },
    ).joinToString(" · ")
}

@Composable
private fun RecentRunsCard(runs: List<SyncRunEntity>) {
    val zone = ZoneId.systemDefault()
    Section(title = "Recent runs") {
        if (runs.isEmpty()) Muted("No sync has run on this phone yet.")
        runs.take(DiagnosticsHealth.RECENT_RUNS).forEach { run ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "${Checks.formatTime(Instant.ofEpochMilli(run.finishedAt ?: run.startedAt), zone)} · ${run.trigger} · ${run.status}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Muted("Uploaded ${run.filesUploaded}, already there ${run.filesDeduplicated}, failed ${run.filesFailed}")
                run.errorCode?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable
private fun LogCard(lines: List<String>, onRefresh: () -> Unit) {
    Section(title = "Log") {
        Muted("Last ${lines.size} lines (newest at the bottom). Tokens and signed URLs are never written here.")
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .verticalScroll(rememberScrollState(Int.MAX_VALUE))
                .horizontalScroll(rememberScrollState())
                .padding(8.dp),
        ) {
            SelectionContainer {
                Text(
                    if (lines.isEmpty()) "(empty)" else lines.joinToString("\n"),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    softWrap = false,
                )
            }
        }
        TextButton(onClick = onRefresh) { Text("Refresh log") }
    }
}

private fun shareReport(context: Context, text: String, generatedAt: Instant?) {
    val subject = "${Brand.name} Media sync diagnostics ${generatedAt?.let { Checks.formatTime(it, ZoneId.systemDefault()) }.orEmpty()}".trim()
    val send = Intent(Intent.ACTION_SEND)
        .setType("application/json")
        .putExtra(Intent.EXTRA_SUBJECT, subject)
        .putExtra(Intent.EXTRA_TEXT, text)
    try {
        context.startActivity(Intent.createChooser(send, "Share diagnostics report"))
    } catch (_: ActivityNotFoundException) {
        // Nothing can receive it; Copy remains.
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText("${Brand.name} diagnostics", text)
    // Device and folder details: keep them out of the clipboard preview on Android 13+.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    clipboard.setPrimaryClip(clip)
}

/** Screens a check's fix button opens. Every call is best effort and never throws. */
internal object DiagnosticsIntents {
    private const val REQUEST_IGNORE_BATTERY = "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"

    /** A native Media Sync screen (`<scheme>://media-sync/<path>`), handled by `MediaSyncActivity`. */
    fun openMediaSync(context: Context, path: MediaSyncPath) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(MediaSyncLinks.uri(path))).setPackage(context.packageName)
        tryStart(context, intent)
    }

    /**
     * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (the one-tap system dialog) when the manifest
     * declares its permission; else the battery-optimization list; else the app details page.
     */
    fun openBatterySettings(context: Context) {
        val declared = context.packageManager.checkPermission(REQUEST_IGNORE_BATTERY, context.packageName) == PackageManager.PERMISSION_GRANTED
        if (declared) {
            val request = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
            if (tryStart(context, request)) return
        }
        if (tryStart(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) return
        openAppDetails(context)
    }

    fun openNotificationSettings(context: Context) {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        if (!tryStart(context, intent)) openAppDetails(context)
    }

    fun openAppDetails(context: Context) {
        tryStart(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    /** A web page in a Custom Tab (shares the TWA's cookies, so the user is signed in). */
    fun openWeb(context: Context, url: String) {
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url))
        } catch (_: ActivityNotFoundException) {
            tryStart(context, Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        if (context !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
