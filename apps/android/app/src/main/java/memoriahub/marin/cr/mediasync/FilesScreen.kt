package memoriahub.marin.cr.mediasync

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.util.Size
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Files (docs/specs/android-media-sync.md §12.4): tabs Missing / Failed / Blocked / Synced / All
 * with counts, a paged list from the ledger (thumbnail, name, folder, size, status, attempts,
 * last error, next retry), per-row Retry, Retry all failed and Retry blocked. Tapping a synced
 * file opens the web gallery (`$server/media`, D20).
 */
@Composable
internal fun FilesScreen(files: FilesController, onOpenSynced: () -> Unit) {
    val state by files.state.collectAsState()
    LaunchedEffect(files) { files.reload() }

    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilesTab.entries.forEach { tab ->
            val count = state.counts[tab]
            FilterChip(
                selected = state.tab == tab,
                onClick = { files.selectTab(tab) },
                label = { Text(if (count == null) tab.label else "${tab.label} ${MediaSyncFormat.count(count)}") },
            )
        }
    }

    SectionCard(title = "Retry") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = files::retryAllFailed, enabled = !state.busy && (state.counts[FilesTab.FAILED] ?: 0) > 0) {
                Text("Retry all failed")
            }
            OutlinedButton(onClick = files::retryBlocked, enabled = !state.busy && (state.counts[FilesTab.BLOCKED] ?: 0) > 0) {
                Text("Retry blocked")
            }
        }
        if (!state.paired) Muted("This phone is not paired: retried files wait until it is.")
        state.message?.let { Muted(it) }
    }

    SectionCard(title = state.tab.label) {
        when {
            state.loading -> Busy("Loading…")
            state.rows.isEmpty() -> Muted(emptyText(state.tab))
            else -> {
                state.rows.forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider()
                    FileRow(row, onRetry = { files.retry(row.id) }, onOpen = onOpenSynced, retryEnabled = !state.busy)
                }
                if (state.hasMore) TextButton(onClick = files::loadMore) { Text("Load more") }
            }
        }
    }
}

private fun emptyText(tab: FilesTab): String = when (tab) {
    FilesTab.MISSING -> "Nothing missing: every selected photo and video is synced."
    FilesTab.FAILED -> "No failed files."
    FilesTab.BLOCKED -> "No blocked files."
    FilesTab.SYNCED -> "Nothing synced yet."
    FilesTab.ALL -> "No files in the selected folders yet."
}

@Composable
private fun FileRow(row: FileRowView, onRetry: () -> Unit, onOpen: () -> Unit, retryEnabled: Boolean) {
    val clickable = if (row.isSynced) Modifier.clickable(onClick = onOpen) else Modifier
    Row(
        modifier = Modifier.fillMaxWidth().then(clickable).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Thumbnail(row.uri)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(row.name, style = MaterialTheme.typography.titleSmall, maxLines = 1)
            Muted(row.details)
            StatusChip(row.status, row.chip)
            row.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            row.nextRetry?.let { Muted(it) }
        }
        if (row.canRetry) TextButton(onClick = onRetry, enabled = retryEnabled) { Text("Retry") }
    }
}

@Composable
private fun StatusChip(label: String, kind: ChipKind) {
    val (bg, fg) = when (kind) {
        ChipKind.SUCCESS -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
        ChipKind.ERROR -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        ChipKind.ACTIVE -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
        ChipKind.NEUTRAL -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(Modifier.clip(RoundedCornerShape(8.dp)).background(bg).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = fg)
    }
}

/** A 56dp thumbnail via `ContentResolver.loadThumbnail` (API 29+); a plain box when unavailable. */
@Composable
private fun Thumbnail(uri: String) {
    val context = LocalContext.current
    val bitmap by produceState<Bitmap?>(initialValue = null, uri) {
        value = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            withContext(Dispatchers.IO) {
                runCatching { context.contentResolver.loadThumbnail(Uri.parse(uri), Size(192, 192), null) }.getOrNull()
            }
        } else {
            null
        }
    }
    val shape = RoundedCornerShape(6.dp)
    val image = bitmap
    if (image != null) {
        Image(
            bitmap = image.asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(56.dp).clip(shape),
        )
    } else {
        Box(Modifier.size(56.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant))
    }
}
