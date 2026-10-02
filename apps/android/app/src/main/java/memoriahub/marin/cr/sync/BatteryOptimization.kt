package memoriahub.marin.cr.sync

import android.content.Context
import android.os.PowerManager

/**
 * Whether the app is exempt from battery optimization (Doze / App Standby / OEM "deep sleep"
 * delay background sync until it is). Reported at check-in as `batteryOptimized = !isIgnoring`
 * (docs/specs/android-media-sync.md §6.4) and used by the `battery.optimization` diagnostic (#514).
 */
object BatteryOptimization {
    fun isIgnoring(context: Context): Boolean {
        val power = context.applicationContext.getSystemService(PowerManager::class.java) ?: return false
        return try {
            power.isIgnoringBatteryOptimizations(context.packageName)
        } catch (_: RuntimeException) {
            false
        }
    }
}
