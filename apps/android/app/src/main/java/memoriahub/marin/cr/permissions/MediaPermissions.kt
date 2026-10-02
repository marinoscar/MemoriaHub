package memoriahub.marin.cr.permissions

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/** `permission` reported on check-in (docs/specs/android-media-sync.md §11.2). */
enum class MediaPermissionState(val wire: String) {
    FULL("full"),
    PARTIAL("partial"),
    DENIED("denied"),
}

/**
 * Which media permissions to request and how to read the grant back (§11.1, §11.2). The
 * computation is pure (SDK level + a "granted?" lookup) so every Android version's table row is
 * JVM-tested; [state] / [requestSet] with a `Context` are the thin Android wrappers.
 *
 * The Connect screen (#509) requests these; the ledger's permission handling (vanished detection
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

    fun requestSet(): List<String> = requestSet(Build.VERSION.SDK_INT)

    fun state(context: Context): MediaPermissionState = state(Build.VERSION.SDK_INT) { permission ->
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    /** Whether `POST_NOTIFICATIONS` still needs asking (Android 13+ only). */
    fun notificationsNeedRequest(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
}
