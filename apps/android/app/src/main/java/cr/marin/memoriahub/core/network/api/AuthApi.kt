package cr.marin.memoriahub.core.network.api

import cr.marin.memoriahub.core.network.dto.ApiEnvelope
import cr.marin.memoriahub.core.network.dto.CurrentUser
import cr.marin.memoriahub.core.network.dto.DeviceCodeRequest
import cr.marin.memoriahub.core.network.dto.DeviceCodeResponse
import cr.marin.memoriahub.core.network.dto.DeviceTokenRequest
import cr.marin.memoriahub.core.network.dto.DeviceTokenResponse
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

interface AuthApi {

    /** Used to validate the entered server URL (any 2xx == reachable MemoriaHub API). */
    @GET("api/auth/providers")
    suspend fun getProviders(): Response<ResponseBody>

    @POST("api/auth/device/code")
    suspend fun createDeviceCode(@Body body: DeviceCodeRequest): ApiEnvelope<DeviceCodeResponse>

    /**
     * Polled until approval. Returns a raw [Response] so the caller can branch on
     * the RFC-8628 `error` field carried in non-2xx error bodies.
     */
    @POST("api/auth/device/token")
    suspend fun pollDeviceToken(@Body body: DeviceTokenRequest): Response<ApiEnvelope<DeviceTokenResponse>>

    @GET("api/auth/me")
    suspend fun getMe(): ApiEnvelope<CurrentUser>

    @POST("api/auth/logout")
    suspend fun logout(): Response<Unit>
}
