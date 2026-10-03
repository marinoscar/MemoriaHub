package memoriahub.marin.cr.permissions

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/** `permission` reported on check-in (docs/specs/android-media-sync.md §11.2). */
enum class MediaPermissionState(val wire: String) {
    FULL("full"),
    PARTIAL("partial"),
    DENIED("denied"),
}

/**
 * What the media-permission button does next (docs/specs/android-media-sync.md §11.1, §12.4):
 * nothing (full access), show the system dialog in place, or open the app's system settings page
 * because Android no longer shows the dialog (permanently denied).
 */
enum class MediaPermissionAction {
    NONE,
    REQUEST,
    OPEN_SETTINGS,
}

/**
 * Which media permissions to request and how to read the grant back (§11.1, §11.2). The
 * computation is pure (SDK level + a "granted?" lookup) so every Android version's table row is
 * JVM-tested; [state] / [requestSet] with a `Context` are the thin Android wrappers.
 *
 * The shared `MediaPermissionCard` (Connect and Folders) requests these; the ledger's permission handling (vanished detection
 * off under `partial`, `skipped` runs under `denied`) is #510/#512.
 */
object MediaPermissions {
    /** Android 14+ "Select photos and videos" grant (string literal: available at compile SDK 34+ only as a constant). */
    const val READ_MEDIA_VISUAL_USER_SELECTED = "android.permission.READ_MEDIA_VISUAL_USER_SELECTED"
    const val READ_MEDIA_IMAGES = "android.permission.READ_MEDIA_IMAGES"
    const val READ_MEDIA_VIDEO = "android.permission.READ_MEDIA_VIDEO"
    const val READ_EXTERNAL_STORAGE = Manifest.permission.READ_EXTERNAL_STORAGE
    const val ACCESS_MEDIA_LOCATION = "android.permission.ACCESS_MEDIA_LOCATION"

    /** The runtime permissions to request together, for [sdkInt]. `ACCESS_MEDIA_LOCATION` rides along (API 29+). */
    fun requestSet(sdkInt: Int): List<String> = buildList {
        when {
            sdkInt >= 34 -> addAll(listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_MEDIA_VISUAL_USER_SELECTED))
            sdkInt >= 33 -> addAll(listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO))
            else -> add(READ_EXTERNAL_STORAGE)
        }
        if (sdkInt >= 29) add(ACCESS_MEDIA_LOCATION)
    }

    fun state(sdkInt: Int, granted: (String) -> Boolean): MediaPermissionState {
        if (sdkInt >= 33) {
            val images = granted(READ_MEDIA_IMAGES)
            val video = granted(READ_MEDIA_VIDEO)
            return when {
                images && video -> MediaPermissionState.FULL
                images || video -> MediaPermissionState.PARTIAL
                sdkInt >= 34 && granted(READ_MEDIA_VISUAL_USER_SELECTED) -> MediaPermissionState.PARTIAL
                else -> MediaPermissionState.DENIED
            }
        }
        return if (granted(READ_EXTERNAL_STORAGE)) MediaPermissionState.FULL else MediaPermissionState.DENIED
    }

    /**
     * The permissions whose `shouldShowRequestPermissionRationale` tells "permanently denied"
     * apart: the visual ones only. `ACCESS_MEDIA_LOCATION` has no dialog of its own and
     * `READ_MEDIA_VISUAL_USER_SELECTED` is the partial grant, so neither decides it.
     */
    fun rationaleSet(sdkInt: Int): List<String> =
        if (sdkInt >= 33) listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO) else listOf(READ_EXTERNAL_STORAGE)

    /**
     * The next action for the permission button. Android stops showing the dialog after the user
     * denies it (twice on Android 11+, or "Don't ask again" before), and the only signal is that
     * the rationale flag is false while access is still denied. The flag is also false before the
     * very first request, which is why [askedBefore] (recorded by [MediaPermissionPrompts]) is
     * needed: without it the first tap would wrongly go to settings.
     *
     * PARTIAL always requests again: Android 14+ re-shows the picker for a partial grant, and the
     * card offers app settings next to it.
     */
    fun nextAction(state: MediaPermissionState, askedBefore: Boolean, rationale: Boolean): MediaPermissionAction = when (state) {
        MediaPermissionState.FULL -> MediaPermissionAction.NONE
        MediaPermissionState.PARTIAL -> MediaPermissionAction.REQUEST
        MediaPermissionState.DENIED ->
            if (askedBefore && !rationale) MediaPermissionAction.OPEN_SETTINGS else MediaPermissionAction.REQUEST
    }

    fun requestSet(): List<String> = requestSet(Build.VERSION.SDK_INT)

    /** Whether Android would show a rationale for any of [rationaleSet] (false without an activity). */
    fun shouldShowRationale(activity: Activity?): Boolean =
        activity != null && rationaleSet(Build.VERSION.SDK_INT).any { ActivityCompat.shouldShowRequestPermissionRationale(activity, it) }

    /** The app's system settings page, where a permanently denied permission is turned back on. */
    fun openAppSettings(context: Context) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            // No settings app (some locked-down builds): nothing more we can do.
        }
    }

    fun state(context: Context): MediaPermissionState = state(Build.VERSION.SDK_INT) { permission ->
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    /** Whether `POST_NOTIFICATIONS` still needs asking (Android 13+ only). */
    fun notificationsNeedRequest(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
}
