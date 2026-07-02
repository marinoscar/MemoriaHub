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
 * the original request.
 *
 * Refresh failures are classified: only a **terminal** rejection (401/403 — the
 * refresh token is invalid, expired, or revoked) clears the session and forces
 * re-login. **Transient** failures (network errors, 5xx) keep the stored tokens —
 * the in-flight request fails, background work retries later with backoff, and the
 * session survives server outages.
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
                // Nothing to ever refresh with — the session is unrecoverable.
                tokenStore.clear()
                return null
            }

            return when (val outcome = performRefresh(serverUrl, refreshToken)) {
                is RefreshOutcome.Success -> {
                    tokenStore.updateAfterRefresh(
                        accessToken = outcome.accessToken,
                        rotatedRefreshToken = outcome.rotatedRefresh,
                        expiresInSeconds = outcome.expiresIn,
                        nowMillis = time.nowMillis(),
                    )
                    response.request.newBuilder()
                        .header("Authorization", "Bearer ${outcome.accessToken}")
                        .build()
                }
                RefreshOutcome.Rejected -> {
                    // The server definitively rejected the refresh token: re-login required.
                    tokenStore.clear()
                    null
                }
                RefreshOutcome.Transient -> {
                    // Keep the tokens: this request fails, but the session survives and
                    // the next attempt (WorkManager backoff, user retry) refreshes again.
                    null
                }
            }
        }
    }

    private fun performRefresh(serverUrl: String, refreshToken: String): RefreshOutcome {
        val url = serverUrl.trimEnd('/') + "/api/auth/refresh"
        val request = Request.Builder()
            .url(url)
            .post(ByteArray(0).toRequestBody(null))
            .header("Cookie", "refresh_token=$refreshToken")
            .build()

        return try {
            refreshClient.newCall(request).execute().use { resp ->
                when {
                    isTerminalRefreshStatus(resp.code) -> RefreshOutcome.Rejected
                    !resp.isSuccessful -> RefreshOutcome.Transient
                    else -> {
                        val bodyStr = resp.body?.string()?.takeIf { it.isNotBlank() }
                            ?: return RefreshOutcome.Transient
                        val envelope =
                            json.decodeFromString<ApiEnvelope<RefreshResponse>>(bodyStr)
                        val rotated = extractRefreshCookie(resp.headers("Set-Cookie"))
                        RefreshOutcome.Success(
                            accessToken = envelope.data.accessToken,
                            rotatedRefresh = rotated,
                            expiresIn = envelope.data.expiresIn,
                        )
                    }
                }
            }
        } catch (e: Exception) {
            // Network error or unparseable response — the token may still be valid.
            RefreshOutcome.Transient
        }
    }

    private sealed interface RefreshOutcome {
        data class Success(
            val accessToken: String,
            val rotatedRefresh: String?,
            val expiresIn: Long?,
        ) : RefreshOutcome

        /** The server rejected the refresh token itself (invalid/expired/revoked). */
        data object Rejected : RefreshOutcome

        /** The refresh attempt failed for a reason that doesn't condemn the token. */
        data object Transient : RefreshOutcome
    }

    companion object {
        private const val MAX_REFRESH_ATTEMPTS = 2

        /**
         * Whether a refresh-endpoint status code condemns the refresh token itself.
         * Only an explicit auth rejection does; 5xx/429/timeouts are server or
         * network trouble and must not destroy a valid session.
         */
        internal fun isTerminalRefreshStatus(code: Int): Boolean = code == 401 || code == 403

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
