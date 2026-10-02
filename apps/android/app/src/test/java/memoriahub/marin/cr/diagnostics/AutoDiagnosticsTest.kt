package memoriahub.marin.cr.diagnostics

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.testing.FakeDiagnosticsApi
import memoriahub.marin.cr.testing.FakeDiagnosticsLedger
import memoriahub.marin.cr.testing.FakePlatform
import memoriahub.marin.cr.testing.FakeServerProbe
import memoriahub.marin.cr.testing.FakeSyncControl
import memoriahub.marin.cr.testing.httpFailure
import memoriahub.marin.cr.testing.networkFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration
import java.time.Instant

class AutoDiagnosticsTest {
    private var now = Instant.parse("2026-10-01T12:00:00Z")
    private var pairing = PairingStatus(hasToken = true, deviceId = "dev-1")
    private val server = FakeServerProbe()
    private val api = FakeDiagnosticsApi()
    private val store = InMemoryAutoDiagnosticsStore()

    private val service = DiagnosticsService(
        selfTest = {
            SelfTest(
                platform = FakePlatform(),
                serverUrl = { "https://photos.example" },
                server = server,
                api = api,
                releases = null,
                pairing = { pairing },
                sync = { FakeSyncControl() },
                ledger = FakeDiagnosticsLedger(stats = SyncStats()),
                clock = { now },
            )
        },
        api = api,
        pairing = { pairing },
        token = { "pat_abcdefghijkl" },
        runs = { emptyList() },
        log = { emptyList() },
    )

    private val auto = AutoDiagnostics({ pairing }, server, service, store, CoroutineScope(Dispatchers.Unconfined), clock = { now })

    @Test fun `only failed and partial runs need a report`() {
        assertTrue(AutoDiagnostics.needsReport("failed"))
        assertTrue(AutoDiagnostics.needsReport("partial"))
        listOf("ok", "skipped", "paused").forEach { assertFalse(AutoDiagnostics.needsReport(it)) }
        runBlocking { assertEquals(AutoDiagnostics.Outcome.NOT_NEEDED, auto.afterRun("ok")) }
        assertEquals(0, api.uploads.size)
    }

    @Test fun `uploads once, then throttles for six hours`() = runBlocking {
        assertEquals(AutoDiagnostics.Outcome.UPLOADED, auto.afterRun("failed"))
        assertEquals(1, api.uploads.size)
        assertEquals("dev-1", api.uploads.single().first)
        assertTrue(api.uploads.single().second.summary!!.length <= 500)
        now = now.plus(Duration.ofHours(5))
        assertEquals(AutoDiagnostics.Outcome.THROTTLED, auto.afterRun("partial"))
        now = now.plus(Duration.ofHours(1))
        assertEquals(AutoDiagnostics.Outcome.UPLOADED, auto.afterRun("partial"))
        assertEquals(2, api.uploads.size)
    }

    @Test fun `the throttle counts from the attempt, not the success`() = runBlocking {
        api.uploadResult = httpFailure(500)
        assertEquals(AutoDiagnostics.Outcome.UPLOAD_FAILED, auto.afterRun("failed"))
        assertEquals(now, store.lastAttemptAt)
        now = now.plus(Duration.ofHours(1))
        assertEquals(AutoDiagnostics.Outcome.THROTTLED, auto.afterRun("failed"))
        assertEquals(1, api.uploads.size)
    }

    @Test fun `not paired or not live does nothing and does not start the throttle`() = runBlocking {
        pairing = PairingStatus()
        assertEquals(AutoDiagnostics.Outcome.NOT_PAIRED, auto.afterRun("failed"))
        pairing = PairingStatus(hasToken = true, deviceId = "dev-1", expired = true)
        assertEquals(AutoDiagnostics.Outcome.NOT_PAIRED, auto.afterRun("failed"))
        pairing = PairingStatus(hasToken = true, deviceId = "dev-1")
        server.liveResult = { networkFailure() }
        assertEquals(AutoDiagnostics.Outcome.UNREACHABLE, auto.afterRun("failed"))
        assertEquals(null, store.lastAttemptAt)
        assertEquals(0, api.uploads.size)
        server.liveResult = { ApiResult.Success(kotlinx.serialization.json.JsonObject(emptyMap()), 200) }
        assertEquals(AutoDiagnostics.Outcome.UPLOADED, auto.afterRun("failed"))
    }

    @Test fun `onRunFinished is fire and forget`() {
        auto.onRunFinished("ok")
        assertEquals(0, server.liveCalls)
        auto.onRunFinished("failed")
        // Unconfined scope with blocking-free fakes: the upload has run by now, but allow the IO probes to finish.
        val deadline = System.currentTimeMillis() + 5_000
        while (api.uploads.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(1, api.uploads.size)
    }

    @Test fun `due handles a clock moving backwards`() {
        val t = Instant.parse("2026-10-01T12:00:00Z")
        assertTrue(AutoDiagnostics.due(null, t))
        assertFalse(AutoDiagnostics.due(t, t.plus(Duration.ofHours(5))))
        assertTrue(AutoDiagnostics.due(t, t.plus(Duration.ofHours(6))))
        assertTrue(AutoDiagnostics.due(t, t.minus(Duration.ofMinutes(1))))
    }
}
