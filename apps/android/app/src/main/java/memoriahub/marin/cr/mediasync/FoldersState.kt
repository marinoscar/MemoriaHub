package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.permissions.MediaPermissionState
import java.io.IOException

/** One row of the Folders checklist. */
data class FolderRow(
    val bucketId: String,
    val name: String,
    val relativePath: String,
    val photoCount: Int,
    val videoCount: Int,
    /** Uploaded + deduplicated files of this folder (the ledger's `perBucket`). */
    val synced: Int,
    /** Files on the phone in this folder (the inventory's photos + videos). */
    val total: Int,
    /** Selected in the config but no longer reported by MediaStore (deleted, or outside a partial grant). */
    val missingOnPhone: Boolean = false,
) {
    val countsText: String get() = MediaSyncFormat.photosAndVideos(photoCount, videoCount)
    val syncedText: String
        get() = if (missingOnPhone) "Not found on this phone" else "Synced ${MediaSyncFormat.count(synced)} of ${MediaSyncFormat.count(total)}"
}

/** Added and removed bucket ids between two selections. */
data class FolderDiff(val added: Set<String>, val removed: Set<String>) {
    val isEmpty: Boolean get() = added.isEmpty() && removed.isEmpty()
}

/** The Folders screen state (docs/specs/android-media-sync.md §12.4). */
data class FoldersUiState(
    val loading: Boolean = true,
    val paired: Boolean = false,
    val hasConfig: Boolean = false,
    val permission: MediaPermissionState = MediaPermissionState.FULL,
    val rows: List<FolderRow> = emptyList(),
    val query: String = "",
    val selected: Set<String> = emptySet(),
    val savedSelection: Set<String> = emptySet(),
    val includePhotos: Boolean = true,
    val includeVideos: Boolean = true,
    val savedIncludePhotos: Boolean = true,
    val savedIncludeVideos: Boolean = true,
    val saving: Boolean = false,
    val message: String? = null,
    val error: String? = null,
) {
    val visibleRows: List<FolderRow> get() = FolderSelection.filter(rows, query)
    val diff: FolderDiff get() = FolderSelection.diff(savedSelection, selected)
    val dirty: Boolean get() = !diff.isEmpty || includePhotos != savedIncludePhotos || includeVideos != savedIncludeVideos
    val canSave: Boolean get() = paired && dirty && !saving

    /** Only the fields that changed; null when nothing did. */
    fun patch(): ConfigPatch? {
        if (!dirty) return null
        return ConfigPatch(
            folderIds = if (diff.isEmpty) null else FolderSelection.ordered(selected, rows),
            includePhotos = includePhotos.takeIf { it != savedIncludePhotos },
            includeVideos = includeVideos.takeIf { it != savedIncludeVideos },
        )
    }
}

/** Pure folder-selection helpers (JVM-tested). */
object FolderSelection {
    /** Inventory rows (most populated first, as MediaStore reports them) plus selected ids MediaStore no longer reports. */
    fun rows(inventory: List<Bucket>, stats: SyncStats, selected: Set<String>): List<FolderRow> {
        val known = inventory.map { b ->
            FolderRow(
                bucketId = b.bucketId,
                name = b.name,
                relativePath = b.relativePath,
                photoCount = b.photoCount,
                videoCount = b.videoCount,
                synced = stats.perBucket[b.bucketId]?.synced ?: 0,
                total = b.photoCount + b.videoCount,
            )
        }
        val knownIds = inventory.map { it.bucketId }.toSet()
        val missing = selected.filter { it !in knownIds }.sorted().map { id ->
            FolderRow(
                bucketId = id, name = "Unknown folder", relativePath = "", photoCount = 0, videoCount = 0,
                synced = stats.perBucket[id]?.synced ?: 0, total = 0, missingOnPhone = true,
            )
        }
        return known + missing
    }

    /** Case-insensitive match on the folder name or its relative path. */
    fun filter(rows: List<FolderRow>, query: String): List<FolderRow> {
        val q = query.trim()
        if (q.isEmpty()) return rows
        return rows.filter { it.name.contains(q, ignoreCase = true) || it.relativePath.contains(q, ignoreCase = true) }
    }

    fun diff(saved: Set<String>, current: Set<String>): FolderDiff = FolderDiff(current - saved, saved - current)

    /** "Select all" over the visible (filtered) rows; folders hidden by the search keep their state. */
    fun selectAll(selected: Set<String>, visible: List<FolderRow>): Set<String> = selected + visible.map { it.bucketId }

    /** "None" over the visible (filtered) rows. */
    fun selectNone(selected: Set<String>, visible: List<FolderRow>): Set<String> = selected - visible.map { it.bucketId }.toSet()

    fun toggle(selected: Set<String>, bucketId: String): Set<String> =
        if (bucketId in selected) selected - bucketId else selected + bucketId

    /** The selection in the checklist's order (stable PATCH bodies). */
    fun ordered(selected: Set<String>, rows: List<FolderRow>): List<String> {
        val order = rows.map { it.bucketId }
        return selected.sortedWith(compareBy({ order.indexOf(it).let { i -> if (i < 0) Int.MAX_VALUE else i } }, { it }))
    }
}

/**
 * The Folders screen's logic as plain Kotlin (JVM-tested); `FoldersViewModel` only supplies the
 * Android-backed functions and `viewModelScope`.
 *
 * Save sends only the changed fields through [SyncControl.updateConfig] (`PATCH /config` with the
 * PAT, then the control applies the returned config locally, which re-evaluates the ledger), then
 * asks for a sync. An [IOException] failure means the phone is offline and the control kept the
 * edit in its outbox (docs/specs/android-media-sync.md §5.2), so the selection counts as saved.
 */
class FoldersController(
    private val control: SyncControl,
    private val paired: () -> Boolean,
    private val permission: () -> MediaPermissionState,
    private val inventory: suspend () -> List<Bucket>,
    private val stats: suspend () -> SyncStats,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(FoldersUiState())
    val state: StateFlow<FoldersUiState> = _state.asStateFlow()

    /** (Re)loads the inventory and the saved config; keeps unsaved edits when [keepEdits]. */
    fun load(keepEdits: Boolean = false) {
        scope.launch {
            val config = control.currentConfig()
            val savedSel = config?.folderIds?.toSet() ?: emptySet()
            val buckets = runCatching { inventory() }.getOrDefault(emptyList())
            val st = runCatching { stats() }.getOrDefault(SyncStats())
            _state.update { s ->
                val edit = keepEdits && s.dirty
                val selected = if (edit) s.selected else savedSel
                s.copy(
                    loading = false,
                    paired = paired(),
                    hasConfig = config != null,
                    permission = permission(),
                    rows = FolderSelection.rows(buckets, st, selected + savedSel),
                    selected = selected,
                    savedSelection = savedSel,
                    includePhotos = if (edit) s.includePhotos else config?.includePhotos ?: true,
                    includeVideos = if (edit) s.includeVideos else config?.includeVideos ?: true,
                    savedIncludePhotos = config?.includePhotos ?: true,
                    savedIncludeVideos = config?.includeVideos ?: true,
                )
            }
        }
    }

    fun setQuery(query: String) = _state.update { it.copy(query = query) }
    fun toggle(bucketId: String) = _state.update { it.copy(selected = FolderSelection.toggle(it.selected, bucketId), message = null) }
    fun selectAll() = _state.update { it.copy(selected = FolderSelection.selectAll(it.selected, it.visibleRows), message = null) }
    fun selectNone() = _state.update { it.copy(selected = FolderSelection.selectNone(it.selected, it.visibleRows), message = null) }
    fun setIncludePhotos(on: Boolean) = _state.update { it.copy(includePhotos = on, message = null) }
    fun setIncludeVideos(on: Boolean) = _state.update { it.copy(includeVideos = on, message = null) }
    fun dismissMessage() = _state.update { it.copy(message = null, error = null) }

    fun save() {
        val current = _state.value
        if (!current.paired) {
            _state.update { it.copy(error = "Pair this phone first.") }
            return
        }
        val patch = current.patch() ?: return
        _state.update { it.copy(saving = true, message = null, error = null) }
        scope.launch {
            val result = control.updateConfig(patch)
            val failure = result.exceptionOrNull()
            when {
                failure == null || failure is IOException -> {
                    if (failure == null) control.syncNow()
                    _state.update { s ->
                        s.copy(
                            saving = false,
                            savedSelection = s.selected,
                            savedIncludePhotos = s.includePhotos,
                            savedIncludeVideos = s.includeVideos,
                            message = if (failure == null) {
                                savedMessage(s)
                            } else {
                                "Saved on this phone. It is sent to the server when the phone is back online."
                            },
                        )
                    }
                }
                else -> _state.update {
                    it.copy(saving = false, error = "Could not save: ${failure.message ?: failure.javaClass.simpleName}")
                }
            }
        }
    }

    private fun savedMessage(s: FoldersUiState): String {
        val n = s.selected.size
        return when {
            n == 0 -> "Saved. No folders are selected, so nothing syncs."
            !s.includePhotos && !s.includeVideos -> "Saved. Photos and videos are both off, so nothing syncs."
            else -> "Saved. Syncing ${MediaSyncFormat.plural(n, "folder")}."
        }
    }
}
