package memoriahub.marin.cr.sync

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.ledger.SyncScope
import memoriahub.marin.cr.net.ApiClient
import java.time.Instant

/** One selected MediaStore bucket of the desired config (`folders[]`, §5.1). */
@Serializable
data class SyncFolder(val bucketId: String, val name: String)

/**
 * The desired config the server holds for this phone (`MediaSyncDevice.config`,
 * docs/specs/android-media-sync.md §5.1). Decoded leniently (unknown keys ignored, missing keys
 * take the server's defaults) so an older app keeps working when the server adds a field.
 */
@Serializable
data class DeviceSyncConfig(
    val targetCircleId: String? = null,
    val folders: List<SyncFolder> = emptyList(),
    val includePhotos: Boolean = true,
    val includeVideos: Boolean = true,
    val network: String = NETWORK_WIFI,
    val requireCharging: Boolean = false,
    val paused: Boolean = false,
    val uploadExisting: String = UPLOAD_ALL,
    val retryFailedGeneration: Long = 0,
    val syncNowGeneration: Long = 0,
) {
    val networkMode: NetworkMode get() = networkModeOf(network)

    /** The ledger scope (§8.3); [pairedAt] is the `from_pairing` cut-off. */
    fun scope(pairedAt: Instant?): SyncScope =
        SyncScope.of(folders.map { it.bucketId }, includePhotos, includeVideos, uploadExisting, pairedAt)

    /** Whether [other] changes which files are in scope (folders, types, `uploadExisting`). */
    fun scopeDiffers(other: DeviceSyncConfig): Boolean =
        folders.map { it.bucketId }.toSet() != other.folders.map { it.bucketId }.toSet() ||
            includePhotos != other.includePhotos || includeVideos != other.includeVideos ||
            uploadExisting != other.uploadExisting

    fun toView(configVersion: Int, appliedConfigVersion: Int): SyncConfigView = SyncConfigView(
        targetCircleId = targetCircleId,
        folderIds = folders.map { it.bucketId },
        includePhotos = includePhotos,
        includeVideos = includeVideos,
        network = networkMode,
        requireCharging = requireCharging,
        paused = paused,
        uploadExisting = uploadExisting,
        configVersion = configVersion,
        appliedConfigVersion = appliedConfigVersion,
    )

    /**
     * [patch] applied locally (an offline edit waiting in the outbox). Folder names come from
     * [names] (the inventory), falling back to the bucket id; the server overwrites them anyway.
     */
    fun withPatch(patch: ConfigPatch, names: Map<String, String> = emptyMap()): DeviceSyncConfig = copy(
        folders = patch.folderIds?.distinct()?.map { id ->
            SyncFolder(id, names[id] ?: folders.firstOrNull { it.bucketId == id }?.name ?: id)
        } ?: folders,
        includePhotos = patch.includePhotos ?: includePhotos,
        includeVideos = patch.includeVideos ?: includeVideos,
        network = patch.network?.let(::wireOf) ?: network,
        requireCharging = patch.requireCharging ?: requireCharging,
        uploadExisting = patch.uploadExisting ?: uploadExisting,
    )

    fun encode(): String = ApiClient.ApiJson.encodeToString(serializer(), this)

    companion object {
        const val NETWORK_WIFI = "wifi"
        const val NETWORK_ANY = "any"
        const val UPLOAD_ALL = "all"
        const val UPLOAD_FROM_PAIRING = "from_pairing"

        fun networkModeOf(wire: String?): NetworkMode = if (wire == NETWORK_ANY) NetworkMode.ANY else NetworkMode.WIFI

        fun wireOf(mode: NetworkMode): String = when (mode) {
            NetworkMode.WIFI -> NETWORK_WIFI
            NetworkMode.ANY -> NETWORK_ANY
        }

        /** Decodes the server's raw `config` object; null when it is not a config at all. */
        fun fromJson(config: JsonObject?): DeviceSyncConfig? =
            config?.let { runCatching { ApiClient.ApiJson.decodeFromJsonElement(serializer(), it) }.getOrNull() }

        fun decode(text: String?): DeviceSyncConfig? =
            text?.let { runCatching { ApiClient.ApiJson.decodeFromString(serializer(), it) }.getOrNull() }
    }
}
