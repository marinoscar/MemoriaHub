package cr.marin.memoriahub.core.network

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RetryInterceptorTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client() = OkHttpClient.Builder()
        .addInterceptor(RetryInterceptor(maxRetries = 3, sleeper = {}, random = { 0.0 }))
        .build()

    @Test
    fun `retries on 503 SlowDown then succeeds`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody("SlowDown"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))

        client().newCall(Request.Builder().url(server.url("/")).build()).execute().use { response ->
            assertEquals(200, response.code)
        }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `does not retry non-retryable 400`() {
        server.enqueue(MockResponse().setResponseCode(400).setBody("bad"))

        client().newCall(Request.Builder().url(server.url("/")).build()).execute().use { response ->
            assertEquals(400, response.code)
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `gives up after maxRetries and returns last response`() {
        repeat(5) { server.enqueue(MockResponse().setResponseCode(503).setBody("err")) }

        client().newCall(Request.Builder().url(server.url("/")).build()).execute().use { response ->
            assertEquals(503, response.code)
        }
        // 1 initial + 3 retries.
        assertEquals(4, server.requestCount)
    }

    @Test
    fun `computeBackoff is zero with zero jitter and exponential capped at max`() {
        assertEquals(0L, RetryInterceptor.computeBackoff(1, 500, 30_000, 0.0))
        assertEquals(500L, RetryInterceptor.computeBackoff(1, 500, 30_000, 1.0))
        assertEquals(1_000L, RetryInterceptor.computeBackoff(2, 500, 30_000, 1.0))
        assertEquals(2_000L, RetryInterceptor.computeBackoff(3, 500, 30_000, 1.0))
        assertEquals(30_000L, RetryInterceptor.computeBackoff(20, 500, 30_000, 1.0))
    }

    @Test
    fun `isRetryableStatus matches the CLI set`() {
        listOf(429, 502, 503, 504).forEach { assertTrue(RetryInterceptor.isRetryableStatus(it)) }
        listOf(200, 400, 401, 403, 404, 500).forEach { assertFalse(RetryInterceptor.isRetryableStatus(it)) }
    }
}
