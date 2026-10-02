package memoriahub.marin.cr.diagnostics

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.SyncFileDao
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.media.MediaScanner
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiMediaSyncDevicesApi
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevice
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.util.AppInfo

/** The phone, as reported in `device` of a report. */
@Serializable
data class DeviceSnapshot(
    val manufacturer: String? = null,
    val model: String? = null,
    val androidVersion: String? = null,
    val sdkInt: Int = 0,
    val timezone: String? = null,
)

/** Android-only inputs of the self-test ([AndroidDiagnosticsPlatform]; a fake in tests). Any call may throw. */
interface DiagnosticsPlatform {
    fun appInfo(): AppInfo
    fun device(): DeviceSnapshot
    fun mediaPermission(): MediaPermissionState

    /** `ACCESS_MEDIA_LOCATION` granted (meaningless below Android 10). */
    fun mediaLocationGranted(): Boolean

    /** `PowerManager.isIgnoringBatteryOptimizations`, or null if unknown. */
    fun isIgnoringBatteryOptimizations(): Boolean?

    /** `POST_NOTIFICATIONS` granted (always true below Android 13). */
    fun notificationPermissionGranted(): Boolean

    /** Notifications enabled for the app at all. */
    fun notificationsEnabled(): Boolean

    /** The active network is cellular without Wi-Fi or Ethernet; null when unknown or offline. */
    fun onCellularOnly(): Boolean?

    /** Free bytes on the app's data partition, or null. */
    fun freeBytes(): Long?
}

/** Unauthenticated server calls the self-test makes. */
interface ServerProbe {
    /** `GET /api/health/live`. */
    suspend fun live(): ApiResult<JsonElement>

    /** `GET <path>` as text (e.g. `/.well-known/assetlinks.json`). */
    suspend fun text(path: String): ApiResult<String>
}

class ApiServerProbe(private val api: ApiClient) : ServerProbe {
    override suspend fun live() = api.checkLive()
    override suspend fun text(path: String) = api.getText(path)
}

/** Body of `POST /api/media-sync/devices/:id/diagnostics` (§13.3): `summary` ≤500, report ≤256 KB. */
@Serializable
data class UploadDiagnosticsRequest(val summary: String? = null, val report: JsonObject)

@Serializable
data class UploadDiagnosticsResponse(val id: String, val createdAt: String? = null)

/** Authenticated device calls of the self-test and the report upload (PAT). */
interface DiagnosticsApi {
    /** `GET /api/media-sync/devices/:id` (`auth.valid`). */
    suspend fun device(deviceId: String): ApiResult<MediaSyncDevice>

    /** `POST /api/media-sync/devices/:id/diagnostics` → 201 `{ id, createdAt }`. */
    suspend fun uploadReport(deviceId: String, request: UploadDiagnosticsRequest): ApiResult<UploadDiagnosticsResponse>
}

class ApiDiagnosticsApi(private val api: ApiClient) : DiagnosticsApi {
    override suspend fun device(deviceId: String): ApiResult<MediaSyncDevice> =
        api.get(path(deviceId), MediaSyncDevice.serializer())

    override suspend fun uploadReport(deviceId: String, request: UploadDiagnosticsRequest): ApiResult<UploadDiagnosticsResponse> =
        api.post("${path(deviceId)}/diagnostics", request, UploadDiagnosticsRequest.serializer(), UploadDiagnosticsResponse.serializer())

    private fun path(deviceId: String) = "${ApiMediaSyncDevicesApi.PATH}/${ApiMediaSyncDevicesApi.encodeSegment(deviceId)}"
}

/** The ledger and MediaStore reads of the self-test ([LedgerDiagnosticsSource]; a fake in tests). Any call may throw. */
interface DiagnosticsLedger {
    suspend fun stats(): SyncStats
    suspend fun recentRuns(limit: Int): List<SyncRunEntity>

    /** Rows currently `UPLOADING` (`upload.stalled`). */
    suspend fun uploading(): List<SyncFileEntity>

    /** MediaStore buckets with counts (empty without permission). */
    fun inventory(): List<Bucket>

    /** Display name of the most recently uploaded file per `bucketId`. */
    suspend fun lastUploadedNames(): Map<String?, String>
}

class LedgerDiagnosticsSource(
    private val ledger: LedgerRepository,
    private val files: SyncFileDao,
    private val scanner: MediaScanner,
) : DiagnosticsLedger {
    override suspend fun stats(): SyncStats = ledger.stats()
    override suspend fun recentRuns(limit: Int): List<SyncRunEntity> = ledger.recentRuns(limit)
    override suspend fun uploading(): List<SyncFileEntity> = ledger.filesIn(listOf(SyncFileState.UPLOADING), STALL_SCAN)
    override fun inventory(): List<Bucket> = scanner.inventory()

    override suspend fun lastUploadedNames(): Map<String?, String> =
        files.recentInStates(listOf(SyncFileState.UPLOADED.name, SyncFileState.DEDUPLICATED.name), LAST_FILE_SCAN)
            .groupBy { it.bucketId }
            .mapValues { (_, rows) -> rows.first().displayName }

    private companion object {
        const val STALL_SCAN = 500
        const val LAST_FILE_SCAN = 1000
    }
}

/** One selected folder in the Diagnostics inventory card and the report. */
@Serializable
data class FolderInventory(
    val bucketId: String,
    val name: String,
    val relativePath: String? = null,
    val photoCount: Int = 0,
    val videoCount: Int = 0,
    /** Synced (uploaded + deduplicated) rows of this bucket in the ledger. */
    val uploaded: Int = 0,
    /** Eligible rows of this bucket in the ledger. */
    val total: Int = 0,
    val lastFile: String? = null,
    /** False when the bucket is selected but no longer exists on the phone. */
    val present: Boolean = true,
) {
    companion object {
        /** Selected folders, in selection order, joined with MediaStore counts and ledger stats. */
        fun of(
            selected: List<String>,
            inventory: List<Bucket>?,
            stats: SyncStats?,
            lastFiles: Map<String?, String>,
        ): List<FolderInventory> {
            val byId = inventory?.associateBy { it.bucketId }.orEmpty()
            return selected.distinct().map { id ->
                val bucket = byId[id]
                val counts = stats?.perBucket?.get(id)
                FolderInventory(
                    bucketId = id,
                    name = bucket?.name ?: id,
                    relativePath = bucket?.relativePath,
                    photoCount = bucket?.photoCount ?: 0,
                    videoCount = bucket?.videoCount ?: 0,
                    uploaded = counts?.synced ?: 0,
                    total = counts?.eligible ?: 0,
                    lastFile = lastFiles[id],
                    present = inventory == null || bucket != null,
                )
            }
        }
    }
}
