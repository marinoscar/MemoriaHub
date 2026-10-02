package memoriahub.marin.cr.sync

import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.net.SyncCommand
import memoriahub.marin.cr.testing.FakeApplierLedger
import memoriahub.marin.cr.testing.FakeHooks
import memoriahub.marin.cr.testing.syncConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ConfigApplierTest {
    private val store = InMemorySyncStateStore()
    private val ledger = FakeApplierLedger()
    private val hooks = FakeHooks()
    private val aborted = mutableListOf<String>()
    private val pairedAt = Instant.parse("2026-01-01T00:00:00Z")
    private val applier = ConfigApplier(store, ledger, hooks, { aborted += it }, { pairedAt })

    @Test fun `first apply persists, re-evaluates the scope and adopts the generations without acting`() = runTest {
        val result = applier.apply(syncConfig(retryGen = 4, syncGen = 7, uploadExisting = "from_pairing"), configVersion = 3)

        assertTrue(result.applied)
        assertFalse(result.syncNow)
        assertFalse(result.retried)
        assertEquals(0, ledger.retryFailedCalls)
        assertEquals(3, store.configVersion)
        assertEquals(3, store.appliedConfigVersion)
        assertEquals(4L, store.appliedRetryGeneration)
        assertEquals(7L, store.appliedSyncNowGeneration)
        assertEquals(setOf("camera"), ledger.scopes.single().folders)
        assertEquals(pairedAt.toEpochMilli(), ledger.scopes.single().pairedAtMs)
        assertEquals(listOf("constraints"), hooks.events)
    }

    @Test fun `a version that is not newer is ignored`() = runTest {
        applier.apply(syncConfig(), 5)
        hooks.events.clear()
        val again = applier.apply(syncConfig(network = "any", retryGen = 9), 5)
        val older = applier.apply(syncConfig(network = "any"), 4)

        assertFalse(again.applied)
        assertFalse(older.applied)
        assertEquals("wifi", store.config!!.network)
        assertEquals(0, ledger.retryFailedCalls)
        assertTrue(hooks.events.isEmpty())
    }

    @Test fun `each retryFailedGeneration delta fires exactly one retry`() = runTest {
        applier.apply(syncConfig(retryGen = 0), 1)
        val r1 = applier.apply(syncConfig(retryGen = 1), 2)
        val r2 = applier.apply(syncConfig(retryGen = 1, network = "any"), 3) // same generation, other change
        val r3 = applier.apply(syncConfig(retryGen = 3), 4) // jumped two: still one retry pass

        assertTrue(r1.retried)
        assertFalse(r2.retried)
        assertTrue(r3.retried)
        assertEquals(2, ledger.retryFailedCalls)
        assertEquals(2, ledger.retryBlockedCalls)
        assertEquals(3L, store.appliedRetryGeneration)
    }

    @Test fun `each syncNowGeneration delta reports exactly one manual sync`() = runTest {
        applier.apply(syncConfig(syncGen = 2), 1)
        val delta = applier.apply(syncConfig(syncGen = 3), 2)
        val same = applier.apply(syncConfig(syncGen = 3, network = "any"), 3)

        assertTrue(delta.syncNow)
        assertFalse(same.syncNow)
        assertEquals(3L, store.appliedSyncNowGeneration)
    }

    @Test fun `a command the phone sent itself adopts its generation without acting again`() = runTest {
        applier.apply(syncConfig(), 1)
        val own = applier.apply(syncConfig(retryGen = 1), 2, ownCommand = SyncCommand.RETRY_FAILED)
        val ownSync = applier.apply(syncConfig(retryGen = 1, syncGen = 1), 3, ownCommand = SyncCommand.SYNC_NOW)

        assertFalse(own.retried)
        assertFalse(ownSync.syncNow)
        assertEquals(0, ledger.retryFailedCalls)
        assertEquals(1L, store.appliedRetryGeneration)
        assertEquals(1L, store.appliedSyncNowGeneration)
    }

    @Test fun `paused cancels the sync work, resumed re-arms it`() = runTest {
        applier.apply(syncConfig(), 1)
        hooks.events.clear()

        val paused = applier.apply(syncConfig(paused = true), 2)
        assertTrue(paused.paused)
        assertEquals(listOf("cancel"), hooks.events)

        hooks.events.clear()
        val resumed = applier.apply(syncConfig(paused = false), 3)
        assertTrue(resumed.resumed)
        assertEquals(listOf("resume(runNow=true)"), hooks.events)
    }

    @Test fun `inside a run a resume re-arms without enqueueing now`() = runTest {
        applier.apply(syncConfig(paused = true), 1)
        hooks.events.clear()
        applier.apply(syncConfig(paused = false), 2, inRun = true)
        assertEquals(listOf("resume(runNow=false)"), hooks.events)
    }

    @Test fun `markers are stored before the work hooks run`() = runTest {
        // Cancelling the work may cancel the worker applying the config: the version must already be saved.
        var versionAtCancel = -1
        val probing = object : ConfigWorkHooks {
            override fun cancelSyncWork() {
                versionAtCancel = store.appliedConfigVersion
            }
            override fun resumeWork(runNow: Boolean) = Unit
            override fun constraintsMaybeChanged() = Unit
        }
        ConfigApplier(store, ledger, probing, {}, { null }).apply(syncConfig(paused = true), 6)
        assertEquals(6, versionAtCancel)
    }

    @Test fun `a scope change re-evaluates the ledger and aborts dropped sessions`() = runTest {
        applier.apply(syncConfig(folders = listOf("camera")), 1)
        ledger.abortIds = listOf("obj-1", "obj-2")
        val result = applier.apply(syncConfig(folders = listOf("camera", "screenshots")), 2)

        assertEquals(2, ledger.scopes.size)
        assertEquals(setOf("camera", "screenshots"), ledger.scopes.last().folders)
        assertEquals(listOf("obj-1", "obj-2"), aborted)
        assertEquals(listOf("obj-1", "obj-2"), result.scope!!.abortedObjectIds)
    }

    @Test fun `no scope change skips the ledger pass and a network change only touches constraints`() = runTest {
        applier.apply(syncConfig(), 1)
        hooks.events.clear()
        val result = applier.apply(syncConfig(network = "any"), 2)

        assertEquals(1, ledger.scopes.size)
        assertNull(result.scope)
        assertEquals(listOf("constraints"), hooks.events)
    }

    @Test fun `an abort failure never stops the apply`() = runTest {
        val failing = ConfigApplier(store, ledger, hooks, { throw IllegalStateException("boom") }, { null })
        ledger.abortIds = listOf("obj-1")
        val result = failing.apply(syncConfig(), 1)
        assertTrue(result.applied)
        assertEquals(1, store.appliedConfigVersion)
    }

    @Test fun `plan reports nothing for an old version and adopts the incoming generations on first apply`() {
        assertNull(ConfigApplier.plan(syncConfig(), 5, 0, 0, syncConfig(), 5))
        val first = ConfigApplier.plan(null, 0, null, null, syncConfig(retryGen = 2, syncGen = 2), 1)!!
        assertTrue(first.first)
        assertFalse(first.retryFailed)
        assertFalse(first.syncNow)
        assertTrue(first.scopeChanged)
    }
}
