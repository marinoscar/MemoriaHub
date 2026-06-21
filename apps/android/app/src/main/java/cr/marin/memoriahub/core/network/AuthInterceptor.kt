package cr.marin.memoriahub.core.network

import cr.marin.memoriahub.core.auth.TokenStore
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Attaches `Authorization: Bearer <accessToken>` to API requests. Public endpoints
 * (device code/token, providers) simply ignore it when no token is stored yet.
 *
 * A request tagged with the [SKIP_AUTH_HEADER] header is sent without a bearer
 * (reserved for any future unauthenticated calls on this client).
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val tokenStore: TokenStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header(SKIP_AUTH_HEADER) != null) {
            return chain.proceed(request.newBuilder().removeHeader(SKIP_AUTH_HEADER).build())
        }
        val token = tokenStore.accessToken
        if (token.isNullOrEmpty()) {
            return chain.proceed(request)
        }
        return chain.proceed(
            request.newBuilder()
                .header("Authorization", "Bearer $token")
                .build(),
        )
    }

    companion object {
        const val SKIP_AUTH_HEADER = "X-Skip-Auth"
    }
}
