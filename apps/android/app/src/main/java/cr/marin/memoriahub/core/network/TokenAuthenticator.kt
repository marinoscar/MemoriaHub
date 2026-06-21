package cr.marin.memoriahub.core.network

import cr.marin.memoriahub.core.auth.TokenStore
import cr.marin.memoriahub.core.network.dto.ApiEnvelope
import cr.marin.memoriahub.core.network.dto.RefreshResponse
import cr.marin.memoriahub.core.storage.AppConfigStore
import cr.marin.memoriahub.core.util.TimeProvider
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reactively refreshes the access token when the API returns 401.
 *
 * The device flow hands back the refresh token in the JSON body, but the API's
 * `POST /api/auth/refresh` reads it only from an HttpOnly cookie. This authenticator
 * implements the agreed **cookie-replay** strategy: it replays the stored refresh
 * token as a `Cookie: refresh_token=...` header, reads the new access token from the
 * body and the rotated refresh token from `Set-Cookie`, persists both, and retries
 * the original request. If refresh fails, tokens are cleared (forcing re-login).
 *
 * A dedicated bare client (no authenticator) performs the refresh to avoid recursion.
 */
@Singleton
class TokenAuthenticator @Inject constructor(
    private val tokenStore: TokenStore,
    private val appConfigStore: AppConfigStore,
    private val json: Json,
    private val time: TimeProvider,
) : Authenticator {

    private val refreshClient: OkHttpClient by lazy {
        OkHttpClient.Builder().addInterceptor(RetryInterceptor()).build()
    }
    private val lock = Any()

    override fun authenticate(route: Route?, response: Response): Request? {
        if (responseCount(response) >= MAX_REFRESH_ATTEMPTS) return null
        val failedToken = response.request.header("Authorization")?.removePrefix("Bearer ")

        synchronized(lock) {
            // If a concurrent 401 already triggered a refresh, just reuse the new token.
            val current = tokenStore.accessToken
            if (!current.isNullOrEmpty() && current != failedToken) {
                return response.request.newBuilder()
                    .header("Authorization", "Bearer $current")
                    .build()
            }

            val refreshToken = tokenStore.refreshToken
            val serverUrl = appConfigStore.serverUrl
            if (refreshToken.isNullOrEmpty() || serverUrl.isNullOrEmpty()) {
                tokenStore.clear()
                return null
            }

            val refreshed = runCatching { performRefresh(serverUrl, refreshToken) }.getOrNull()
            if (refreshed == null) {
                tokenStore.clear()
                return null
            }

            tokenStore.updateAfterRefresh(
                accessToken = refreshed.accessToken,
                rotatedRefreshToken = refreshed.rotatedRefresh,
                expiresInSeconds = refreshed.expiresIn,
                nowMillis = time.nowMillis(),
            )
            return response.request.newBuilder()
                .header("Authorization", "Bearer ${refreshed.accessToken}")
                .build()
        }
    }

    private fun performRefresh(serverUrl: String, refreshToken: String): Refreshed? {
        val url = serverUrl.trimEnd('/') + "/api/auth/refresh"
        val request = Request.Builder()
            .url(url)
            .post(ByteArray(0).toRequestBody(null))
            .header("Cookie", "refresh_token=$refreshToken")
            .build()

        refreshClient.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val bodyStr = resp.body?.string()?.takeIf { it.isNotBlank() } ?: return null
            val envelope = json.decodeFromString<ApiEnvelope<RefreshResponse>>(bodyStr)
            val rotated = extractRefreshCookie(resp.headers("Set-Cookie"))
            return Refreshed(envelope.data.accessToken, rotated, envelope.data.expiresIn)
        }
    }

    private data class Refreshed(
        val accessToken: String,
        val rotatedRefresh: String?,
        val expiresIn: Long?,
    )

    companion object {
        private const val MAX_REFRESH_ATTEMPTS = 2

        private fun responseCount(response: Response): Int {
            var count = 1
            var prior = response.priorResponse
            while (prior != null) {
                count++
                prior = prior.priorResponse
            }
            return count
        }

        /** Pull the rotated `refresh_token` value out of the Set-Cookie headers. */
        fun extractRefreshCookie(setCookieHeaders: List<String>): String? {
            for (header in setCookieHeaders) {
                val firstPair = header.substringBefore(';').trim()
                if (firstPair.startsWith("refresh_token=")) {
                    val value = firstPair.removePrefix("refresh_token=")
                    if (value.isNotEmpty()) return value
                }
            }
            return null
        }
    }
}
