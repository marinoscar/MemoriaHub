package memoriahub.marin.cr.testing

import kotlinx.coroutines.flow.MutableStateFlow
import memoriahub.marin.cr.contract.AvailableUpdate
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.HealthLine
import memoriahub.marin.cr.contract.HealthSummary
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.contract.UpdateStatus

val idleStatus = SyncStatusView(
    running = false, currentFile = null, bytesSent = 0, bytesTotal = 0, filesDone = 0, filesTotal = 0,
    lastRunAtMs = null, lastRunStatus = null, lastError = null, lastCheckinAtMs = null,
)

fun syncConfig(
    folderIds: List<String> = listOf("camera"),
    network: NetworkMode = NetworkMode.WIFI,
    requireCharging: Boolean = false,
    paused: Boolean = false,
    uploadExisting: String = "all",
    includePhotos: Boolean = true,
    includeVideos: Boolean = true,
    targetCircleId: String? = "c0ffee00-0000-0000-0000-000000000001",
) = SyncConfigView(
    targetCircleId = targetCircleId, folderIds = folderIds, includePhotos = includePhotos, includeVideos = includeVideos,
    network = network, requireCharging = requireCharging, paused = paused, uploadExisting = uploadExisting,
    configVersion = 3, appliedConfigVersion = 3,
)

/** Records every [SyncControl] call; results are configurable per test. (#512's real implementation is WorkManager.) */
class RecordingSyncControl(var config: SyncConfigView? = syncConfig()) : SyncControl {
    override val status = MutableStateFlow(idleStatus)
    val calls = mutableListOf<String>()
    val patches = mutableListOf<ConfigPatch>()
    var result: Result<Unit> = Result.success(Unit)

    override fun currentConfig(): SyncConfigView? = config
    override fun syncNow() { calls += "syncNow" }
    override suspend fun setPaused(paused: Boolean): Result<Unit> {
        calls += "setPaused($paused)"
        if (result.isSuccess) config = config?.copy(paused = paused)
        return result
    }
    override suspend fun retryFailed(): Result<Unit> { calls += "retryFailed"; return result }
    override suspend fun updateConfig(patch: ConfigPatch): Result<Unit> { calls += "updateConfig"; patches += patch; return result }
    override suspend fun checkinNow(): Result<Unit> { calls += "checkinNow"; return result }
    override fun isPeriodicScheduled() = true
    override fun isContentTriggerArmed() = true
    override fun lastContentTriggerAtMs(): Long? = null
}

class FakeHealthSummary(initial: HealthLine? = null) : HealthSummary {
    override val line = MutableStateFlow(initial)
    var refreshes = 0
    override suspend fun refresh() { refreshes++ }
}

class FakeUpdateStatus : UpdateStatus {
    override val available = MutableStateFlow<AvailableUpdate?>(null)
    var checks = 0
    override suspend fun checkNow(force: Boolean) { checks++ }
    override suspend fun openDownload(): Result<Unit> = Result.success(Unit)
}
