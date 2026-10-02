package memoriahub.marin.cr.sync

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import memoriahub.marin.cr.BuildConfig
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.net.ApiClient

/**
 * One pending local edit (the outbox, docs/specs/android-media-sync.md §5.2, D7): a command
 * (`pause`, `resume`, `retry_failed`, `sync_now`) or a config patch, replayed through
 * `POST /commands` / `PATCH /config` **before** the next check-in. Never carried in the check-in.
 */
@Serializable
data class OutboxEntry(
    /** [memoriahub.marin.cr.net.SyncCommand.wire], or null for a config patch. */
    val command: String? = null,
    val patch: StoredPatch? = null,
)

/** A [memoriahub.marin.cr.contract.ConfigPatch] in a serializable form (network as its wire value). */
@Serializable
data class StoredPatch(
    val folderIds: List<String>? = null,
    val includePhotos: Boolean? = null,
    val includeVideos: Boolean? = null,
    val network: String? = null,
    val requireCharging: Boolean? = null,
    val uploadExisting: String? = null,
)

fun StoredPatch.toConfigPatch(): ConfigPatch = ConfigPatch(
    folderIds = folderIds,
    includePhotos = includePhotos,
    includeVideos = includeVideos,
    network = network?.let(DeviceSyncConfig::networkModeOf),
    requireCharging = requireCharging,
    uploadExisting = uploadExisting,
)

fun ConfigPatch.toStored(): StoredPatch = StoredPatch(
    folderIds = folderIds,
    includePhotos = includePhotos,
    includeVideos = includeVideos,
    network = network?.let(DeviceSyncConfig::wireOf),
    requireCharging = requireCharging,
    uploadExisting = uploadExisting,
)

/** The last finished run as shown by the Hub (also in the ledger's `sync_runs`). */
data class LastRun(val atMs: Long, val status: String, val error: String?)

/**
 * The phone's Media Sync state that is not the file ledger: the cached desired config, the
 * applied versions and generations, the outbox, and the throttling clocks. Behind an interface so
 * the config applier, the check-in and the control are JVM-tested with [InMemorySyncStateStore].
 *
 * Every value belongs to [deviceId]: when the paired device changes (re-pair as a new device),
 * [resetFor] forgets everything so the new device's `configVersion = 1` is applied.
 */
interface SyncStateStore {
    /** The device row this state belongs to. */
    var deviceId: String?

    /** The last config received from the server (raw JSON of [DeviceSyncConfig]). */
    var config: DeviceSyncConfig?
    var configVersion: Int
    var appliedConfigVersion: Int

    /** Last applied command generations; null before the first apply (that apply only adopts them). */
    var appliedRetryGeneration: Long?
    var appliedSyncNowGeneration: Long?

    var outbox: List<OutboxEntry>

    var lastCheckinAtMs: Long?
    var inventoryHash: String?
    var inventorySentAtMs: Long?
    var lastAppOpenAtMs: Long?
    var constraintsHash: String?
    var lastContentTriggerAtMs: Long?
    var permissionNotifiedAtMs: Long?
    var lastRun: LastRun?

    /** Post a "N photos backed up" notification after a background run (§12.5; #513's toggle). */
    var summaryNotifications: Boolean

    /** Forgets everything bound to the previous device, keeping [summaryNotifications]. */
    fun resetFor(deviceId: String?) {
        this.deviceId = deviceId
        config = null
        configVersion = 0
        appliedConfigVersion = 0
        appliedRetryGeneration = null
        appliedSyncNowGeneration = null
        outbox = emptyList()
        lastCheckinAtMs = null
        inventoryHash = null
        inventorySentAtMs = null
        constraintsHash = null
        lastRun = null
    }

    /** [resetFor] when the stored state belongs to another device than [current]. */
    fun bindTo(current: String?) {
        if (current != null && deviceId != current) resetFor(current)
    }
}

class InMemorySyncStateStore : SyncStateStore {
    override var deviceId: String? = null
    override var config: DeviceSyncConfig? = null
    override var configVersion: Int = 0
    override var appliedConfigVersion: Int = 0
    override var appliedRetryGeneration: Long? = null
    override var appliedSyncNowGeneration: Long? = null
    override var outbox: List<OutboxEntry> = emptyList()
    override var lastCheckinAtMs: Long? = null
    override var inventoryHash: String? = null
    override var inventorySentAtMs: Long? = null
    override var lastAppOpenAtMs: Long? = null
    override var constraintsHash: String? = null
    override var lastContentTriggerAtMs: Long? = null
    override var permissionNotifiedAtMs: Long? = null
    override var lastRun: LastRun? = null
    override var summaryNotifications: Boolean = true
}

/** [SyncStateStore] in plain prefs `<prefix>_media_sync` (excluded from backup like every prefs file). */
class SharedPrefsSyncStateStore(private val prefs: SharedPreferences) : SyncStateStore {
    override var deviceId: String?
        get() = prefs.getString(K_DEVICE, null)
        set(value) = putString(K_DEVICE, value)

    override var config: DeviceSyncConfig?
        get() = DeviceSyncConfig.decode(prefs.getString(K_CONFIG, null))
        set(value) = putString(K_CONFIG, value?.encode())

    override var configVersion: Int
        get() = prefs.getInt(K_VERSION, 0)
        set(value) {
            prefs.edit().putInt(K_VERSION, value).commit()
        }

    override var appliedConfigVersion: Int
        get() = prefs.getInt(K_APPLIED_VERSION, 0)
        set(value) {
            prefs.edit().putInt(K_APPLIED_VERSION, value).commit()
        }

    override var appliedRetryGeneration: Long? by optionalLong(K_RETRY_GEN)
    override var appliedSyncNowGeneration: Long? by optionalLong(K_SYNC_GEN)

    override var outbox: List<OutboxEntry>
        get() = prefs.getString(K_OUTBOX, null)?.let {
            runCatching { ApiClient.ApiJson.decodeFromString(OUTBOX, it) }.getOrNull()
        } ?: emptyList()
        set(value) = putString(K_OUTBOX, if (value.isEmpty()) null else ApiClient.ApiJson.encodeToString(OUTBOX, value))

    override var lastCheckinAtMs: Long? by optionalLong(K_CHECKIN_AT)

    override var inventoryHash: String?
        get() = prefs.getString(K_INVENTORY_HASH, null)
        set(value) = putString(K_INVENTORY_HASH, value)

    override var inventorySentAtMs: Long? by optionalLong(K_INVENTORY_AT)
    override var lastAppOpenAtMs: Long? by optionalLong(K_APP_OPEN_AT)

    override var constraintsHash: String?
        get() = prefs.getString(K_CONSTRAINTS, null)
        set(value) = putString(K_CONSTRAINTS, value)

    override var lastContentTriggerAtMs: Long? by optionalLong(K_TRIGGER_AT)
    override var permissionNotifiedAtMs: Long? by optionalLong(K_PERMISSION_NOTIFIED_AT)

    override var lastRun: LastRun?
        get() {
            val at = prefs.getLong(K_RUN_AT, -1L).takeIf { it >= 0 } ?: return null
            val status = prefs.getString(K_RUN_STATUS, null) ?: return null
            return LastRun(at, status, prefs.getString(K_RUN_ERROR, null))
        }
        set(value) {
            prefs.edit().apply {
                if (value == null) {
                    remove(K_RUN_AT); remove(K_RUN_STATUS); remove(K_RUN_ERROR)
                } else {
                    putLong(K_RUN_AT, value.atMs); putString(K_RUN_STATUS, value.status)
                    if (value.error != null) putString(K_RUN_ERROR, value.error) else remove(K_RUN_ERROR)
                }
            }.commit()
        }

    override var summaryNotifications: Boolean
        get() = prefs.getBoolean(K_SUMMARY, true)
        set(value) {
            prefs.edit().putBoolean(K_SUMMARY, value).commit()
        }

    private fun putString(key: String, value: String?) {
        prefs.edit().apply { if (value != null) putString(key, value) else remove(key) }.commit()
    }

    private fun optionalLong(key: String) = object : kotlin.properties.ReadWriteProperty<Any?, Long?> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): Long? =
            if (prefs.contains(key)) prefs.getLong(key, 0L) else null

        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: Long?) {
            prefs.edit().apply { if (value != null) putLong(key, value) else remove(key) }.commit()
        }
    }

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_media_sync"
        private val OUTBOX = ListSerializer(OutboxEntry.serializer())
        private const val K_DEVICE = "device_id"
        private const val K_CONFIG = "config"
        private const val K_VERSION = "config_version"
        private const val K_APPLIED_VERSION = "applied_config_version"
        private const val K_RETRY_GEN = "applied_retry_generation"
        private const val K_SYNC_GEN = "applied_sync_now_generation"
        private const val K_OUTBOX = "outbox"
        private const val K_CHECKIN_AT = "last_checkin_at"
        private const val K_INVENTORY_HASH = "inventory_hash"
        private const val K_INVENTORY_AT = "inventory_sent_at"
        private const val K_APP_OPEN_AT = "last_app_open_at"
        private const val K_CONSTRAINTS = "constraints_hash"
        private const val K_TRIGGER_AT = "last_content_trigger_at"
        private const val K_PERMISSION_NOTIFIED_AT = "permission_notified_at"
        private const val K_RUN_AT = "last_run_at"
        private const val K_RUN_STATUS = "last_run_status"
        private const val K_RUN_ERROR = "last_run_error"
        private const val K_SUMMARY = "summary_notifications"

        fun create(context: Context): SyncStateStore =
            SharedPrefsSyncStateStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}
