package memoriahub.marin.cr.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.cancellation.CancellationException

/** `partUploadAuth` values (#506). Absent on older servers, which only hand out presigned URLs. */
object PartUploadAuth {
    const val NONE = "none"
    const val BEARER = "bearer"
}

/** Outcome of one part `PUT`. */
sealed interface PartPutResult {
    /** 2xx with an `ETag` header (quotes preserved, exactly as sent to `complete`). */
    data class Uploaded(val eTag: String, val bytes: Long) : PartPutResult

    /** Non-2xx. [retryAfterSeconds] from `Retry-After` (429/503); [body] is a short, query-free excerpt. */
    data class Http(val status: Int, val retryAfterSeconds: Long?, val body: String) : PartPutResult

    /** 2xx with no `ETag`: the upload cannot be completed (CORS-stripped header, broken proxy). */
    data object MissingETag : PartPutResult

    /** Network failure (DNS, TLS, reset, timeout). */
    data class Network(val error: IOException) : PartPutResult

    /** The FILE could not be read (vanished, permission revoked, shorter than expected). */
    data class Source(val error: SourceReadException) : PartPutResult
}

/**
 * PUTs one part to a part URL with its OWN OkHttp client (§9.2: connect 15 s, read/write 120 s,
 * no call timeout — a stalled socket fails the part and the ledger keeps the earlier parts).
 *
 * **Credentials (§6.6, #506).** A presigned storage URL (`partUploadAuth = none`) gets **no**
 * `Authorization` header: S3 rejects one and the PAT must never leave for a third-party host.
 * The API's own part route (`bearer`) gets `Authorization: Bearer <pat>` — but only when the URL
 * is on the configured server origin (scheme, host and port all equal). A `bearer` URL naming any
 * other host is sent WITHOUT credentials (and will fail), so a malicious or misconfigured server
 * response can never exfiltrate the token.
 *
 * Never logs or returns the URL: presigned query strings carry credentials.
 */
class PartUploader(
    private val serverBaseUrl: () -> String?,
    private val tokenProvider: () -> String?,
    private val http: OkHttpClient = defaultUploadClient(),
    private val userAgent: String? = null,
) {
    suspend fun put(
        url: String,
        auth: String?,
        source: ContentSource,
        uri: String,
        offset: Long,
        length: Long,
        onBytes: (Long) -> Unit = {},
    ): PartPutResult = withContext(Dispatchers.IO) {
        val target = url.toHttpUrlOrNull() ?: return@withContext PartPutResult.Http(0, null, "Invalid part URL")
        val bearer = auth == PartUploadAuth.BEARER
        val body = ContentRangeRequestBody(
            source = source,
            uri = uri,
            offset = offset,
            length = length,
            // The API's raw-part parser needs a non-JSON type; S3 signs no Content-Type.
            mediaType = if (bearer) OCTET_STREAM else null,
            onBytes = onBytes,
        )
        val builder = Request.Builder().url(target).put(body)
        userAgent?.let { builder.header("User-Agent", it) }
        if (bearer && isOwnServer(target)) {
            tokenProvider()?.takeIf { it.isNotEmpty() }?.let { builder.header("Authorization", "Bearer $it") }
        }
        try {
            http.newCall(builder.build()).execute().use { response ->
                if (response.isSuccessful) {
                    val eTag = response.header("ETag") ?: response.header("etag")
                    if (eTag.isNullOrBlank()) PartPutResult.MissingETag else PartPutResult.Uploaded(eTag, length)
                } else {
                    val excerpt = runCatching { response.peekBody(512).string() }.getOrDefault("")
                    PartPutResult.Http(response.code, parseRetryAfter(response.header("Retry-After")), excerpt)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: SourceReadException) {
            PartPutResult.Source(e)
        } catch (e: IOException) {
            // OkHttp may wrap the body's failure; look one level down for the source error.
            (e.cause as? SourceReadException)?.let { PartPutResult.Source(it) } ?: PartPutResult.Network(e)
        }
    }

    /** True when [url] is on the configured server origin (scheme, host, port). */
    fun isOwnServer(url: HttpUrl): Boolean {
        val base = serverBaseUrl()?.trimEnd('/')?.toHttpUrlOrNull() ?: return false
        return base.scheme == url.scheme && base.host.equals(url.host, ignoreCase = true) && base.port == url.port
    }

    companion object {
        private val OCTET_STREAM = "application/octet-stream".toMediaType()

        /** §9.2: connect 15 s, read/write 120 s, no overall call timeout. */
        fun defaultUploadClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        /** `Retry-After` as delta-seconds; an HTTP-date or garbage yields null. */
        fun parseRetryAfter(value: String?): Long? = value?.trim()?.toLongOrNull()?.takeIf { it >= 0 }
    }
}
