package memoriahub.marin.cr.mediasync

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp
import memoriahub.marin.cr.permissions.MediaPermissionState

/**
 * Folders (docs/specs/android-media-sync.md §12.4): a checklist of the phone's MediaStore buckets
 * with counts and synced/total, Select all / None, Include photos / videos, Save. Search appears
 * only on a long list ([FoldersPresentation.SEARCH_THRESHOLD]) and never takes focus by itself.
 * Without full access the shared [MediaPermissionCard] requests the permission in place; on a
 * grant the folders reload at once, and [onMediaPermissionChanged] lets the host refresh the rest
 * (the Hub, a sync when paired). The list works unpaired; only Save needs pairing.
 */
@Composable
internal fun FoldersScreen(
    folders: FoldersController,
    onOpenConnect: () -> Unit,
    onMediaPermissionChanged: (MediaPermissionState) -> Unit,
) {
    val state by folders.state.collectAsState()
    val focusManager = LocalFocusManager.current
    LaunchedEffect(folders) { folders.load(keepEdits = true) }
    // Never open on a focused search field with the keyboard up: the screen is a checklist, and a
    // focused text field read as "type your folder names" (#543). Wait one frame so any initial
    // focus the window hands out has landed, then drop it.
    LaunchedEffect(Unit) {
        withFrameNanos { }
        focusManager.clearFocus()
    }

    if (!state.paired) {
        SectionCard(title = "Not paired") {
            ErrorText("Pair this phone first; folder choices are saved to your account.")
            Button(onClick = onOpenConnect, modifier = Modifier.fillMaxWidth()) { Text("Connect") }
        }
    }
    // Renders nothing with full access; requests in place otherwise (shared with Connect).
    MediaPermissionCard(
        onChanged = { permission ->
            folders.load(keepEdits = true)
            onMediaPermissionChanged(permission)
        },
        showWhenFull = false,
        partialHint = "Some folders may be missing from this list.",
    )

    SectionCard(title = "Media types") {
        ToggleRow("Include photos", state.includePhotos, folders::setIncludePhotos)
        ToggleRow("Include videos", state.includeVideos, folders::setIncludeVideos)
    }

    SectionCard(title = "Folders (${state.selected.size} selected)") {
        if (state.showSearch) {
            OutlinedTextField(
                value = state.query,
                onValueChange = folders::setQuery,
                label = { Text("Search folders") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (state.showSelectButtons) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = folders::selectAll, enabled = state.visibleRows.isNotEmpty()) { Text("Select all") }
                TextButton(onClick = folders::selectNone, enabled = state.visibleRows.isNotEmpty()) { Text("None") }
            }
        }
        when {
            state.loading -> Busy("Reading folders…")
            state.rows.isEmpty() -> Muted(state.emptyMessage)
            state.visibleRows.isEmpty() -> Muted("No folder matches \"${state.query}\".")
            else -> state.visibleRows.forEachIndexed { index, row ->
                if (index > 0) HorizontalDivider()
                FolderRowItem(row, checked = row.bucketId in state.selected, onToggle = { folders.toggle(row.bucketId) })
            }
        }
    }

    state.error?.let { ErrorText(it) }
    state.message?.let { Muted(it) }
    Button(onClick = folders::save, enabled = state.canSave, modifier = Modifier.fillMaxWidth()) {
        Text(if (state.saving) "Saving…" else "Save")
    }
    if (state.selected.isEmpty() && !state.loading) Muted("With no folder selected, nothing is uploaded.")
}

@Composable
private fun FolderRowItem(row: FolderRow, checked: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(checked = checked, onCheckedChange = { onToggle() })
        Column(modifier = Modifier.weight(1f)) {
            Text(row.name, style = MaterialTheme.typography.titleSmall)
            if (row.relativePath.isNotBlank()) Muted(row.relativePath)
            if (!row.missingOnPhone) Muted(row.countsText)
            Text(
                row.syncedText,
                style = MaterialTheme.typography.bodySmall,
                color = if (row.missingOnPhone) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
internal fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, description: String? = null) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.titleSmall)
            description?.let { Muted(it) }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
