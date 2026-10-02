package memoriahub.marin.cr.sync

import androidx.work.NetworkType
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.testing.FakeSyncWork
import memoriahub.marin.cr.testing.syncConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncConstraintsTest {
    @Test fun `wifi maps to UNMETERED, any to CONNECTED, storage-not-low always`() {
        val wifi = SyncConstraintSpec.of(NetworkMode.WIFI, requireCharging = false)
        val any = SyncConstraintSpec.of(NetworkMode.ANY, requireCharging = false)
        assertEquals(NetworkType.UNMETERED, wifi.networkType)
        assertEquals(NetworkType.CONNECTED, any.networkType)
        assertTrue(wifi.requiresStorageNotLow)
        assertTrue(any.requiresStorageNotLow)
        assertFalse(wifi.requiresCharging)
    }

    @Test fun `requireCharging adds the charging constraint and makes the run non-expedited`() {
        val charging = SyncConstraintSpec.of(syncConfig(requireCharging = true))
        assertTrue(charging.requiresCharging)
        assertFalse(charging.expeditable)
        assertTrue(SyncConstraintSpec.of(syncConfig()).expeditable)
    }

    @Test fun `config without a known network defaults to wifi, no config means the server defaults`() {
        assertEquals(NetworkType.UNMETERED, SyncConstraintSpec.of(syncConfig(network = "bogus")).networkType)
        assertEquals(SyncConstraintSpec.of(NetworkMode.WIFI, false), SyncConstraintSpec.of(null as DeviceSyncConfig?))
    }

    @Test fun `the hash changes with every constraint`() {
        val base = SyncConstraintSpec.of(NetworkMode.WIFI, false).hash
        assertNotEquals(base, SyncConstraintSpec.of(NetworkMode.ANY, false).hash)
        assertNotEquals(base, SyncConstraintSpec.of(NetworkMode.WIFI, true).hash)
        assertEquals(base, SyncConstraintSpec.of(NetworkMode.WIFI, false).hash)
    }
}

class MediaSyncSchedulerTest {
    private val work = FakeSyncWork()
    private val store = InMemorySyncStateStore().apply { config = syncConfig() }
    private var paired = true
    private var now = 1_000_000L
    private val scheduler = MediaSyncScheduler(work, store, isPaired = { paired }, clock = { now })

    @Test fun `ensurePeriodic updates once per constraints change, then keeps`() {
        scheduler.ensurePeriodic()
        scheduler.ensurePeriodic()
        store.config = syncConfig(network = "any")
        scheduler.ensurePeriodic()

        assertEquals(
            listOf("periodic:UPDATE", "trigger:KEEP", "periodic:KEEP", "trigger:KEEP", "periodic:UPDATE", "trigger:KEEP"),
            work.events,
        )
        assertEquals(NetworkType.CONNECTED, work.periodicSpecs.last().networkType)
    }

    @Test fun `a pending local network patch already drives the constraints`() {
        store.outbox = listOf(OutboxEntry(patch = StoredPatch(network = "any", requireCharging = true)))
        scheduler.ensurePeriodic()
        assertEquals(NetworkType.CONNECTED, work.periodicSpecs.single().networkType)
        assertTrue(work.periodicSpecs.single().requiresCharging)
    }

    @Test fun `nothing is scheduled while unpaired or paused`() {
        paired = false
        scheduler.ensurePeriodic()
        scheduler.syncNow(SyncTrigger.MANUAL)
        paired = true
        store.config = syncConfig(paused = true)
        scheduler.ensurePeriodic()
        scheduler.syncNow(SyncTrigger.MANUAL)
        assertTrue(work.events.isEmpty())
    }

    @Test fun `a pending local pause wins over the cached config`() {
        store.outbox = listOf(OutboxEntry(command = "pause"))
        scheduler.syncNow(SyncTrigger.MANUAL)
        assertTrue(work.events.isEmpty())
        store.outbox = listOf(OutboxEntry(command = "pause"), OutboxEntry(command = "resume"))
        scheduler.syncNow(SyncTrigger.MANUAL)
        assertEquals(listOf("now:manual:REPLACE"), work.events)
    }

    @Test fun `now policy is REPLACE for manual and initial, KEEP for app open and triggers`() {
        assertEquals(NowPolicy.REPLACE, MediaSyncScheduler.policyFor(SyncTrigger.MANUAL))
        assertEquals(NowPolicy.REPLACE, MediaSyncScheduler.policyFor(SyncTrigger.INITIAL))
        assertEquals(NowPolicy.KEEP, MediaSyncScheduler.policyFor(SyncTrigger.APP_OPEN))
        assertEquals(NowPolicy.KEEP, MediaSyncScheduler.policyFor(SyncTrigger.CONTENT_TRIGGER))
        scheduler.syncNow(SyncTrigger.INITIAL)
        assertEquals(listOf("now:initial:REPLACE"), work.events)
    }

    @Test fun `the content trigger runs now with KEEP and re-arms itself with REPLACE`() {
        scheduler.onContentTriggered()
        assertEquals(listOf("now:content_trigger:KEEP", "trigger:REPLACE"), work.events)
        assertEquals(now, store.lastContentTriggerAtMs)
        assertTrue(work.isContentTriggerArmed())
    }

    @Test fun `a paused content trigger records the time but does not re-arm`() {
        store.config = syncConfig(paused = true)
        scheduler.onContentTriggered()
        assertTrue(work.events.isEmpty())
        assertEquals(now, store.lastContentTriggerAtMs)
    }

    @Test fun `app open is debounced to 15 minutes`() {
        assertEquals(MediaSyncScheduler.AppOpenAction.SYNC, scheduler.onAppOpen())
        now += 14 * 60_000
        assertEquals(MediaSyncScheduler.AppOpenAction.DEBOUNCED, scheduler.onAppOpen())
        now += 60_000
        assertEquals(MediaSyncScheduler.AppOpenAction.SYNC, scheduler.onAppOpen())
        assertEquals(2, work.events.count { it == "now:app_open:KEEP" })
    }

    @Test fun `app open while paused only asks for a check-in, unpaired does nothing`() {
        store.config = syncConfig(paused = true)
        assertEquals(MediaSyncScheduler.AppOpenAction.CHECKIN_ONLY, scheduler.onAppOpen())
        assertTrue(work.events.isEmpty())
        paired = false
        now += 3_600_000
        assertEquals(MediaSyncScheduler.AppOpenAction.NONE, scheduler.onAppOpen())
    }

    @Test fun `appOpenDue handles first run and a clock that went backwards`() {
        assertTrue(MediaSyncScheduler.appOpenDue(null, 0))
        assertFalse(MediaSyncScheduler.appOpenDue(1_000, 1_000 + 60_000))
        assertTrue(MediaSyncScheduler.appOpenDue(1_000, 1_000 + 15 * 60_000))
        assertTrue(MediaSyncScheduler.appOpenDue(10_000, 5_000))
    }

    @Test fun `resume re-arms periodic and trigger and runs now`() {
        scheduler.resumeWork(runNow = true)
        assertEquals(listOf("periodic:UPDATE", "trigger:KEEP", "now:manual:REPLACE"), work.events)
    }

    @Test fun `cancelAll clears the stored hash so the next schedule updates`() {
        scheduler.ensurePeriodic()
        scheduler.cancelAll()
        scheduler.ensurePeriodic()
        assertEquals(listOf("periodic:UPDATE", "trigger:KEEP", "cancelAll", "periodic:UPDATE", "trigger:KEEP"), work.events)
    }
}
