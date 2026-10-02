package memoriahub.marin.cr.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/** Check-in `networkState` (§6.4): `wifi` (unmetered), `cellular` (metered or mobile), `none`. */
object NetworkState {
    const val WIFI = "wifi"
    const val CELLULAR = "cellular"
    const val NONE = "none"

    /** Pure mapping: [hasInternet] and [notMetered] from the active network's capabilities. */
    fun of(hasNetwork: Boolean, hasInternet: Boolean, notMetered: Boolean): String = when {
        !hasNetwork || !hasInternet -> NONE
        notMetered -> WIFI
        else -> CELLULAR
    }

    fun current(context: Context): String {
        val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return NONE
        val caps = try {
            cm.getNetworkCapabilities(cm.activeNetwork)
        } catch (_: SecurityException) {
            null
        }
        return of(
            hasNetwork = caps != null,
            hasInternet = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true,
            notMetered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true,
        )
    }
}
