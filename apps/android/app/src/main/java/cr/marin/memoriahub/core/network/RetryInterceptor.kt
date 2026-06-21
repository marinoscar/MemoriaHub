package cr.marin.memoriahub.core.network

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import kotlin.math.min
import kotlin.random.Random

/**
 * Transparent retry with exponential full-jitter backoff, mirroring the CLI's
 * `apps/cli/src/http/retry.ts`:
 *  - retryable HTTP statuses: 429, 502, 503, 504
 *  - retryable on any [IOException] (transport failure, no response)
 *  - throttle body-sniff (S3 `503 SlowDown`, R2 `429`) even on odd statuses
 *  - backoff = random() * min(maxMs, baseMs * 2^(attempt-1)); honors Retry-After
 *
 * Shared by the API client and the presigned-PUT client (the latter relies on the
 * body sniff and IOException handling).
 */
class RetryInterceptor(
    private val maxRetries: Int = 5,
    private val baseMs: Long = 500,
    private val maxMs: Long = 30_000,
    private val random: () -> Double = { Random.nextDouble() },
    private val sleeper: (Long) -> Unit = { ms -> if (ms > 0) Thread.sleep(ms) },
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        var attempt = 0
        var lastError: IOException? = null
        while (true) {
            attempt++
            val request = chain.request()
            val response: Response? = try {
                chain.proceed(request)
            } catch (e: IOException) {
                lastError = e
                null
            }

            if (response != null) {
                if (attempt > maxRetries || !shouldRetry(response)) return response
                val wait = retryAfterMs(response) ?: computeBackoff(attempt, baseMs, maxMs, random())
                response.close()
                sleeper(wait)
            } else {
                if (attempt > maxRetries) throw lastError ?: IOException("request failed")
                sleeper(computeBackoff(attempt, baseMs, maxMs, random()))
            }
        }
    }

    private fun shouldRetry(response: Response): Boolean =
        isRetryableStatus(response.code) || isThrottleBody(response)

    private fun retryAfterMs(response: Response): Long? {
        val header = response.header("Retry-After") ?: return null
        val seconds = header.trim().toLongOrNull() ?: return null
        return min(seconds * 1000L, maxMs * 4)
    }

    private fun isThrottleBody(response: Response): Boolean = try {
        val peek = response.peekBody(PEEK_LIMIT).string()
        THROTTLE_REGEX.containsMatchIn(peek)
    } catch (_: IOException) {
        false
    }

    companion object {
        private const val PEEK_LIMIT = 64L * 1024L
        private val RETRYABLE_STATUSES = setOf(429, 502, 503, 504)
        private val THROTTLE_REGEX =
            Regex("SlowDown|ServiceUnavailable|TooManyRequests|Throttl", RegexOption.IGNORE_CASE)

        fun isRetryableStatus(code: Int): Boolean = code in RETRYABLE_STATUSES

        /** attempt is 1-based for the first retry. */
        fun computeBackoff(attempt: Int, baseMs: Long, maxMs: Long, rand: Double): Long {
            val exp = if (attempt <= 1) baseMs else {
                val shift = (attempt - 1).coerceAtMost(20)
                min(maxMs, baseMs shl shift)
            }
            val capped = min(maxMs, exp)
            return (rand.coerceIn(0.0, 1.0) * capped).toLong()
        }
    }
}
