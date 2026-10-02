package memoriahub.marin.cr.diagnostics

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import memoriahub.marin.cr.ledger.BucketStats
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.testing.FakeDiagnosticsApi
import memoriahub.marin.cr.testing.FakeDiagnosticsLedger
import memoriahub.marin.cr.testing.FakePlatform
import memoriahub.marin.cr.testing.FakeReleaseApi
import memoriahub.marin.cr.testing.FakeServerProbe
import memoriahub.marin.cr.testing.FakeSyncControl
import memoriahub.marin.cr.testing.httpFailure
import memoriahub.marin.cr.testing.run
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

class SelfTestTest {
    private val now = Instant.parse("2026-10-01T12:00:00Z")
    private val pairing = PairingStatus(hasToken = true, deviceId = "dev-1", tokenExpiresAt = now.plus(Duration.ofDays(90)))

    private val platform = FakePlatform()
    private val server = FakeServerProbe()
    private val api = FakeDiagnosticsApi()
    private val releases = FakeReleaseApi()
    private val sync = FakeSyncControl(lastCheckinAtMs = now.toEpochMilli() - 60_000)
    private val ledger = FakeDiagnosticsLedger(
        stats = SyncStats(eligible = 12, uploaded = 12, perBucket = mapOf("camera" to BucketStats(eligible = 12, uploaded = 12))),
        runs = listOf(run("ok", now.toEpochMilli() - 60_000)),
    )
    private val apiFailures = mutableListOf<ApiError>()

    private fun selfTest(
        url: String? = "https://photos.example",
        pairingStatus: PairingStatus = pairing,
        timeoutMs: Long = 2_000,
    ) = SelfTest(
        platform = platform,
        serverUrl = { url },
        server = server,
        api = api,
        releases = releases,
        pairing = { pairingStatus },
        sync = { sync },
        ledger = ledger,
        clock = { now },
        networkTimeoutMs = timeoutMs,
        localTimeoutMs = timeoutMs,
        onApiFailure = { apiFailures += it },
    )

    private fun SelfTestResult.check(id: String) = checks.single { it.id == id }

    @Test fun `healthy phone passes everything and reports all 22 checks in order`() = runBlocking {
        val result = selfTest().run()
        assertEquals(CheckIds.ALL, result.checks.map { it.id })
        assertEquals(result.checks.filter { it.verdict != CheckStatus.PASS }.joinToString { "${it.id}: ${it.detail}" }, 0, result.problemCount)
        assertEquals("All checks pass", result.summary)
        assertEquals(1, result.folders.size)
        assertEquals("IMG_9.jpg", result.folders.single().lastFile)
        assertEquals(12, result.folders.single().uploaded)
    }

    @Test fun `a probe that never answers becomes a fail with detail, never a crash`() = runBlocking {
        server.liveResult = { awaitCancellation() }
        api.deviceResult = { delay(60_000); throw IllegalStateException("unreachable") }
        val started = System.nanoTime()
        val result = selfTest(timeoutMs = 300).run()
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("self-test took $elapsedMs ms", elapsedMs < 5_000)
        val reachable = result.check(CheckIds.SERVER_REACHABLE)
        assertEquals(CheckStatus.FAIL, reachable.verdict)
        assertTrue(reachable.detail, reachable.detail.contains("no answer within"))
        assertEquals(CheckStatus.FAIL, result.check(CheckIds.AUTH_VALID).verdict)
    }

    @Test fun `a blocking local probe that ignores cancellation is cut off`() = runBlocking {
        sync.periodicBlock = { Thread.sleep(2_000); true }
        val result = selfTest(timeoutMs = 200).run()
        val periodic = result.check(CheckIds.WORK_PERIODIC)
        assertEquals(CheckStatus.FAIL, periodic.verdict)
        assertTrue(periodic.detail.contains("no answer within"))
    }

    @Test fun `throwing platform and ledger degrade to skips`() = runBlocking {
        platform.throwEverywhere = true
        ledger.statsBlock = { throw IllegalStateException("db closed") }
        val result = selfTest().run()
        assertEquals(22, result.checks.size)
        assertEquals(CheckStatus.SKIP, result.check(CheckIds.BATTERY).verdict)
        assertEquals(CheckStatus.SKIP, result.check(CheckIds.UPLOAD_BACKLOG).verdict)
        assertEquals(CheckStatus.SKIP, result.check(CheckIds.MEDIA_PERMISSION).verdict)
    }

    @Test fun `not configured and not paired`() = runBlocking {
        val result = selfTest(url = null, pairingStatus = PairingStatus()).run()
        assertEquals(CheckStatus.FAIL, result.check(CheckIds.SERVER_CONFIGURED).verdict)
        assertEquals(CheckStatus.SKIP, result.check(CheckIds.SERVER_REACHABLE).verdict)
        assertEquals(CheckStatus.FAIL, result.check(CheckIds.PAIRING_TOKEN).verdict)
        assertEquals(0, releases.latestCalls)
    }

    @Test fun `authenticated failures go through the global reactions`() = runBlocking {
        api.deviceResult = { httpFailure(401) }
        val result = selfTest().run()
        assertEquals(CheckStatus.FAIL, result.check(CheckIds.AUTH_VALID).verdict)
        assertEquals(listOf(401), apiFailures.map { it.httpStatus })
    }

    @Test fun `revoked permission fails with the grant action`() = runBlocking {
        platform.permission = memoriahub.marin.cr.permissions.MediaPermissionState.DENIED
        val result = selfTest().run()
        val check = result.check(CheckIds.MEDIA_PERMISSION)
        assertEquals(CheckStatus.FAIL, check.verdict)
        assertEquals(CheckAction.GRANT_MEDIA, check.action)
        // Without permission the inventory is unknown: the folder selection is not judged.
        assertEquals(CheckStatus.PASS, result.check(CheckIds.MEDIA_FOLDERS).verdict)
    }

    @Test fun `probe returns ok, error and timeout`() = runBlocking {
        assertEquals(7, (probe(1_000) { 7 } as Probe.Ok).value)
        assertTrue(probe<Int>(1_000) { throw IllegalArgumentException("bad") } is Probe.Error)
        assertEquals(Probe.TimedOut(100), probe(100) { awaitCancellation() })
    }
}
