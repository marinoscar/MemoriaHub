package memoriahub.marin.cr.mediasync

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import kotlinx.serialization.Serializable
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiMediaSyncDevicesApi
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.pairing.ApiErrorReactions
import java.util.concurrent.ConcurrentHashMap

/** Reads the phone's network and charging state for the Hub status line (never throws). */
object DeviceConditionsReader {
    fun read(context: Context): DeviceConditions {
        val (connected, unmetered) = runCatching {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
            val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            online to (online && caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true)
        }.getOrDefault(true to true)
        val charging = runCatching {
            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        }.getOrDefault(false)
        return DeviceConditions(connected = connected, unmetered = unmetered, charging = charging)
    }
}

/**
 * The target circle's display name for the Hub (read-only there; it is changed on the web).
 * `GET /api/circles/:id` with the paired PAT, cached per id for the process. Failures go through
 * [ApiErrorReactions] (401 marks the pairing expired) and fall back to null (the Hub then shows a
 * short id).
 */
class CircleNames(private val api: ApiClient, private val reactions: ApiErrorReactions) {
    @Serializable
    private data class CircleView(val id: String, val name: String? = null)

    private val cache = ConcurrentHashMap<String, String>()

    suspend fun nameOf(circleId: String): String? {
        cache[circleId]?.let { return it }
        return when (val result = api.get("/api/circles/${ApiMediaSyncDevicesApi.encodeSegment(circleId.trim())}", CircleView.serializer())) {
            is ApiResult.Success -> result.value.name?.takeIf { it.isNotBlank() }?.also { cache[circleId] = it }
            is ApiResult.Failure -> {
                reactions.handle(result.error)
                AppLog.d("MediaSync", "circle name unavailable: ${result.error.kind} ${result.error.httpStatus}")
                null
            }
        }
    }
}
