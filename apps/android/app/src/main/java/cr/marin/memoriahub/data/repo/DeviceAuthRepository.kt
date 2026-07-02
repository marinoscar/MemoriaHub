package cr.marin.memoriahub.data.repo

import android.os.Build
import cr.marin.memoriahub.BuildConfig
import cr.marin.memoriahub.core.auth.TokenStore
import cr.marin.memoriahub.core.network.api.AuthApi
import cr.marin.memoriahub.core.network.dto.ClientInfo
import cr.marin.memoriahub.core.network.dto.CurrentUser
import cr.marin.memoriahub.core.network.dto.DeviceCodeRequest
import cr.marin.memoriahub.core.network.dto.DeviceCodeResponse
import cr.marin.memoriahub.core.network.dto.DeviceTokenRequest
import cr.marin.memoriahub.core.network.parseApiError
import cr.marin.memoriahub.core.util.TimeProvider
import cr.marin.memoriahub.sync.SyncNotifications
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

/** Events emitted while driving the RFC-8628 device authorization flow. */
sealed interface DeviceAuthEvent {
    data class CodeReady(val code: DeviceCodeResponse) : DeviceAuthEvent
    data class Authorized(val user: CurrentUser) : DeviceAuthEvent
    data class Failed(val message: String) : DeviceAuthEvent
}

@Singleton
class DeviceAuthRepository @Inject constructor(
    private val authApi: AuthApi,
    private val tokenStore: TokenStore,
    private val time: TimeProvider,
    private val json: Json,
    private val notifications: SyncNotifications,
) {
    /**
     * Signals an out-of-band request to poll immediately instead of waiting for the
     * next interval — fired when the app is reopened via the device-complete deep link
     * so authorization is detected the instant the user approves in the browser.
     * Buffered (capacity 1) so a poke that arrives mid-poll is not lost.
     */
    private val pokeFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** Wake any in-flight polling loop to poll right away. Safe to call from any thread. */
    fun pokeNow() {
        pokeFlow.tryEmit(Unit)
    }

    /**
     * Requests a device code, then polls until the user approves/denies in the
     * browser or the code expires. Honors the server's `interval` and `slow_down`,
     * but wakes early when [pokeNow] is called (e.g. on deep-link return).
     * On success, persists tokens and emits the authenticated user.
     */
    fun authorize(): Flow<DeviceAuthEvent> = flow {
        val code = authApi.createDeviceCode(
            DeviceCodeRequest(
                clientInfo = ClientInfo(
                    deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
                    userAgent = "MemoriaHub-Android/${BuildConfig.VERSION_NAME}",
                    returnUri = DEVICE_COMPLETE_DEEP_LINK,
                ),
            ),
        ).data
        emit(DeviceAuthEvent.CodeReady(code))

        var intervalSeconds = code.interval.coerceAtLeast(1)
        val deadline = time.nowMillis() + code.expiresIn * 1000L

        while (time.nowMillis() < deadline) {
            // Wait up to the interval, but return early if a poke arrives.
            withTimeoutOrNull(intervalSeconds * 1000L) { pokeFlow.first() }

            val response = authApi.pollDeviceToken(DeviceTokenRequest(code.deviceCode))
            if (response.isSuccessful) {
                val tokens = response.body()?.data
                if (tokens == null) {
                    emit(DeviceAuthEvent.Failed("Empty token response from server"))
                    return@flow
                }
                tokenStore.saveTokens(
                    accessToken = tokens.accessToken,
                    refreshToken = tokens.refreshToken,
                    expiresInSeconds = tokens.expiresIn,
                    nowMillis = time.nowMillis(),
                )
                // The session is back — any lingering "sign in again" alert is stale.
                runCatching { notifications.cancelSignInRequired() }
                val user = authApi.getMe().data
                emit(DeviceAuthEvent.Authorized(user))
                return@flow
            }

            val apiError = response.parseApiError(json)
            when (apiError?.error) {
                "authorization_pending" -> Unit // keep polling
                "slow_down" -> intervalSeconds += 5
                "access_denied" -> {
                    emit(DeviceAuthEvent.Failed("Authorization was denied"))
                    return@flow
                }
                "expired_token" -> {
                    emit(DeviceAuthEvent.Failed("The code expired. Please try again."))
                    return@flow
                }
                else -> {
                    val msg = apiError?.message
                        ?: apiError?.error
                        ?: "Authorization failed (HTTP ${response.code()})"
                    emit(DeviceAuthEvent.Failed(msg))
                    return@flow
                }
            }
        }
        emit(DeviceAuthEvent.Failed("The code expired. Please try again."))
    }

    companion object {
        /**
         * Deep link the web activation page redirects to after the user approves, to bring
         * this app back to the foreground. Must stay in sync with the `memoriahub`/`auth`
         * intent-filter on MainActivity in AndroidManifest.xml.
         */
        const val DEVICE_COMPLETE_DEEP_LINK = "memoriahub://auth/device-complete"
    }
}
