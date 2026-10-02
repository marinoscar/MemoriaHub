package memoriahub.marin.cr.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Body of `POST /api/media-sync/devices` (docs/specs/android-media-sync.md §6.3). The server
 * schema is **strict**: send exactly these keys (null ones are omitted by [ApiClient.ApiJson]).
 */
@Serializable
data class RegisterDeviceRequest(
    val installationId: String,
    val name: String,
    val manufacturer: String? = null,
    val model: String? = null,
    val androidVersion: String? = null,
    val sdkInt: Int? = null,
    val appVersion: String? = null,
    val appVersionCode: Int? = null,
    val packageName: String? = null,
    val signingSha256: String? = null,
    val timezone: String? = null,
)

/**
 * The parts of the server's `DeviceView` the phone reads after registering. The API may add
 * fields at any time (the client ignores unknown keys). [config] is the desired config (§5.1),
 * kept raw here; the config applier (#512) decodes it.
 */
@Serializable
data class MediaSyncDevice(
    val id: String,
    val installationId: String? = null,
    val name: String? = null,
    /** `active` or `revoked`. */
    val status: String? = null,
    val config: JsonObject? = null,
    val configVersion: Int? = null,
    val appliedConfigVersion: Int? = null,
    val tokenExpiresAt: String? = null,
    val latestVersionCode: Int? = null,
    val updateAvailable: Boolean? = null,
)

/** Device registration and unpairing; an interface so pairing is JVM-testable with a fake. */
interface MediaSyncDevicesApi {
    /** `POST /api/media-sync/devices` with the paired PAT: 201 (new) or 200 (same installation re-registered). */
    suspend fun register(request: RegisterDeviceRequest): ApiResult<MediaSyncDevice>

    /** `DELETE /api/media-sync/devices/:id`: revokes the device and its PAT (204). */
    suspend fun unregister(deviceId: String): ApiResult<Unit>
}

class ApiMediaSyncDevicesApi(private val api: ApiClient) : MediaSyncDevicesApi {
    override suspend fun register(request: RegisterDeviceRequest): ApiResult<MediaSyncDevice> =
        api.post(PATH, request, RegisterDeviceRequest.serializer(), MediaSyncDevice.serializer())

    override suspend fun unregister(deviceId: String): ApiResult<Unit> =
        when (val result = api.delete("$PATH/${encodeSegment(deviceId)}")) {
            is ApiResult.Success -> ApiResult.Success(Unit, result.httpStatus)
            is ApiResult.Failure -> result
        }

    companion object {
        const val PATH = "/api/media-sync/devices"

        /** Ids are uuids; encode defensively so a malformed id can never change the route. */
        internal fun encodeSegment(value: String): String =
            java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    }
}

/** `details.reason` values the phone branches on (§17.1). */
object MediaSyncReasons {
    const val DEVICE_REVOKED = "DEVICE_REVOKED"
    const val NO_TARGET_CIRCLE = "NO_TARGET_CIRCLE"
    const val PAT_REQUIRED = "PAT_REQUIRED"
}
