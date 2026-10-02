package memoriahub.marin.cr.pairing

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceFlowPollerTest {
    private val grant = DeviceCodeGrant(
        deviceCode = "dev-code",
        userCode = "ABCD-1234",
        verificationUri = "https://app.test/activate",
        verificationUriComplete = "https://app.test/activate?code=ABCD-1234",
        expiresIn = 900,
        interval = 5,
    )
    private val pat = DeviceCredential(
        accessToken = "pat_abc",
        expiresIn = 7_776_000,
        credentialType = "pat",
        expiresAt = "2026-12-30T12:00:00.000Z",
        tokenId = "t1",
    )

    /** Scripted transport; records the clock at every poll. */
    private class Script(private val clock: () -> Long, vararg results: ApiResult<DeviceCredential>) : DeviceFlowTransport {
        val queue = ArrayDeque(results.toList())
        val pollTimes = mutableListOf<Long>()
        val polls get() = pollTimes.size
        override suspend fun requestCode(clientInfo: DeviceClientInfo): ApiResult<DeviceCodeGrant> = error("unused")
        override suspend fun pollToken(deviceCode: String): ApiResult<DeviceCredential> {
            pollTimes += clock()
            return queue.removeFirstOrNull() ?: oauth("authorization_pending")
        }
    }

    // A fake clock advanced by the poller's own sleeps.
    private var now = 0L
    private val sleeps = mutableListOf<Long>()
    private fun script(vararg results: ApiResult<DeviceCredential>) = Script({ now }, *results)
    private fun poller(transport: DeviceFlowTransport) =
        DeviceFlowPoller(transport, sleep = { sleeps += it; now += it }, nowMillis = { now })

    @Test fun `pending then slow_down then success`() = runBlocking {
        val script = script(oauth("authorization_pending"), oauth("slow_down"), ApiResult.Success(pat, 200))
        val progress = mutableListOf<PollProgress>()
        val result = poller(script).poll(grant) { progress += it }
        assertEquals(PollResult.Approved(pat), result)
        assertEquals(3, script.polls)
        // 5 s after pending, then 10 s after slow_down; every sleep padded by 250 ms.
        assertEquals(listOf(5_250L, 10_250L), sleeps)
        assertTrue(progress.contains(PollProgress.SlowedDown(10)))
    }

    @Test fun `slow_down adds 5 s each time and is capped at 60 s`() = runBlocking {
        val many = Array<ApiResult<DeviceCredential>>(20) { oauth("slow_down") }
        poller(script(*many, ApiResult.Success(pat, 200))).poll(grant.copy(expiresIn = 3600))
        assertEquals(listOf(10_250L, 15_250L, 20_250L), sleeps.take(3))
        assertEquals(60_250L, sleeps.last())
        assertTrue(sleeps.all { it <= 60_250L })
    }

    @Test fun `a zero interval is clamped to 1 s`() = runBlocking {
        poller(script(oauth("authorization_pending"), ApiResult.Success(pat, 200))).poll(grant.copy(interval = 0))
        assertEquals(listOf(1_250L), sleeps)
    }

    @Test fun `access_denied stops with Denied`() = runBlocking {
        assertEquals(PollResult.Denied, poller(script(oauth("authorization_pending"), oauth("access_denied"))).poll(grant))
    }

    @Test fun `expired_token stops with Expired`() = runBlocking {
        assertEquals(PollResult.Expired, poller(script(oauth("expired_token"))).poll(grant))
    }

    @Test fun `invalid_grant fails`() = runBlocking {
        assertTrue(poller(script(oauth("invalid_grant", status = 401))).poll(grant) is PollResult.Failed)
    }

    @Test fun `the local deadline expires a code that stays pending`() = runBlocking {
        val script = script()
        val result = poller(script).poll(grant.copy(expiresIn = 12))
        assertEquals(PollResult.Expired, result)
        // Polls at 0, 5.25 and 10.5 s; the last sleep is cut to the deadline.
        assertEquals(3, script.polls)
        assertEquals(12_000L, sleeps.sum())
    }

    @Test fun `network errors, 5xx and 429 keep polling`() = runBlocking {
        val network = ApiResult.Failure(ApiError(ApiError.Kind.NETWORK, message = "reset"))
        val server = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 503, "ERROR", "down"))
        val throttled = ApiResult.Failure(ApiError(ApiError.Kind.HTTP, 429, "TOO_MANY_REQUESTS", "slow"))
        val progress = mutableListOf<PollProgress>()
        val result = poller(script(network, server, throttled, ApiResult.Success(pat, 200))).poll(grant) { progress += it }
        assertEquals(PollResult.Approved(pat), result)
        assertEquals(3, progress.count { it is PollProgress.NetworkTrouble })
        // Transient errors do not slow the polling down.
        assertEquals(listOf(5_250L, 5_250L, 5_250L), sleeps)
    }

    @Test fun `a session credential is refused`() = runBlocking {
        val session = DeviceCredential(accessToken = "eyJ...", credentialType = "session")
        val result = poller(script(ApiResult.Success(session, 200))).poll(grant)
        assertTrue(result is PollResult.Failed)
        assertTrue((result as PollResult.Failed).message.contains("session"))
    }

    @Test fun `a credential without credentialType (server older than #499) is refused`() = runBlocking {
        val legacy = DeviceCredential(accessToken = "eyJ...", credentialType = null)
        assertTrue(poller(script(ApiResult.Success(legacy, 200))).poll(grant) is PollResult.Failed)
    }

    @Test fun `an empty token is refused`() = runBlocking {
        assertTrue(poller(script(ApiResult.Success(pat.copy(accessToken = " "), 200))).poll(grant) is PollResult.Failed)
    }

    @Test fun `expiry comes from expiresAt, else from expiresIn`() {
        val now = Instant.parse("2026-10-01T00:00:00Z")
        assertEquals(Instant.parse("2026-12-30T12:00:00Z"), pat.expiryInstant(now))
        assertEquals(now.plusSeconds(60), pat.copy(expiresAt = null, expiresIn = 60).expiryInstant(now))
        assertNull(pat.copy(expiresAt = null, expiresIn = null).expiryInstant(now))
    }

    // --- pokeNow() (the memoriahub://media-sync/paired return), on virtual time -------------------

    @Test fun `pokeNow during a slowed-down wait polls as soon as the server allows`() = runTest {
        val clock = { testScheduler.currentTime }
        val script = Script(clock, oauth("slow_down"), ApiResult.Success(pat, 200))
        val poller = DeviceFlowPoller(script, sleep = { delay(it) }, nowMillis = clock)
        val result = async { poller.poll(grant) }
        advanceTimeBy(1_000)
        runCurrent()
        poller.pokeNow()
        advanceUntilIdle()
        assertEquals(PollResult.Approved(pat), result.await())
        // Without the poke the second poll would be at 10 250 ms; the server accepts one at 5 250.
        assertEquals(listOf(0L, 5_250L), script.pollTimes)
    }

    @Test fun `pokeNow after the server's minimum spacing polls immediately`() = runTest {
        val clock = { testScheduler.currentTime }
        val script = Script(clock, oauth("slow_down"), ApiResult.Success(pat, 200))
        val poller = DeviceFlowPoller(script, sleep = { delay(it) }, nowMillis = clock)
        val result = async { poller.poll(grant) }
        advanceTimeBy(7_000)
        runCurrent()
        poller.pokeNow()
        advanceUntilIdle()
        assertEquals(PollResult.Approved(pat), result.await())
        assertEquals(listOf(0L, 7_000L), script.pollTimes)
    }

    @Test fun `pokeNow never polls earlier than the interval (no self-inflicted slow_down)`() = runTest {
        val clock = { testScheduler.currentTime }
        val script = Script(clock, oauth("authorization_pending"), ApiResult.Success(pat, 200))
        val poller = DeviceFlowPoller(script, sleep = { delay(it) }, nowMillis = clock)
        val result = async { poller.poll(grant) }
        advanceTimeBy(1_000)
        runCurrent()
        poller.pokeNow()
        advanceUntilIdle()
        assertEquals(PollResult.Approved(pat), result.await())
        assertEquals(listOf(0L, 5_250L), script.pollTimes)
    }

    @Test fun `a poke left over from an earlier attempt is ignored`() = runTest {
        val clock = { testScheduler.currentTime }
        val script = Script(clock, oauth("slow_down"), ApiResult.Success(pat, 200))
        val poller = DeviceFlowPoller(script, sleep = { delay(it) }, nowMillis = clock)
        poller.pokeNow()
        val result = async { poller.poll(grant) }
        advanceUntilIdle()
        assertEquals(PollResult.Approved(pat), result.await())
        assertEquals(listOf(0L, 10_250L), script.pollTimes)
    }

    // --- Over HTTP ------------------------------------------------------------------------------

    @Test fun `transport parses RFC 8628 errors and the PAT envelope over HTTP, unauthenticated`() = runBlocking {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"authorization_pending","error_description":"wait"}"""))
            server.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"slow_down","error_description":"slow"}"""))
            server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
            server.enqueue(
                MockResponse().setBody(
                    """{"data":{"accessToken":"pat_x","refreshToken":"","tokenType":"Bearer","expiresIn":100,"credentialType":"pat",""" +
                        """"expiresAt":"2026-12-30T12:00:00.000Z","tokenId":"t","tokenName":"MemoriaHub Android · P"},"meta":{}}""",
                ),
            )
            val api = ApiClient(baseUrlProvider = { server.url("/").toString() }, tokenProvider = { "pat_old" })
            val result = DeviceFlowPoller(ApiDeviceFlowTransport(api), sleep = {}).poll(grant)
            assertEquals("pat_x", (result as PollResult.Approved).credential.accessToken)
            assertEquals("t", result.credential.tokenId)
            val first = server.takeRequest()
            assertEquals("/api/auth/device/token", first.path)
            assertEquals("""{"deviceCode":"dev-code"}""", first.body.readUtf8())
            assertNull("device-flow calls are unauthenticated", first.getHeader("Authorization"))
            assertEquals(4, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test fun `a session credential over HTTP is refused`() = runBlocking {
        val server = MockWebServer().apply { start() }
        try {
            server.enqueue(
                MockResponse().setBody(
                    """{"data":{"accessToken":"eyJ","refreshToken":"r","tokenType":"Bearer","expiresIn":100,"credentialType":"session"}}""",
                ),
            )
            val api = ApiClient(baseUrlProvider = { server.url("/").toString() })
            assertTrue(DeviceFlowPoller(ApiDeviceFlowTransport(api), sleep = {}).poll(grant) is PollResult.Failed)
        } finally {
            server.shutdown()
        }
    }

    private companion object {
        fun oauth(error: String, status: Int = 400): ApiResult.Failure =
            ApiResult.Failure(ApiError(ApiError.Kind.HTTP, status, "BAD_REQUEST", "x", oauthError = error))
    }
}
