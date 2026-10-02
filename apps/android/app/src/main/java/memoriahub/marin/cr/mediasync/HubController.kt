package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.HealthSummary
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.UpdateStatus
import memoriahub.marin.cr.deeplink.MediaSyncAction
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState

/** Where the Hub's inputs come from (Android in `HubViewModel`, fakes in JVM tests). */
class HubSources(
    val serverUrl: () -> String?,
    val pairing: () -> PairingStatus,
    val stats: suspend () -> SyncStats,
    val permission: () -> MediaPermissionState,
    val conditions: () -> DeviceConditions,
    val circleName: suspend (String) -> String?,
    /** Re-publishes the dynamic launcher shortcuts (Sync now, Pause/Resume). */
    val publishShortcuts: (paired: Boolean, paused: Boolean) -> Unit = { _, _ -> },
    val clock: () -> Long = System::currentTimeMillis,
)

/**
 * The Hub's logic as plain Kotlin (JVM-tested); `HubViewModel` gives it `viewModelScope`.
 *
 * [state] is re-derived (pure [HubState.derive]) whenever the sync status or the health line
 * changes, and on [refresh] (activity resume, pairing changes). Ledger stats are re-read only
 * when the status crosses a run boundary or finishes a file, not on every progress tick.
 * Actions ([setPaused], [syncNow], [runAction]) report through [messages] (snackbar).
 */
class HubController(
    private val control: SyncControl,
    private val health: HealthSummary,
    private val updates: UpdateStatus,
    private val sources: HubSources,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(HubUiState())
    val state: StateFlow<HubUiState> = _state.asStateFlow()

    private val messageChannel = Channel<String>(Channel.BUFFERED)

    /** One-shot snackbar texts. */
    val messages: Flow<String> = messageChannel.receiveAsFlow()

    @Volatile private var stats: SyncStats? = null
    @Volatile private var circleName: String? = null
    @Volatile private var circleNameFor: String? = null

    init {
        scope.launch { control.status.collect { recompute() } }
        scope.launch { health.line.collect { recompute() } }
        scope.launch {
            // Re-read the ledger when a run starts or stops, or a file finishes.
            control.status
                .map { Triple(it.running, it.filesDone, it.lastRunAtMs) }
                .distinctUntilChanged()
                .collect { reloadStats() }
        }
    }

    /** Re-reads everything the Hub shows (pairing, ledger, permission, config) and refreshes health and updates. */
    fun refresh(checkHealthAndUpdates: Boolean = true) {
        scope.launch {
            reloadStats()
            loadCircleName()
            publishShortcuts()
        }
        if (checkHealthAndUpdates) {
            scope.launch { runCatching { health.refresh() } }
            scope.launch { runCatching { updates.checkNow(false) } }
        }
    }

    /** Start syncing / Stop syncing. */
    fun setPaused(paused: Boolean) {
        scope.launch {
            val outcome = MediaSyncActions.run(
                if (paused) MediaSyncAction.PAUSE else MediaSyncAction.RESUME,
                paired = sources.pairing().paired,
                control = control,
            )
            messageChannel.trySend(outcome.message)
            recompute()
            publishShortcuts()
        }
    }

    fun syncNow() = runAction(MediaSyncAction.SYNC)

    /** A deep-link `?action=` (or a shortcut). */
    fun runAction(action: MediaSyncAction) {
        scope.launch {
            val outcome = MediaSyncActions.run(action, paired = sources.pairing().paired, control = control)
            messageChannel.trySend(outcome.message)
            if (action == MediaSyncAction.PAUSE || action == MediaSyncAction.RESUME) publishShortcuts()
            reloadStats()
        }
    }

    private suspend fun reloadStats() {
        stats = runCatching { sources.stats() }.getOrNull() ?: stats
        recompute()
    }

    private suspend fun loadCircleName() {
        val id = control.currentConfig()?.targetCircleId ?: return
        if (id == circleNameFor && circleName != null) return
        if (!sources.pairing().paired) return
        circleName = runCatching { sources.circleName(id) }.getOrNull()
        circleNameFor = id
        recompute()
    }

    private fun publishShortcuts() {
        runCatching { sources.publishShortcuts(sources.pairing().paired, control.currentConfig()?.paused == true) }
    }

    private fun recompute() {
        val config = control.currentConfig()
        _state.value = HubState.derive(
            HubInputs(
                serverUrl = sources.serverUrl(),
                pairing = sources.pairing(),
                stats = stats,
                status = control.status.value,
                config = config,
                permission = sources.permission(),
                conditions = sources.conditions(),
                health = health.line.value,
                circleName = circleName.takeIf { circleNameFor == config?.targetCircleId },
                nowMs = sources.clock(),
            ),
        )
    }
}
