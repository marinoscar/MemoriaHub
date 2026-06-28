package cr.marin.memoriahub.core.storage

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Non-secret app configuration: the server base URL the user entered on first
 * run, and the circle that camera media syncs into.
 *
 * Backed by [SharedPreferences] (not DataStore) deliberately: OkHttp interceptors
 * run on network threads and need a *synchronous* read of the server URL, which
 * DataStore's suspend/Flow API cannot provide without blocking. Reactive [StateFlow]s
 * are exposed for the UI layer.
 */
@Singleton
class AppConfigStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("app_config", Context.MODE_PRIVATE)

    private val _serverUrl = MutableStateFlow(prefs.getString(KEY_SERVER_URL, null))
    val serverUrlFlow: StateFlow<String?> = _serverUrl.asStateFlow()

    private val _targetCircleId = MutableStateFlow(prefs.getString(KEY_TARGET_CIRCLE, null))
    val targetCircleIdFlow: StateFlow<String?> = _targetCircleId.asStateFlow()

    private val _selectedBucketIds = MutableStateFlow(readSelectedBucketIds())
    /** The MediaStore bucket ids the user chose to back up; `null` until first configured. */
    val selectedBucketIdsFlow: StateFlow<Set<String>?> = _selectedBucketIds.asStateFlow()

    /** Synchronous accessor for interceptors. */
    val serverUrl: String? get() = _serverUrl.value

    val targetCircleId: String? get() = _targetCircleId.value

    /** `null` = never configured (falls back to legacy camera-folder scanning). */
    val selectedBucketIds: Set<String>? get() = _selectedBucketIds.value

    fun setServerUrl(url: String?) {
        val normalized = url?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
        _serverUrl.value = normalized
    }

    fun setTargetCircleId(circleId: String?) {
        prefs.edit().putString(KEY_TARGET_CIRCLE, circleId).apply()
        _targetCircleId.value = circleId
    }

    fun setSelectedBucketIds(ids: Set<String>) {
        // Copy defensively: SharedPreferences must not be handed a mutable set it keeps a
        // reference to, and StateFlow needs a distinct instance to emit.
        val snapshot = ids.toSet()
        prefs.edit().putStringSet(KEY_SELECTED_BUCKETS, snapshot).apply()
        _selectedBucketIds.value = snapshot
    }

    private fun readSelectedBucketIds(): Set<String>? =
        if (prefs.contains(KEY_SELECTED_BUCKETS)) {
            prefs.getStringSet(KEY_SELECTED_BUCKETS, emptySet())?.toSet() ?: emptySet()
        } else {
            null
        }

    /** High-water mark (MediaStore DATE_ADDED, seconds) of the last incremental scan. */
    var lastScanDateAddedSec: Long
        get() = prefs.getLong(KEY_LAST_SCAN_ADDED, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SCAN_ADDED, value).apply()
        }

    /** Stable per-install device id sent as MediaItem provenance; created lazily. */
    val deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, null) ?: java.util.UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_TARGET_CIRCLE = "target_circle_id"
        const val KEY_SELECTED_BUCKETS = "selected_bucket_ids"
        const val KEY_LAST_SCAN_ADDED = "last_scan_date_added_sec"
        const val KEY_DEVICE_ID = "device_id"
    }
}
