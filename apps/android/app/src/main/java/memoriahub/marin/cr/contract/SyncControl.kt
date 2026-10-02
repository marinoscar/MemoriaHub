// file: contract/SyncControl.kt   (implemented by #512 as sync/WorkManagerSyncControl)
package memoriahub.marin.cr.contract

import kotlinx.coroutines.flow.StateFlow

enum class NetworkMode { WIFI, ANY }   // wire: 'wifi' | 'any'

data class SyncConfigView(
    val targetCircleId: String?, val folderIds: List<String>, val includePhotos: Boolean, val includeVideos: Boolean,
    val network: NetworkMode, val requireCharging: Boolean, val paused: Boolean, val uploadExisting: String,
    val configVersion: Int, val appliedConfigVersion: Int,
)

data class SyncStatusView(
    val running: Boolean, val currentFile: String?, val bytesSent: Long, val bytesTotal: Long,
    val filesDone: Int, val filesTotal: Int, val lastRunAtMs: Long?, val lastRunStatus: String?, val lastError: String?,
    val lastCheckinAtMs: Long?,
)

interface SyncControl {
    val status: StateFlow<SyncStatusView>
    /** Locally cached desired config (last check-in / PATCH), null before first check-in. */
    fun currentConfig(): SyncConfigView?
    fun syncNow()                          // expedited one-shot, REPLACE
    suspend fun setPaused(paused: Boolean): Result<Unit>        // POST /commands pause|resume then apply locally
    suspend fun retryFailed(): Result<Unit>                       // local ledger retry + POST /commands retry_failed
    suspend fun updateConfig(patch: ConfigPatch): Result<Unit>    // PATCH /devices/:id/config (PAT) then apply locally
    suspend fun checkinNow(): Result<Unit>                        // POST /checkin, apply returned config
    fun isPeriodicScheduled(): Boolean
    fun isContentTriggerArmed(): Boolean
    fun lastContentTriggerAtMs(): Long?
}

data class ConfigPatch(
    val folderIds: List<String>? = null, val includePhotos: Boolean? = null, val includeVideos: Boolean? = null,
    val network: NetworkMode? = null, val requireCharging: Boolean? = null, val uploadExisting: String? = null,
)
