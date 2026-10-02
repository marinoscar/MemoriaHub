package memoriahub.marin.cr.diagnostics

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.permissions.MediaPermissions
import memoriahub.marin.cr.util.AppInfo
import java.time.ZoneId

/** [DiagnosticsPlatform] over the real phone. */
class AndroidDiagnosticsPlatform(context: Context) : DiagnosticsPlatform {
    private val appContext = context.applicationContext

    override fun appInfo(): AppInfo = AppInfo.read(appContext)

    override fun device() = DeviceSnapshot(
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        androidVersion = Build.VERSION.RELEASE,
        sdkInt = Build.VERSION.SDK_INT,
        timezone = ZoneId.systemDefault().id,
    )

    override fun mediaPermission(): MediaPermissionState = MediaPermissions.state(appContext)

    override fun mediaLocationGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(appContext, MediaPermissions.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

    // Read directly (not through #512's helpers) so the check has no dependency on the sync package.
    override fun isIgnoringBatteryOptimizations(): Boolean? =
        appContext.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(appContext.packageName)

    override fun notificationPermissionGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(appContext, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    override fun notificationsEnabled(): Boolean = NotificationManagerCompat.from(appContext).areNotificationsEnabled()

    override fun onCellularOnly(): Boolean? {
        val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return null
        val caps = cm.getNetworkCapabilities(cm.activeNetwork ?: return null) ?: return null
        val unmetered = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !unmetered
    }

    override fun freeBytes(): Long? = runCatching { StatFs(appContext.filesDir.absolutePath).availableBytes }.getOrNull()
}
