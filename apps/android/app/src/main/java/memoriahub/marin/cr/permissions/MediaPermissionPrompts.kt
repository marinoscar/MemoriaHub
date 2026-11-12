package memoriahub.marin.cr.permissions

import android.content.Context
import android.content.SharedPreferences
import memoriahub.marin.cr.BuildConfig

/**
 * Whether the media-permission dialog was requested before, in plain prefs
 * `<prefix>_permissions`. It disambiguates `shouldShowRequestPermissionRationale == false`,
 * which means both "never asked" and "permanently denied" (see [MediaPermissions.nextAction]).
 *
 * [observe] forgets the flag once access is granted: when the user later revokes it in system
 * settings, Android shows the dialog again, so the button must go back to requesting in place.
 */
class MediaPermissionPrompts(private val prefs: SharedPreferences) {
    val askedBefore: Boolean get() = prefs.getBoolean(KEY_ASKED, false)

    /** Call after a request result arrives (the dialog was shown, or Android skipped it). */
    fun markAsked() {
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
    }

    /** Clears the flag whenever access is no longer denied. */
    fun observe(state: MediaPermissionState) {
        if (state != MediaPermissionState.DENIED && askedBefore) prefs.edit().remove(KEY_ASKED).apply()
    }

    /** [MediaPermissions.nextAction] with the recorded flag. */
    fun nextAction(state: MediaPermissionState, rationale: Boolean): MediaPermissionAction =
        MediaPermissions.nextAction(state, askedBefore, rationale)

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_permissions"
        private const val KEY_ASKED = "mediaPermissionAsked"

        fun create(context: Context): MediaPermissionPrompts =
            MediaPermissionPrompts(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}
