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
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
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
) {
    /**
     * Requests a device code, then polls until the user approves/denies in the
     * browser or the code expires. Honors the server's `interval` and `slow_down`.
     * On success, persists tokens and emits the authenticated user.
     */
    fun authorize(): Flow<DeviceAuthEvent> = flow {
        val code = authApi.createDeviceCode(
            DeviceCodeRequest(
                clientInfo = ClientInfo(
                    deviceName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
                    userAgent = "MemoriaHub-Android/${BuildConfig.VERSION_NAME}",
                ),
            ),
        ).data
        emit(DeviceAuthEvent.CodeReady(code))

        var intervalSeconds = code.interval.coerceAtLeast(1)
        val deadline = time.nowMillis() + code.expiresIn * 1000L

        while (time.nowMillis() < deadline) {
            delay(intervalSeconds * 1000L)

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
}
