package memoriahub.marin.cr.ledger

import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.ledger.SyncFileState.BLOCKED
import memoriahub.marin.cr.ledger.SyncFileState.DEDUPLICATED
import memoriahub.marin.cr.ledger.SyncFileState.EXCLUDED
import memoriahub.marin.cr.ledger.SyncFileState.FAILED
import memoriahub.marin.cr.ledger.SyncFileState.HASHING
import memoriahub.marin.cr.ledger.SyncFileState.QUEUED
import memoriahub.marin.cr.ledger.SyncFileState.REGISTERING
import memoriahub.marin.cr.ledger.SyncFileState.UPLOADED
import memoriahub.marin.cr.ledger.SyncFileState.UPLOADING
import memoriahub.marin.cr.testing.DirectTransactions
import memoriahub.marin.cr.testing.FakeSyncFileDao
import memoriahub.marin.cr.testing.ledgerRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RoomUploadLedgerTest {
    private val dao = FakeSyncFileDao()
    private var now = 50_000L
    private val ledger = RoomUploadLedger(dao, DirectTransactions) { now }

    @Test fun `happy path QUEUED to UPLOADED with parts persisted after each one`() = runTest {
        val id = dao.seed(ledgerRow(QUEUED, 1)).id
        ledger.markHashing(id)
        assertEquals(HASHING, dao.rows[id]!!.state)
        ledger.saveHash(id, "ABCDEF")
        assertEquals("abcdef", dao.rows[id]!!.contentHash)
        ledger.startUpload(id, "obj", "up", partSize = 5, totalParts = 3)
        with(dao.rows[id]!!) {
            assertEquals(UPLOADING, state)
            assertEquals("obj", objectId)
            assertEquals("up", uploadId)
            assertEquals(5L, partSize)
            assertEquals(3, totalParts)
        }
        ledger.recordPart(id, CompletedPart(1, "\"e1\""))
        assertEquals(listOf(CompletedPart(1, "\"e1\"")), dao.rows[id]!!.completedParts)
        ledger.recordPart(id, CompletedPart(2, "\"e2\""))
        ledger.recordPart(id, CompletedPart(2, "\"e2b\""))
        assertEquals(listOf(CompletedPart(1, "\"e1\""), CompletedPart(2, "\"e2b\"")), ledger.nextBatch(10, now).single().completedParts)
        ledger.markRegistering(id)
        assertEquals(REGISTERING, dao.rows[id]!!.state)
        now = 60_000
        ledger.markUploaded(id, "media-1")
        with(dao.rows[id]!!) {
            assertEquals(UPLOADED, state)
            assertEquals("media-1", mediaItemId)
            assertEquals(60_000L, uploadedAt)
            assertNull(objectId)
            assertNull(completedPartsJson)
            assertEquals("abcdef", contentHash)
        }
        assertTrue(ledger.nextBatch(10, now).isEmpty())
    }

    @Test fun `pre-check dedup from HASHING (T7) and registration dedup (T11)`() = runTest {
        val a = dao.seed(ledgerRow(QUEUED, 1)).id
        ledger.markHashing(a)
        ledger.markDeduplicated(a, "m-a")
        assertEquals(DEDUPLICATED, dao.rows[a]!!.state)
        assertEquals("m-a", dao.rows[a]!!.mediaItemId)

        val b = dao.seed(ledgerRow(REGISTERING, 2, objectId = "o")).id
        ledger.markDeduplicated(b, "m-b")
        assertEquals(DEDUPLICATED, dao.rows[b]!!.state)
        assertNull(dao.rows[b]!!.objectId)
    }

    @Test fun `failures back off 30s 2m 10m 1h and the 5th blocks`() = runTest {
        val id = dao.seed(ledgerRow(QUEUED, 1)).id
        val delays = listOf(30_000L, 120_000L, 600_000L, 3_600_000L)
        for ((n, delay) in delays.withIndex()) {
            ledger.markHashing(id)
            ledger.markFailed(id, "timeout", "NETWORK", retryable = true, nowMs = now)
            with(dao.rows[id]!!) {
                assertEquals(FAILED, state)
                assertEquals(n + 1, attempts)
                assertEquals(now + delay, nextAttemptAt)
                assertEquals("timeout", lastError)
                assertEquals("NETWORK", lastErrorCode)
            }
            assertTrue("not due before the backoff", ledger.nextBatch(10, now + delay - 1).isEmpty())
            assertEquals(id, ledger.nextBatch(10, now + delay).single().id)
        }
        ledger.markHashing(id)
        ledger.markFailed(id, "timeout", null, retryable = true, nowMs = now)
        with(dao.rows[id]!!) {
            assertEquals(BLOCKED, state)
            assertEquals(5, attempts)
            assertNull(nextAttemptAt)
        }
        assertTrue(ledger.nextBatch(10, Long.MAX_VALUE).isEmpty())
    }

    @Test fun `a non-retryable failure blocks immediately and keeps the session`() = runTest {
        val id = dao.seed(ledgerRow(UPLOADING, 1, objectId = "o")).id
        ledger.markFailed(id, "x".repeat(1_000), "FILE_TYPE", retryable = false, nowMs = now)
        with(dao.rows[id]!!) {
            assertEquals(BLOCKED, state)
            assertEquals(1, attempts)
            assertEquals(500, lastError!!.length)
            assertEquals("o", objectId)
        }
    }

    @Test fun `resuming a failed row with a session moves HASHING to UPLOADING on the first part`() = runTest {
        val id = dao.seed(ledgerRow(FAILED, 1, objectId = "o", attempts = 1, nextAttemptAt = 0)).id
        ledger.markHashing(id)
        assertEquals(HASHING, dao.rows[id]!!.state)
        ledger.recordPart(id, CompletedPart(2, "e2"))
        assertEquals(UPLOADING, dao.rows[id]!!.state)
        assertEquals("o", dao.rows[id]!!.objectId)

        // Crash between complete and registration: status says processing → straight to REGISTERING.
        val other = dao.seed(ledgerRow(FAILED, 2, objectId = "p", attempts = 1, nextAttemptAt = 0)).id
        ledger.markHashing(other)
        ledger.markRegistering(other)
        assertEquals(REGISTERING, dao.rows[other]!!.state)
    }

    @Test fun `resetUploadSession clears the session (T8) and startUpload re-inits`() = runTest {
        val id = dao.seed(ledgerRow(UPLOADING, 1, objectId = "o").copy(completedPartsJson = CompletedParts.encode(listOf(CompletedPart(1, "e"))))).id
        ledger.resetUploadSession(id)
        with(dao.rows[id]!!) {
            assertEquals(UPLOADING, state)
            assertNull(objectId)
            assertNull(uploadId)
            assertNull(completedPartsJson)
        }
        ledger.startUpload(id, "o2", null, 8, 1)
        assertEquals("o2", dao.rows[id]!!.objectId)
        ledger.replaceParts(id, listOf(CompletedPart(1, "x")))
        assertEquals(listOf(CompletedPart(1, "x")), dao.rows[id]!!.completedParts)
    }

    @Test fun `writes to an excluded or removed row are ignored`() = runTest {
        val id = dao.seed(ledgerRow(EXCLUDED, 1)).id
        ledger.recordPart(id, CompletedPart(1, "e"))
        ledger.markUploaded(id, "m")
        assertEquals(EXCLUDED, dao.rows[id]!!.state)
        assertFalse(ledger.isActive(id))
        ledger.markFailed(404, "gone", null, true, now)
        assertFalse(ledger.isActive(404))
        assertTrue(ledger.isActive(dao.seed(ledgerRow(UPLOADING, 2)).id))
    }

    @Test fun `session writes are ignored once the row holds no session (SOURCE_CHANGED mid-upload)`() = runTest {
        // The file changed under the upload: T12/T13 cleared the session and failed the row.
        val id = dao.seed(ledgerRow(FAILED, 1, attempts = 1, nextAttemptAt = 0)).id
        val before = dao.rows[id]!!
        ledger.savePartUploadAuth(id, "bearer")
        ledger.recordPart(id, CompletedPart(1, "\"late\""))
        ledger.replaceParts(id, listOf(CompletedPart(1, "\"late\"")))
        ledger.markRegistering(id)
        assertEquals(before, dao.rows[id]!!)
        assertEquals(FAILED, dao.rows[id]!!.state)
        assertNull(dao.rows[id]!!.completedPartsJson)
    }

    @Test fun `session writes still land while the row holds a session`() = runTest {
        val id = dao.seed(ledgerRow(UPLOADING, 1, objectId = "o")).id
        ledger.recordPart(id, CompletedPart(1, "e1"))
        ledger.markRegistering(id)
        assertEquals(REGISTERING, dao.rows[id]!!.state)
        assertEquals(listOf(CompletedPart(1, "e1")), dao.rows[id]!!.completedParts)
    }

    @Test fun `illegal engine writes throw in debug`() = runTest {
        val id = dao.seed(ledgerRow(UPLOADED, 1, objectId = "o")).id
        try {
            ledger.markRegistering(id)
            fail("UPLOADED -> REGISTERING is illegal")
        } catch (_: IllegalLedgerTransition) {
        }
    }

    @Test fun `LedgerFile carries what the engine needs`() = runTest {
        val id = dao.seed(ledgerRow(UPLOADING, 7, objectId = "o", attempts = 2).copy(contentHash = "h", partSize = 4, totalParts = 2)).id
        val file = ledger.nextBatch(1, now).single()
        assertEquals(id, file.id)
        assertEquals("content://media/external_primary/images/media/7", file.uri)
        assertEquals("h", file.contentHash)
        assertEquals("o", file.objectId)
        assertEquals("upload-o", file.uploadId)
        assertEquals(4L, file.partSize)
        assertEquals(2, file.totalParts)
        assertEquals(2, file.attempts)
        assertEquals("DCIM/Camera/", file.relativePath)
    }
}
