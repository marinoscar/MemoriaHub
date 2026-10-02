package memoriahub.marin.cr.sync

import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.testing.FakeApplierLedger
import memoriahub.marin.cr.testing.FakeCheckinApi
import memoriahub.marin.cr.testing.FakeDeviceStateReader
import memoriahub.marin.cr.testing.FakeSyncWork
import memoriahub.marin.cr.testing.httpError
import memoriahub.marin.cr.testing.networkError
import memoriahub.marin.cr.testing.syncConfig
import memoriahub.marin.cr.testing.testReactions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkManagerSyncControlTest {
    private val api = FakeCheckinApi(syncConfig(), version = 1)
    private val store = InMemorySyncStateStore()
    private val work = FakeSyncWork()
    private var paired = true
    private var now = 5_000_000L
    private var localRetries = 0
    private val scheduler = MediaSyncScheduler(work, store, isPaired = { paired }, clock = { now })
    private val checkin = SyncCheckin(
        api = api,
        store = store,
        applier = ConfigApplier(store, FakeApplierLedger(), scheduler, {}, { null }),
        reactions = testReactions,
        device = FakeDeviceStateReader(),
        deviceId = { if (paired) "dev-1" else null },
        appVersion = null,
        appVersionCode = null,
        clock = { now },
    )

    private fun TestScope.control() = WorkManagerSyncControl(
        scheduler = scheduler,
        work = work,
        checkin = checkin,
        store = store,
        tracker = SyncStatusTracker(store),
        retryLocal = { localRetries++ },
        scope = this,
    )

    @Test fun `no config before the first check-in, then the cached one`() = runTest {
        val control = control()
        assertNull(control.currentConfig())
        assertTrue(control.checkinNow().isSuccess)
        with(control.currentConfig()!!) {
            assertEquals(NetworkMode.WIFI, network)
            assertEquals(listOf("camera"), folderIds)
            assertEquals(1, configVersion)
            assertEquals(1, appliedConfigVersion)
        }
    }

    @Test fun `pausing offline stops locally at once and succeeds with the command queued`() = runTest {
        val control = control()
        control.checkinNow()
        work.events.clear()
        api.editErrors += networkError()

        assertTrue(control.setPaused(true).isSuccess)
        assertEquals(listOf("cancelAll"), work.events)
        assertEquals(listOf(OutboxEntry(command = "pause")), store.outbox)
        assertTrue(control.currentConfig()!!.paused)
        // Work stays cancelled: a sync request is dropped while paused.
        control.syncNow()
        assertEquals(listOf("cancelAll"), work.events)
    }

    @Test fun `resuming re-arms the work, runs now and reaches the server`() = runTest {
        val control = control()
        api.config = syncConfig(paused = true)
        control.checkinNow()
        work.events.clear()

        assertTrue(control.setPaused(false).isSuccess)
        assertTrue(store.outbox.isEmpty())
        assertFalse(api.config.paused)
        assertFalse(control.currentConfig()!!.paused)
        assertTrue("now:manual:REPLACE" in work.events)
        assertTrue(work.periodicScheduled)
        assertTrue(work.triggerArmed)
    }

    @Test fun `a command the server rejects is a failure and is dropped`() = runTest {
        val control = control()
        control.checkinNow()
        api.editErrors += httpError(400)
        val result = control.setPaused(true)
        assertTrue(result.isFailure)
        assertEquals(400, (result.exceptionOrNull() as SyncControlException).error!!.httpStatus)
        assertTrue(store.outbox.isEmpty())
    }

    @Test fun `retry failed resets the local ledger, tells the server once and syncs now`() = runTest {
        val control = control()
        control.checkinNow()
        work.events.clear()
        assertTrue(control.retryFailed().isSuccess)
        assertEquals(1, localRetries)
        assertEquals(1L, api.config.retryFailedGeneration)
        assertEquals(1L, store.appliedRetryGeneration)
        assertEquals(listOf("now:manual:REPLACE"), work.events)
    }

    @Test fun `a pending network patch already shows in the config and the constraints`() = runTest {
        val control = control()
        control.checkinNow()
        work.events.clear()
        api.editErrors += networkError()

        assertTrue(control.updateConfig(ConfigPatch(network = NetworkMode.ANY, requireCharging = true)).isSuccess)
        assertEquals(NetworkMode.ANY, control.currentConfig()!!.network)
        assertTrue(control.currentConfig()!!.requireCharging)
        assertEquals("periodic:UPDATE", work.events.first())
        assertTrue(work.periodicSpecs.last().requiresCharging)
    }

    @Test fun `a folder change confirmed by the server syncs now`() = runTest {
        val control = control()
        control.checkinNow()
        work.events.clear()
        assertTrue(control.updateConfig(ConfigPatch(folderIds = listOf("camera", "screenshots"))).isSuccess)
        assertEquals(listOf("camera", "screenshots"), control.currentConfig()!!.folderIds)
        assertTrue("now:manual:REPLACE" in work.events)
    }

    @Test fun `check-in now offline is a failure`() = runTest {
        val control = control()
        api.checkinError = networkError()
        assertTrue(control.checkinNow().isFailure)
    }

    @Test fun `every call fails when not paired`() = runTest {
        paired = false
        val control = control()
        assertTrue(control.setPaused(true).isFailure)
        assertTrue(control.retryFailed().isFailure)
        assertTrue(control.updateConfig(ConfigPatch(requireCharging = true)).isFailure)
        assertTrue(control.checkinNow().isFailure)
        assertTrue(api.calls.isEmpty())
    }

    @Test fun `opening the app while paused checks in so a web Start reaches the phone`() = runTest {
        val control = control()
        api.config = syncConfig(paused = true)
        control.checkinNow()
        api.calls.clear()
        api.config = syncConfig(paused = false)
        api.version++

        control.onAppOpen()
        testScheduler.advanceUntilIdle()
        assertEquals(listOf("checkin"), api.calls)
        assertFalse(control.currentConfig()!!.paused)
        assertTrue("now:manual:REPLACE" in work.events)
    }
}
