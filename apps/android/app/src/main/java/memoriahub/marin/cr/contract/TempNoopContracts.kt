package memoriahub.marin.cr.contract

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

// TEMP(#513) replaced at merge by #512/#514: no-op implementations so issue #513's screens compile
// and run on a branch without the real WorkManagerSyncControl (#512), DiagnosticsHealth and
// UpdateChecker (#514). Delete this file once MobileApplication wires the real implementations.

/** TEMP(#513): nothing is scheduled; every command fails with "not available yet". */
internal object TempNoopSyncControl : SyncControl {
    private val idle = MutableStateFlow(
        SyncStatusView(
            running = false, currentFile = null, bytesSent = 0, bytesTotal = 0, filesDone = 0, filesTotal = 0,
            lastRunAtMs = null, lastRunStatus = null, lastError = null, lastCheckinAtMs = null,
        ),
    )
    private fun unavailable(): Result<Unit> = Result.failure(IllegalStateException("Background sync is not available in this build yet."))

    override val status: StateFlow<SyncStatusView> = idle.asStateFlow()
    override fun currentConfig(): SyncConfigView? = null
    override fun syncNow() = Unit
    override suspend fun setPaused(paused: Boolean): Result<Unit> = unavailable()
    override suspend fun retryFailed(): Result<Unit> = unavailable()
    override suspend fun updateConfig(patch: ConfigPatch): Result<Unit> = unavailable()
    override suspend fun checkinNow(): Result<Unit> = unavailable()
    override fun isPeriodicScheduled(): Boolean = false
    override fun isContentTriggerArmed(): Boolean = false
    override fun lastContentTriggerAtMs(): Long? = null
}

/** TEMP(#513): no self-test yet, so the Hub shows no health line. */
internal object TempNoopHealthSummary : HealthSummary {
    override val line: StateFlow<HealthLine?> = MutableStateFlow<HealthLine?>(null).asStateFlow()
    override suspend fun refresh() = Unit
}

/** TEMP(#513): never reports an update. */
internal object TempNoopUpdateStatus : UpdateStatus {
    override val available: StateFlow<AvailableUpdate?> = MutableStateFlow<AvailableUpdate?>(null).asStateFlow()
    override suspend fun checkNow(force: Boolean) = Unit
    override suspend fun openDownload(): Result<Unit> = Result.failure(IllegalStateException("Updates are not available in this build yet."))
}
