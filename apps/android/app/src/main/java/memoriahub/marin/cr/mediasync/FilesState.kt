package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncStats

/** Files screen tabs (docs/specs/android-media-sync.md §12.4) and the ledger states each lists. */
enum class FilesTab(val label: String, val states: Set<SyncFileState>) {
    MISSING(
        "Missing",
        setOf(
            SyncFileState.DISCOVERED, SyncFileState.QUEUED, SyncFileState.HASHING, SyncFileState.UPLOADING,
            SyncFileState.REGISTERING, SyncFileState.FAILED, SyncFileState.BLOCKED,
        ),
    ),
    FAILED("Failed", setOf(SyncFileState.FAILED)),
    BLOCKED("Blocked", setOf(SyncFileState.BLOCKED)),
    SYNCED("Synced", setOf(SyncFileState.UPLOADED, SyncFileState.DEDUPLICATED)),

    /** Every file in scope (`EXCLUDED` rows are files the config does not sync, so they are not listed). */
    ALL("All", SyncFileState.entries.toSet() - SyncFileState.EXCLUDED),
    ;

    /** The tab's badge count, from the same stats as the Hub. */
    fun count(stats: SyncStats): Int = when (this) {
        MISSING -> stats.missing
        FAILED -> stats.failed
        BLOCKED -> stats.blocked
        SYNCED -> stats.synced
        ALL -> stats.eligible
    }
}

enum class ChipKind { NEUTRAL, ACTIVE, SUCCESS, ERROR }

/** One row of the Files list. */
data class FileRowView(
    val id: Long,
    val uri: String,
    val name: String,
    val folder: String,
    val sizeText: String,
    val status: String,
    val chip: ChipKind,
    val isVideo: Boolean,
    val attempts: Int,
    val lastError: String?,
    /** "Next retry in 9 min" for a FAILED row waiting for its backoff. */
    val nextRetry: String?,
    val canRetry: Boolean,
    val isSynced: Boolean,
) {
    val details: String
        get() = listOfNotNull(
            folder.takeIf { it.isNotBlank() },
            sizeText,
            attempts.takeIf { it > 0 }?.let { "${MediaSyncFormat.plural(it, "attempt")}" },
        ).joinToString(" · ")
}

/** Pure row formatting (JVM-tested). */
object FilesPresentation {
    fun statusLabel(state: SyncFileState): Pair<String, ChipKind> = when (state) {
        SyncFileState.DISCOVERED, SyncFileState.QUEUED -> "Waiting" to ChipKind.NEUTRAL
        SyncFileState.HASHING -> "Preparing" to ChipKind.ACTIVE
        SyncFileState.UPLOADING -> "Uploading" to ChipKind.ACTIVE
        SyncFileState.REGISTERING -> "Finishing" to ChipKind.ACTIVE
        SyncFileState.UPLOADED -> "Synced" to ChipKind.SUCCESS
        SyncFileState.DEDUPLICATED -> "Already on server" to ChipKind.SUCCESS
        SyncFileState.FAILED -> "Failed" to ChipKind.ERROR
        SyncFileState.BLOCKED -> "Blocked" to ChipKind.ERROR
        SyncFileState.EXCLUDED -> "Not selected" to ChipKind.NEUTRAL
    }

    fun row(file: SyncFileEntity, nowMs: Long): FileRowView {
        val (label, chip) = statusLabel(file.state)
        val retryAt = file.nextAttemptAt
        return FileRowView(
            id = file.id,
            uri = file.uri,
            name = file.displayName,
            folder = file.relativePath?.trimEnd('/')?.takeIf { it.isNotBlank() } ?: file.bucketName.orEmpty(),
            sizeText = MediaSyncFormat.bytes(file.sizeBytes),
            status = label,
            chip = chip,
            isVideo = file.isVideo,
            attempts = file.attempts,
            lastError = file.lastError?.takeIf { file.state == SyncFileState.FAILED || file.state == SyncFileState.BLOCKED },
            nextRetry = if (file.state == SyncFileState.FAILED && retryAt != null) {
                if (retryAt > nowMs) "Next retry ${MediaSyncFormat.inDuration(retryAt - nowMs)}" else "Retry due now"
            } else {
                null
            },
            canRetry = file.state == SyncFileState.FAILED || file.state == SyncFileState.BLOCKED,
            isSynced = file.state == SyncFileState.UPLOADED || file.state == SyncFileState.DEDUPLICATED,
        )
    }
}

/** The Files screen state. */
data class FilesUiState(
    val loading: Boolean = true,
    val paired: Boolean = false,
    val tab: FilesTab = FilesTab.MISSING,
    val counts: Map<FilesTab, Int> = emptyMap(),
    val rows: List<FileRowView> = emptyList(),
    val limit: Int = FilesController.PAGE,
    val hasMore: Boolean = false,
    val busy: Boolean = false,
    val message: String? = null,
)

/** Ledger reads and writes the Files screen needs (`app.ledger`, a fake in tests). */
interface FilesLedger {
    suspend fun filesIn(states: Collection<SyncFileState>, limit: Int): List<SyncFileEntity>
    suspend fun stats(): SyncStats
    suspend fun retry(id: Long): Boolean
    suspend fun retryBlocked(): Int
}

/**
 * Files logic (JVM-tested): tab queries with "Load more" paging, per-row Retry
 * (`ledger.retry(id)` then Sync now), Retry all failed ([SyncControl.retryFailed], which also
 * tells the server) and Retry blocked (`ledger.retryBlocked()` then Sync now).
 */
class FilesController(
    private val ledger: FilesLedger,
    private val control: SyncControl,
    private val paired: () -> Boolean,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow(FilesUiState())
    val state: StateFlow<FilesUiState> = _state.asStateFlow()

    fun selectTab(tab: FilesTab) {
        _state.update { it.copy(tab = tab, limit = PAGE, rows = emptyList(), loading = true) }
        reload()
    }

    fun loadMore() {
        _state.update { it.copy(limit = it.limit + PAGE) }
        reload()
    }

    fun reload() {
        scope.launch {
            val s = _state.value
            // One extra row tells whether another page exists.
            val files = ledger.filesIn(s.tab.states, s.limit + 1)
            val stats = ledger.stats()
            val now = clock()
            _state.update {
                it.copy(
                    loading = false,
                    paired = paired(),
                    counts = FilesTab.entries.associateWith { t -> t.count(stats) },
                    rows = files.take(s.limit).map { f -> FilesPresentation.row(f, now) },
                    hasMore = files.size > s.limit,
                )
            }
        }
    }

    fun retry(id: Long) = act {
        if (ledger.retry(id)) {
            if (paired()) control.syncNow()
            "Queued for upload"
        } else {
            "This file is no longer waiting for a retry"
        }
    }

    fun retryAllFailed() = act {
        val result = control.retryFailed()
        if (result.isSuccess) {
            control.syncNow()
            "Retrying failed files"
        } else {
            "Could not retry: ${result.exceptionOrNull()?.message ?: "unknown error"}"
        }
    }

    fun retryBlocked() = act {
        val n = ledger.retryBlocked()
        if (n > 0 && paired()) control.syncNow()
        if (n == 0) "No blocked files" else "Retrying ${MediaSyncFormat.plural(n, "blocked file")}"
    }

    fun dismissMessage() = _state.update { it.copy(message = null) }

    private fun act(block: suspend () -> String) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        scope.launch {
            val message = runCatching { block() }.getOrElse { "Failed: ${it.message ?: it.javaClass.simpleName}" }
            _state.update { it.copy(busy = false, message = message) }
            reload()
        }
    }

    companion object {
        const val PAGE = 100
    }
}
