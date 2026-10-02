package memoriahub.marin.cr.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * Whether uploads may run on the network the phone is using right now, re-checked by the engine
 * before every file and every part (docs/specs/android-media-sync.md §9.1 step 4). A `false`
 * stops the run at the next part boundary with [UploadStopReason.NETWORK_POLICY]; the file keeps
 * its state and parts and no attempt is counted (T8).
 */
fun interface NetworkPolicy {
    fun allowsUpload(): Boolean

    companion object {
        /** Tests and "network: any" with no connectivity check. */
        val ALWAYS: NetworkPolicy = NetworkPolicy { true }
    }
}

/** Config value of `network` (§5.1). */
enum class NetworkPreference(val wire: String) {
    WIFI("wifi"),
    ANY("any"),
    ;

    companion object {
        fun fromWire(value: String?): NetworkPreference = entries.firstOrNull { it.wire == value } ?: WIFI
    }
}

/**
 * [NetworkPolicy] over the active network. Under [NetworkPreference.WIFI] an upload needs an
 * unmetered network (`NET_CAPABILITY_NOT_METERED`, which also covers unmetered Ethernet); under
 * [NetworkPreference.ANY] any validated-or-not connection with internet is enough. No active
 * network never allows an upload. [preference] is read on every check so a config change made
 * mid-run (or the network switching) takes effect at the next part.
 */
class AndroidNetworkPolicy(
    context: Context,
    private val preference: () -> NetworkPreference,
) : NetworkPolicy {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    override fun allowsUpload(): Boolean {
        val cm = connectivity ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
        return when (preference()) {
            NetworkPreference.ANY -> true
            NetworkPreference.WIFI -> caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
    }
}
