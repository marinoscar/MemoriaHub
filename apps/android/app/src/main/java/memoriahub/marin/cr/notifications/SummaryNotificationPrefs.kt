package memoriahub.marin.cr.notifications

import android.content.Context
import android.content.SharedPreferences
import memoriahub.marin.cr.BuildConfig

/**
 * Whether to post the low-importance "12 photos backed up to <circle>" notification after a
 * background run that uploaded at least one file (docs/specs/android-media-sync.md §12.5).
 * A phone-local preference, toggled on Network & power (#513); the run summary (#512) reads it.
 */
interface SummaryNotificationSetting {
    var enabled: Boolean
}

/** [SummaryNotificationSetting] in plain prefs `<prefix>_media_sync_ui` (default on). */
class SummaryNotificationPrefs(private val prefs: SharedPreferences) : SummaryNotificationSetting {
    override var enabled: Boolean
        get() = prefs.getBoolean(KEY, true)
        set(value) {
            prefs.edit().putBoolean(KEY, value).apply()
        }

    companion object {
        private const val KEY = "summaryNotifications"

        fun create(context: Context): SummaryNotificationPrefs = SummaryNotificationPrefs(
            context.applicationContext.getSharedPreferences("${BuildConfig.STORAGE_PREFIX}_media_sync_ui", Context.MODE_PRIVATE),
        )
    }
}
