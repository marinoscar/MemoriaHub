package memoriahub.marin.cr.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import memoriahub.marin.cr.ledger.CheckinStats
import memoriahub.marin.cr.ledger.FailedSampleEntry
import memoriahub.marin.cr.media.Bucket

/**
 * Body of `POST /api/media-sync/devices/:id/checkin` (docs/specs/android-media-sync.md §6.4).
 * The server schema is **strict**: exactly these keys; null optional ones are omitted by
 * [ApiClient.ApiJson] (`explicitNulls = false`).
 */
@Serializable
data class CheckinRequest(
    val appliedConfigVersion: Int,
    val stats: CheckinStats,
    /** `full` | `partial` | `denied`. */
    val permission: String,
    /** `wifi` | `cellular` | `none`. */
    val networkState: String,
    /** True when the app is NOT exempt from battery optimization. */
    val batteryOptimized: Boolean,
    /** Sent when the folder list changed or every 24 h (≤500). */
    val inventory: List<Bucket>? = null,
    val appVersion: String? = null,
    val appVersionCode: Int? = null,
    val run: CheckinRun? = null,
)

/** The check-in `run` block: one finished sync pass (§6.4). */
@Serializable
data class CheckinRun(
    /** `SyncTrigger.wire`. */
    val trigger: String,
    /** `ok` | `partial` | `failed` | `skipped` | `paused`. */
    val status: String,
    /** ISO-8601 instants. */
    val startedAt: String,
    val finishedAt: String,
    val filesUploaded: Int,
    val bytesUploaded: Long,
    val filesFailed: Int,
    val filesDeduplicated: Int,
    val errorCode: String? = null,
    val failedSample: List<FailedSampleEntry>? = null,
)

/**
 * `PATCH /api/media-sync/devices/:id/config` body (strict, any subset). `paused` and the
 * generations are commands, never patched. [inventory] (PAT only) lets a freshly selected folder
 * validate in the same request.
 */
@Serializable
data class ConfigPatchRequest(
    val folders: List<FolderRef>? = null,
    val includePhotos: Boolean? = null,
    val includeVideos: Boolean? = null,
    val network: String? = null,
    val requireCharging: Boolean? = null,
    val uploadExisting: String? = null,
    val inventory: List<Bucket>? = null,
)

@Serializable
data class FolderRef(val bucketId: String, val name: String)

@Serializable
data class CommandRequest(val action: String)

/** `{ config, configVersion, serverTime? }`: the response of check-in, PATCH config and commands. */
@Serializable
data class ConfigEnvelope(
    val config: JsonObject,
    val configVersion: Int,
    val serverTime: String? = null,
)

/** `POST /devices/:id/commands` actions (§5.4). */
enum class SyncCommand(val wire: String) {
    PAUSE("pause"),
    RESUME("resume"),
    RETRY_FAILED("retry_failed"),
    SYNC_NOW("sync_now"),
    ;

    companion object {
        fun fromWire(value: String?): SyncCommand? = entries.firstOrNull { it.wire == value }
    }
}

/** Check-in, config edits and commands for this phone's device row; an interface for JVM tests. */
interface MediaSyncCheckinApi {
    /** Only the device's own linked PAT may check in; 409 `DEVICE_REVOKED` once unpaired. */
    suspend fun checkin(deviceId: String, request: CheckinRequest): ApiResult<ConfigEnvelope>

    /** 400 `UNKNOWN_FOLDER` (details.bucketIds), 403 `TARGET_CIRCLE_FORBIDDEN`, 409 `DEVICE_REVOKED`. */
    suspend fun patchConfig(deviceId: String, request: ConfigPatchRequest): ApiResult<ConfigEnvelope>

    suspend fun command(deviceId: String, command: SyncCommand): ApiResult<ConfigEnvelope>
}

class ApiMediaSyncCheckinApi(private val api: ApiClient) : MediaSyncCheckinApi {
    override suspend fun checkin(deviceId: String, request: CheckinRequest): ApiResult<ConfigEnvelope> =
        api.post(path(deviceId, "checkin"), request, CheckinRequest.serializer(), ConfigEnvelope.serializer())

    override suspend fun patchConfig(deviceId: String, request: ConfigPatchRequest): ApiResult<ConfigEnvelope> =
        api.patch(path(deviceId, "config"), request, ConfigPatchRequest.serializer(), ConfigEnvelope.serializer())

    override suspend fun command(deviceId: String, command: SyncCommand): ApiResult<ConfigEnvelope> =
        api.post(path(deviceId, "commands"), CommandRequest(command.wire), CommandRequest.serializer(), ConfigEnvelope.serializer())

    private fun path(deviceId: String, leaf: String) =
        "${ApiMediaSyncDevicesApi.PATH}/${ApiMediaSyncDevicesApi.encodeSegment(deviceId)}/$leaf"
}
