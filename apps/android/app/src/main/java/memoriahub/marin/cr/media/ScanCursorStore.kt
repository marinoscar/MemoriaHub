package memoriahub.marin.cr.media

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import memoriahub.marin.cr.BuildConfig

/** Persisted incremental-scan position of one volume. */
@Serializable
data class VolumeCursor(
    /** Generation captured before the last completed scan (API 30+). */
    val generation: Long? = null,
    /** Wall clock (epoch s) captured before the last completed scan (the below-API-30 fallback). */
    val dateModifiedSec: Long? = null,
    /** `MediaStore.getVersion` at that scan; a change means generations were reset. */
    val mediaStoreVersion: String? = null,
)

/** What the last completed scan covered: widening it (new bucket, newly included type) forces a full scan. */
@Serializable
data class ScannedScope(
    val buckets: Set<String> = emptySet(),
    val includePhotos: Boolean = false,
    val includeVideos: Boolean = false,
) {
    /** Whether [next] asks for rows this scope never looked at. */
    fun isWidenedBy(next: ScannedScope): Boolean =
        !buckets.containsAll(next.buckets) ||
            (next.includePhotos && !includePhotos) ||
            (next.includeVideos && !includeVideos)
}

/** Scan cursors (per volume), the last full-scan time and the scanned scope (§8.1: stored beside the ledger). */
interface ScanCursorStore {
    fun cursor(volume: String): VolumeCursor?
    fun setCursor(volume: String, cursor: VolumeCursor)
    var lastFullScanAtMs: Long?
    var scannedScope: ScannedScope?

    /** `resetLocalState`: forget everything so the next scan is full. */
    fun clear()
}

class SharedPrefsScanCursorStore(private val prefs: SharedPreferences) : ScanCursorStore {
    private val json = Json { ignoreUnknownKeys = true }

    override fun cursor(volume: String): VolumeCursor? =
        prefs.getString(KEY_CURSOR_PREFIX + volume, null)?.let { runCatching { json.decodeFromString(VolumeCursor.serializer(), it) }.getOrNull() }

    override fun setCursor(volume: String, cursor: VolumeCursor) {
        prefs.edit().putString(KEY_CURSOR_PREFIX + volume, json.encodeToString(VolumeCursor.serializer(), cursor)).commit()
    }

    override var lastFullScanAtMs: Long?
        get() = if (prefs.contains(KEY_LAST_FULL)) prefs.getLong(KEY_LAST_FULL, 0L) else null
        set(value) {
            prefs.edit().apply { if (value != null) putLong(KEY_LAST_FULL, value) else remove(KEY_LAST_FULL) }.commit()
        }

    override var scannedScope: ScannedScope?
        get() = prefs.getString(KEY_SCOPE, null)?.let { runCatching { json.decodeFromString(ScannedScope.serializer(), it) }.getOrNull() }
        set(value) {
            prefs.edit().apply {
                if (value != null) putString(KEY_SCOPE, json.encodeToString(ScannedScope.serializer(), value)) else remove(KEY_SCOPE)
            }.commit()
        }

    override fun clear() {
        prefs.edit().clear().commit()
    }

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_media_scan"
        private const val KEY_CURSOR_PREFIX = "cursor."
        private const val KEY_LAST_FULL = "last_full_scan_at"
        private const val KEY_SCOPE = "scanned_scope"

        fun create(context: Context): ScanCursorStore =
            SharedPrefsScanCursorStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}
