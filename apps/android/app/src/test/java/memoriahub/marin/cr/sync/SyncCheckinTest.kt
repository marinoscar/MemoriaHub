package memoriahub.marin.cr.sync

import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.net.SyncCommand
import memoriahub.marin.cr.pairing.ApiErrorReaction
import memoriahub.marin.cr.testing.FakeApplierLedger
import memoriahub.marin.cr.testing.FakeCheckinApi
import memoriahub.marin.cr.testing.FakeDeviceStateReader
import memoriahub.marin.cr.testing.FakeHooks
import memoriahub.marin.cr.testing.httpError
import memoriahub.marin.cr.testing.networkError
import memoriahub.marin.cr.testing.syncConfig
import memoriahub.marin.cr.testing.testReactions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncCheckinTest {
    private val api = FakeCheckinApi(syncConfig(), version = 1)
    private val store = InMemorySyncStateStore()
    private val ledger = FakeApplierLedger()
    private val hooks = FakeHooks()
    private val device = FakeDeviceStateReader()
    private var deviceId: String? = "dev-1"
    private var now = 1_000_000L
    private val checkin = SyncCheckin(
        api = api,
        store = store,
        applier = ConfigApplier(store, ledger, hooks, {}, { null }),
        reactions = testReactions,
        device = device,
        deviceId = { deviceId },
        appVersion = "1.0.0",
        appVersionCode = 10,
        clock = { now },
    )

    @Test fun `check-in applies the returned config and records the time`() = runTest {
        val outcome = checkin.checkin()
        assertTrue((outcome as CheckinOutcome.Applied).apply.applied)
        assertEquals(1, store.configVersion)
        assertEquals(1, store.appliedConfigVersion)
        assertEquals(now, store.lastCheckinAtMs)
        assertEquals("1.0.0", api.checkins.single().appVersion)
        assertEquals(0, api.checkins.single().appliedConfigVersion)
    }

    @Test fun `not paired sends nothing`() = runTest {
        deviceId = null
        assertEquals(CheckinOutcome.NotPaired, checkin.checkin())
        assertFalse(checkin.enqueueCommand(SyncCommand.PAUSE))
        assertTrue(api.calls.isEmpty())
    }

    @Test fun `the outbox is replayed before the check-in, never carried in it`() = runTest {
        checkin.checkin()
        checkin.enqueueCommand(SyncCommand.PAUSE)
        checkin.enqueuePatch(StoredPatch(network = "any"))
        api.calls.clear()

        val outcome = checkin.checkin() as CheckinOutcome.Applied
        assertEquals(listOf("command:pause", "patch", "checkin"), api.calls)
        assertTrue(store.outbox.isEmpty())
        assertTrue(outcome.apply.paused)
        assertEquals("any", store.config!!.network)
        assertTrue(store.config!!.paused)
        assertEquals(3, store.appliedConfigVersion)
    }

    @Test fun `offline keeps the outbox and skips the check-in`() = runTest {
        checkin.checkin()
        checkin.enqueueCommand(SyncCommand.PAUSE)
        api.editErrors += networkError()
        api.calls.clear()

        val outcome = checkin.checkin() as CheckinOutcome.Failed
        assertTrue(outcome.transient)
        assertEquals(ApiErrorReaction.NONE, outcome.reaction)
        assertEquals(listOf("command:pause"), api.calls)
        assertEquals(listOf(OutboxEntry(command = "pause")), store.outbox)
        // The local pause still holds while the command waits.
        assertTrue(effectivePaused(store))
    }

    @Test fun `a 5xx also keeps the outbox`() = runTest {
        checkin.checkin()
        checkin.enqueuePatch(StoredPatch(requireCharging = true))
        api.editErrors += httpError(503)
        assertTrue((checkin.flushOutbox() as CheckinOutcome.Failed).transient)
        assertEquals(1, store.outbox.size)
    }

    @Test fun `a rejected edit is dropped, reported, and the rest of the outbox continues`() = runTest {
        checkin.checkin()
        checkin.enqueuePatch(StoredPatch(folderIds = listOf("ghost")))
        checkin.enqueueCommand(SyncCommand.RETRY_FAILED)
        api.editErrors += httpError(400, "UNKNOWN_FOLDER")

        val outcome = checkin.checkin() as CheckinOutcome.Applied
        assertEquals("UNKNOWN_FOLDER", outcome.rejected!!.reason)
        assertTrue(store.outbox.isEmpty())
        assertEquals(listOf("checkin", "patch", "command:retry_failed", "checkin"), api.calls)
        // The phone's own retry command is adopted, not re-acted on.
        assertEquals(0, ledger.retryFailedCalls)
        assertEquals(1L, store.appliedRetryGeneration)
    }

    @Test fun `a folder patch carries the inventory so new folders validate`() = runTest {
        checkin.checkin()
        device.inventory = listOf(Bucket("camera", "Camera", "DCIM/Camera/", 1, 0, 10), Bucket("new", "New", "Pictures/New/", 2, 0, 20))
        checkin.enqueuePatch(StoredPatch(folderIds = listOf("camera", "new", "new")))
        checkin.flushOutbox()
        val patch = api.patches.single()
        assertEquals(listOf("camera", "new"), patch.folders!!.map { it.bucketId })
        assertEquals("New", patch.folders!![1].name)
        assertEquals(2, patch.inventory!!.size)
    }

    @Test fun `a non-folder patch sends no inventory`() = runTest {
        checkin.checkin()
        checkin.enqueuePatch(StoredPatch(network = "any"))
        checkin.flushOutbox()
        assertNull(api.patches.single().inventory)
        assertNull(api.patches.single().folders)
    }

    @Test fun `a revoked device stops at the outbox with the reaction`() = runTest {
        checkin.checkin()
        checkin.enqueueCommand(SyncCommand.RESUME)
        api.editErrors += httpError(409, MediaSyncReasons.DEVICE_REVOKED)
        api.calls.clear()
        val outcome = checkin.checkin() as CheckinOutcome.Failed
        assertEquals(ApiErrorReaction.DEVICE_REVOKED, outcome.reaction)
        assertEquals(listOf("command:resume"), api.calls)
    }

    @Test fun `a 401 at check-in reports pairing expired`() = runTest {
        api.checkinError = httpError(401)
        val outcome = checkin.checkin() as CheckinOutcome.Failed
        assertEquals(ApiErrorReaction.PAIRING_EXPIRED, outcome.reaction)
        assertFalse(outcome.transient)
        assertNull(store.lastCheckinAtMs)
    }

    @Test fun `inventory is sent once, then only when it changes or after 24h`() = runTest {
        checkin.checkin()
        checkin.checkin()
        assertNotNull(api.checkins[0].inventory)
        assertNull(api.checkins[1].inventory)

        device.inventory = device.inventory + Bucket("x", "X", "x/", 1, 0, 1)
        checkin.checkin()
        assertNotNull(api.checkins[2].inventory)

        now += CheckinPayload.INVENTORY_RESEND_MS
        checkin.checkin()
        assertNotNull(api.checkins[3].inventory)
    }

    @Test fun `a failed check-in does not mark the inventory as sent`() = runTest {
        api.checkinError = networkError()
        checkin.checkin()
        api.checkinError = null
        checkin.checkin()
        assertNotNull(api.checkins.last().inventory)
    }

    @Test fun `the run record goes out with the check-in after`() = runTest {
        val record = SyncRunRecord(SyncTrigger.PERIODIC, RunStatus.OK, 1_000, 2_000, filesUploaded = 3)
        checkin.checkin(run = record)
        assertEquals("periodic", api.checkins.single().run!!.trigger)
        assertEquals(3, api.checkins.single().run!!.filesUploaded)
    }

    @Test fun `a re-pair as a new device resets the stored state`() = runTest {
        checkin.checkin()
        api.version = 9
        checkin.checkin()
        assertEquals(9, store.appliedConfigVersion)

        deviceId = "dev-2"
        api.version = 1
        checkin.checkin()
        assertEquals("dev-2", store.deviceId)
        assertEquals(1, store.appliedConfigVersion)
        assertEquals(0, api.checkins.last().appliedConfigVersion)
    }

    @Test fun `pause then resume while offline collapses to the newest toggle`() = runTest {
        checkin.checkin()
        checkin.enqueueCommand(SyncCommand.PAUSE)
        checkin.enqueueCommand(SyncCommand.RETRY_FAILED)
        checkin.enqueueCommand(SyncCommand.RESUME)
        assertEquals(listOf(OutboxEntry(command = "retry_failed"), OutboxEntry(command = "resume")), store.outbox)
    }

    @Test fun `isTransient covers network, 429 and 5xx only`() {
        assertTrue(SyncCheckin.isTransient(networkError()))
        assertTrue(SyncCheckin.isTransient(httpError(429)))
        assertTrue(SyncCheckin.isTransient(httpError(502)))
        assertFalse(SyncCheckin.isTransient(httpError(400)))
        assertFalse(SyncCheckin.isTransient(httpError(409)))
    }
}
