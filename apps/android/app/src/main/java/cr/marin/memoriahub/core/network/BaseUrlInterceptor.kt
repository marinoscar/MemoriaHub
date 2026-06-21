package cr.marin.memoriahub.core.network

import cr.marin.memoriahub.core.storage.AppConfigStore
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rewrites the scheme/host/port of every API request to the server URL the user
 * configured at runtime. Retrofit is built with a placeholder base URL; this swaps
 * in the real origin so the base URL can change without rebuilding Retrofit.
 *
 * Only applied to the API client — presigned S3/R2 part uploads use a separate
 * bare client and must NOT be rewritten.
 */
@Singleton
class BaseUrlInterceptor @Inject constructor(
    private val appConfigStore: AppConfigStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val configured = appConfigStore.serverUrl?.toHttpUrlOrNull()
            ?: throw IOException("Server URL is not configured")

        val newUrl = original.url.newBuilder()
            .scheme(configured.scheme)
            .host(configured.host)
            .port(configured.port)
            .build()

        return chain.proceed(original.newBuilder().url(newUrl).build())
    }
}
