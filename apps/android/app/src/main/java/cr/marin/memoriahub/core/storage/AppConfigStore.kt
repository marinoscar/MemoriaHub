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

    /** Synchronous accessor for interceptors. */
    val serverUrl: String? get() = _serverUrl.value

    val targetCircleId: String? get() = _targetCircleId.value

    fun setServerUrl(url: String?) {
        val normalized = url?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
        _serverUrl.value = normalized
    }

    fun setTargetCircleId(circleId: String?) {
        prefs.edit().putString(KEY_TARGET_CIRCLE, circleId).apply()
        _targetCircleId.value = circleId
    }

    /** High-water mark (MediaStore DATE_ADDED, seconds) of the last incremental scan. */
    var lastScanDateAddedSec: Long
        get() = prefs.getLong(KEY_LAST_SCAN_ADDED, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SCAN_ADDED, value).apply()
        }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_TARGET_CIRCLE = "target_circle_id"
        const val KEY_LAST_SCAN_ADDED = "last_scan_date_added_sec"
    }
}
