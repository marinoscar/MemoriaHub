package memoriahub.marin.cr.diagnostics

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.FakeDiagnosticsApi
import memoriahub.marin.cr.testing.FakeDiagnosticsLedger
import memoriahub.marin.cr.testing.FakePlatform
import memoriahub.marin.cr.testing.FakeServerProbe
import memoriahub.marin.cr.testing.FakeSyncControl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DiagnosticsHealthTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val platform = FakePlatform(permission = MediaPermissionState.DENIED, battery = false)
    private val sync = FakeSyncControl(lastCheckinAtMs = System.currentTimeMillis())
    private val api = FakeDiagnosticsApi()
    private var resets = 0
    private val pairing = PairingStatus(hasToken = true, deviceId = "dev-1")

    private val service = DiagnosticsService(
        selfTest = {
            SelfTest(platform, { "https://photos.example" }, FakeServerProbe(), api, null, { pairing }, { sync }, FakeDiagnosticsLedger(stats = SyncStats()))
        },
        api = api,
        pairing = { pairing },
        token = { null },
        runs = { emptyList() },
        log = { listOf("a", "b") },
    )

    private val health = DiagnosticsHealth(service, { sync }, { emptyList() }, { resets++ }, scope, log = { listOf("a", "b") })

    @After fun tearDown() = scope.cancel()

    @Test fun `refresh publishes the hub health line`() = runBlocking {
        health.refresh()
        val line = withTimeout(5_000) { health.line.first { it != null } }!!
        assertEquals(1, line.failCount) // media.permission
        assertTrue(line.warnCount >= 1) // battery.optimization
        assertEquals(line.warnCount + line.failCount, line.problems)
        assertTrue(line.ranAtMs!! <= Instant.now().toEpochMilli())
        assertTrue(health.state.value.report != null)
    }

    @Test fun `actions reach sync control, upload and the ledger reset`() = runBlocking {
        health.refresh()
        health.syncNow()
        assertEquals(1, sync.syncNowCalls)
        health.upload()
        withTimeout(5_000) { health.state.first { it.uploadedId != null } }
        assertEquals(1, api.uploads.size)
        health.retryFailed()
        health.resume()
        health.resetLocalSyncState()
        withTimeout(5_000) { while (resets == 0 || sync.retryCalls == 0 || sync.pausedCalls.isEmpty()) kotlinx.coroutines.delay(10) }
        assertEquals(listOf(false), sync.pausedCalls)
    }
}
