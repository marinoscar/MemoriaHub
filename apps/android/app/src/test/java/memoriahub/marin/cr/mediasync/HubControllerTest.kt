package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.contract.HealthLine
import memoriahub.marin.cr.deeplink.MediaSyncAction
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.FakeHealthSummary
import memoriahub.marin.cr.testing.FakeSyncControl
import memoriahub.marin.cr.testing.FakeUpdateStatus
import memoriahub.marin.cr.testing.syncConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HubControllerTest {
    private val paired = PairingStatus(hasToken = true, deviceId = "dev-1")
    private var pairing = paired
    private var statsReads = 0
    private var stats = SyncStats(eligible = 3, uploaded = 1, pending = 2)
    private val published = mutableListOf<Pair<Boolean, Boolean>>()
    private val circleLookups = mutableListOf<String>()

    private fun TestScope.hub(control: FakeSyncControl, health: FakeHealthSummary = FakeHealthSummary(), updates: FakeUpdateStatus = FakeUpdateStatus()): Pair<HubController, CoroutineScope> {
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val sources = HubSources(
            serverUrl = { "https://photos.example.com" },
            pairing = { pairing },
            stats = { statsReads++; stats },
            permission = { MediaPermissionState.FULL },
            conditions = { DeviceConditions() },
            circleName = { id -> circleLookups += id; "Familia" },
            publishShortcuts = { p, paused -> published += p to paused },
            clock = { 0 },
        )
        return HubController(control, health, updates, sources, scope) to scope
    }

    @Test fun `refresh reads the ledger, circle name, health and update, and publishes shortcuts`() = runTest {
        val health = FakeHealthSummary()
        val updates = FakeUpdateStatus()
        val (hub, scope) = hub(FakeSyncControl(), health, updates)
        hub.refresh(); advanceUntilIdle()
        val s = hub.state.value
        assertEquals(1, s.synced)
        assertEquals(2, s.missing)
        assertEquals("Familia", s.targetCircle)
        assertEquals(1, health.refreshes)
        assertEquals(1, updates.checks)
        assertEquals(listOf(true to false), published)
        scope.cancel()
    }

    @Test fun `circle name is looked up once per circle`() = runTest {
        val (hub, scope) = hub(FakeSyncControl())
        hub.refresh(checkHealthAndUpdates = false); advanceUntilIdle()
        hub.refresh(checkHealthAndUpdates = false); advanceUntilIdle()
        assertEquals(1, circleLookups.size)
        scope.cancel()
    }

    @Test fun `stop syncing pauses, reports and republishes the shortcuts`() = runTest {
        val control = FakeSyncControl()
        val (hub, scope) = hub(control)
        advanceUntilIdle()
        hub.setPaused(true); advanceUntilIdle()
        assertEquals(listOf("setPaused(true)"), control.calls)
        assertEquals("Sync paused", hub.messages.first())
        assertEquals(PrimaryAction.START, hub.state.value.primaryAction)
        assertEquals(true to true, published.last())
        scope.cancel()
    }

    @Test fun `apply action checks in and says settings applied`() = runTest {
        val control = FakeSyncControl()
        val (hub, scope) = hub(control)
        hub.runAction(MediaSyncAction.APPLY); advanceUntilIdle()
        assertEquals(listOf("checkinNow"), control.calls)
        assertEquals("Settings applied", hub.messages.first())
        scope.cancel()
    }

    @Test fun `live progress re-derives the status line and reloads stats when a file finishes`() = runTest {
        val control = FakeSyncControl()
        val (hub, scope) = hub(control)
        advanceUntilIdle()
        val before = statsReads
        control.status.value = control.status.value.copy(running = true, filesTotal = 4, filesDone = 0, currentFile = "a.jpg")
        advanceUntilIdle()
        assertEquals(HubStatus.SYNCING, hub.state.value.status)
        control.status.value = control.status.value.copy(bytesSent = 10, bytesTotal = 100)
        advanceUntilIdle()
        val afterTick = statsReads
        control.status.value = control.status.value.copy(filesDone = 1)
        advanceUntilIdle()
        assertTrue(afterTick > before)
        assertEquals(afterTick + 1, statsReads)
        scope.cancel()
    }

    @Test fun `health line updates as the self-test finishes`() = runTest {
        val health = FakeHealthSummary()
        val (hub, scope) = hub(FakeSyncControl(), health)
        advanceUntilIdle()
        health.line.value = HealthLine(10, 0, 1, 1)
        advanceUntilIdle()
        assertEquals(HealthSeverity.FAIL, hub.state.value.health?.severity)
        scope.cancel()
    }

    @Test fun `unpaired hub never runs actions`() = runTest {
        pairing = PairingStatus()
        val control = FakeSyncControl(syncConfig())
        val (hub, scope) = hub(control)
        hub.syncNow(); advanceUntilIdle()
        assertTrue(control.calls.isEmpty())
        assertEquals("Pair this phone first.", hub.messages.first())
        assertEquals(HubStatus.NOT_PAIRED, hub.state.value.status)
        scope.cancel()
    }
}
