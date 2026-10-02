package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.testing.RecordingSyncControl
import memoriahub.marin.cr.testing.ledgerRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FilesPresentationTest {
    @Test fun `tabs query the right ledger states`() {
        assertEquals(
            setOf(
                SyncFileState.DISCOVERED, SyncFileState.QUEUED, SyncFileState.HASHING, SyncFileState.UPLOADING,
                SyncFileState.REGISTERING, SyncFileState.FAILED, SyncFileState.BLOCKED,
            ),
            FilesTab.MISSING.states,
        )
        assertEquals(setOf(SyncFileState.FAILED), FilesTab.FAILED.states)
        assertEquals(setOf(SyncFileState.BLOCKED), FilesTab.BLOCKED.states)
        assertEquals(setOf(SyncFileState.UPLOADED, SyncFileState.DEDUPLICATED), FilesTab.SYNCED.states)
        assertFalse(SyncFileState.EXCLUDED in FilesTab.ALL.states)
        assertEquals(SyncFileState.entries.size - 1, FilesTab.ALL.states.size)
    }

    @Test fun `tab counts come from the same stats as the hub`() {
        val stats = SyncStats(eligible = 20, uploaded = 9, deduplicated = 1, pending = 5, uploading = 1, failed = 3, blocked = 1)
        assertEquals(10, FilesTab.MISSING.count(stats))
        assertEquals(3, FilesTab.FAILED.count(stats))
        assertEquals(1, FilesTab.BLOCKED.count(stats))
        assertEquals(10, FilesTab.SYNCED.count(stats))
        assertEquals(20, FilesTab.ALL.count(stats))
    }

    @Test fun `a failed row shows its error, attempts and next retry`() {
        val now = 1_000_000L
        val failed = ledgerRow(SyncFileState.FAILED, 7, attempts = 2, nextAttemptAt = now + 9 * 60_000, size = 2_500_000)
            .copy(lastError = "HTTP 503")
        val row = FilesPresentation.row(failed, now)
        assertEquals("IMG_7.jpg", row.name)
        assertEquals("DCIM/Camera", row.folder)
        assertEquals("Failed", row.status)
        assertEquals(ChipKind.ERROR, row.chip)
        assertEquals("HTTP 503", row.lastError)
        assertEquals("Next retry in 9 min", row.nextRetry)
        assertTrue(row.canRetry)
        assertFalse(row.isSynced)
        assertTrue(row.details.contains("2 attempts"))
        assertEquals("Retry due now", FilesPresentation.row(failed.copy(nextAttemptAt = now - 1), now).nextRetry)
    }

    @Test fun `synced and blocked rows`() {
        val synced = FilesPresentation.row(ledgerRow(SyncFileState.DEDUPLICATED, 1), 0)
        assertEquals("Already on server", synced.status)
        assertTrue(synced.isSynced)
        assertFalse(synced.canRetry)
        assertNull(synced.lastError)
        val blocked = FilesPresentation.row(ledgerRow(SyncFileState.BLOCKED, 2).copy(lastError = "File not found"), 0)
        assertTrue(blocked.canRetry)
        assertNull(blocked.nextRetry)
        assertEquals("File not found", blocked.lastError)
        assertEquals("Uploading", FilesPresentation.row(ledgerRow(SyncFileState.UPLOADING, 3), 0).status)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class FilesControllerTest {
    private class FakeLedger(var rows: List<SyncFileEntity>) : FilesLedger {
        val queries = mutableListOf<Pair<Set<SyncFileState>, Int>>()
        val retried = mutableListOf<Long>()
        var blockedRetried = 0
        override suspend fun filesIn(states: Collection<SyncFileState>, limit: Int): List<SyncFileEntity> {
            queries += states.toSet() to limit
            return rows.filter { it.state in states }.take(limit)
        }
        override suspend fun stats() = SyncStats(eligible = rows.size, failed = rows.count { it.state == SyncFileState.FAILED })
        override suspend fun retry(id: Long): Boolean {
            retried += id
            return rows.any { it.id == id && (it.state == SyncFileState.FAILED || it.state == SyncFileState.BLOCKED) }
        }
        override suspend fun retryBlocked(): Int { blockedRetried++; return rows.count { it.state == SyncFileState.BLOCKED } }
    }

    private fun rows(n: Int, state: SyncFileState) = (1..n).map { ledgerRow(state, it.toLong()).copy(id = it.toLong()) }

    private fun TestScope.controller(ledger: FakeLedger, control: RecordingSyncControl, paired: Boolean = true) =
        FilesController(ledger, control, { paired }, CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)), clock = { 0 })

    @Test fun `loads the missing tab with a page and knows when there is more`() = runTest {
        val ledger = FakeLedger(rows(FilesController.PAGE + 5, SyncFileState.QUEUED))
        val c = controller(ledger, RecordingSyncControl())
        c.reload(); advanceUntilIdle()
        assertEquals(FilesTab.MISSING.states to FilesController.PAGE + 1, ledger.queries.last())
        assertEquals(FilesController.PAGE, c.state.value.rows.size)
        assertTrue(c.state.value.hasMore)
        c.loadMore(); advanceUntilIdle()
        assertEquals(FilesController.PAGE + 5, c.state.value.rows.size)
        assertFalse(c.state.value.hasMore)
    }

    @Test fun `switching tabs queries that tab from the first page`() = runTest {
        val ledger = FakeLedger(rows(3, SyncFileState.FAILED))
        val c = controller(ledger, RecordingSyncControl())
        c.selectTab(FilesTab.FAILED); advanceUntilIdle()
        assertEquals(setOf(SyncFileState.FAILED) to FilesController.PAGE + 1, ledger.queries.last())
        assertEquals(3, c.state.value.rows.size)
        assertEquals(3, c.state.value.counts[FilesTab.FAILED])
    }

    @Test fun `per-row retry requeues in the ledger then syncs`() = runTest {
        val ledger = FakeLedger(rows(1, SyncFileState.FAILED))
        val control = RecordingSyncControl()
        val c = controller(ledger, control)
        c.retry(1); advanceUntilIdle()
        assertEquals(listOf(1L), ledger.retried)
        assertEquals(listOf("syncNow"), control.calls)
        assertEquals("Queued for upload", c.state.value.message)
    }

    @Test fun `retrying a row that already moved does not sync`() = runTest {
        val ledger = FakeLedger(rows(1, SyncFileState.UPLOADED))
        val control = RecordingSyncControl()
        val c = controller(ledger, control)
        c.retry(1); advanceUntilIdle()
        assertTrue(control.calls.isEmpty())
        assertEquals("This file is no longer waiting for a retry", c.state.value.message)
    }

    @Test fun `retry all failed goes through the control then syncs`() = runTest {
        val control = RecordingSyncControl()
        val c = controller(FakeLedger(rows(2, SyncFileState.FAILED)), control)
        c.retryAllFailed(); advanceUntilIdle()
        assertEquals(listOf("retryFailed", "syncNow"), control.calls)
    }

    @Test fun `retry blocked requeues blocked rows then syncs`() = runTest {
        val ledger = FakeLedger(rows(2, SyncFileState.BLOCKED))
        val control = RecordingSyncControl()
        val c = controller(ledger, control)
        c.retryBlocked(); advanceUntilIdle()
        assertEquals(1, ledger.blockedRetried)
        assertEquals(listOf("syncNow"), control.calls)
        assertEquals("Retrying 2 blocked files", c.state.value.message)
    }

    @Test fun `unpaired retries requeue but do not schedule a sync`() = runTest {
        val ledger = FakeLedger(rows(1, SyncFileState.FAILED))
        val control = RecordingSyncControl()
        val c = controller(ledger, control, paired = false)
        c.retry(1); advanceUntilIdle()
        assertEquals(listOf(1L), ledger.retried)
        assertTrue(control.calls.isEmpty())
    }
}
