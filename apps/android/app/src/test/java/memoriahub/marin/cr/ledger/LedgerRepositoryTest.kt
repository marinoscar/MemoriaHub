package memoriahub.marin.cr.ledger

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import memoriahub.marin.cr.ledger.SyncFileState.BLOCKED
import memoriahub.marin.cr.ledger.SyncFileState.DEDUPLICATED
import memoriahub.marin.cr.ledger.SyncFileState.DISCOVERED
import memoriahub.marin.cr.ledger.SyncFileState.EXCLUDED
import memoriahub.marin.cr.ledger.SyncFileState.FAILED
import memoriahub.marin.cr.ledger.SyncFileState.HASHING
import memoriahub.marin.cr.ledger.SyncFileState.QUEUED
import memoriahub.marin.cr.ledger.SyncFileState.REGISTERING
import memoriahub.marin.cr.ledger.SyncFileState.UPLOADED
import memoriahub.marin.cr.ledger.SyncFileState.UPLOADING
import memoriahub.marin.cr.media.VolumeCursor
import memoriahub.marin.cr.testing.DirectTransactions
import memoriahub.marin.cr.testing.FakeScanCursorStore
import memoriahub.marin.cr.testing.FakeSyncFileDao
import memoriahub.marin.cr.testing.FakeSyncRunDao
import memoriahub.marin.cr.testing.ledgerRow
import memoriahub.marin.cr.testing.mediaRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LedgerRepositoryTest {
    private val dao = FakeSyncFileDao()
    private val runs = FakeSyncRunDao()
    private val cursors = FakeScanCursorStore()
    private var now = 10_000_000L
    private val repo = LedgerRepository(dao, runs, DirectTransactions, cursors) { now }
    private val scope = SyncScope(folders = setOf("camera"), includePhotos = true, includeVideos = true)

    // --- ingest -----------------------------------------------------------------------------

    @Test fun `new rows - eligible QUEUED, ineligible EXCLUDED`() = runTest {
        val result = repo.ingest(listOf(mediaRow(1), mediaRow(2, bucket = "whatsapp"), mediaRow(3, bucket = null)), scope)
        assertEquals(1, result.queued)
        assertEquals(2, result.excluded)
        assertEquals(QUEUED, dao.byMediaStoreId(1).state)
        assertEquals(EXCLUDED, dao.byMediaStoreId(2).state)
        assertEquals(EXCLUDED, dao.byMediaStoreId(3).state)
        assertTrue(dao.all().none { it.state == DISCOVERED })
        assertEquals(now, dao.byMediaStoreId(1).createdAt)
    }

    @Test fun `unchanged rows are not rewritten`() = runTest {
        repo.ingest(listOf(mediaRow(1)), scope)
        val before = dao.byMediaStoreId(1)
        now += 1_000
        val result = repo.ingest(listOf(mediaRow(1)), scope)
        assertEquals(1, result.unchanged)
        assertEquals(before, dao.byMediaStoreId(1))
    }

    @Test fun `changed size or mtime after upload re-queues a new version (T16)`() = runTest {
        val uploaded = dao.seed(
            ledgerRow(UPLOADED, 1).copy(uri = mediaRow(1).uri, contentHash = "abc", mediaItemId = "m1", uploadedAt = 5, attempts = 2),
        )
        val result = repo.ingest(listOf(mediaRow(1, size = 2_000)), scope)
        assertEquals(1, result.requeued)
        val row = dao.rows[uploaded.id]!!
        assertEquals(QUEUED, row.state)
        assertEquals(2_000, row.sizeBytes)
        assertNull(row.contentHash)
        assertNull(row.mediaItemId)
        assertNull(row.uploadedAt)
        assertEquals(0, row.attempts)

        val dedup = dao.seed(ledgerRow(DEDUPLICATED, 2).copy(uri = mediaRow(2).uri, mediaItemId = "m2"))
        repo.ingest(listOf(mediaRow(2, dateModifiedSec = 1_800_000_000)), scope)
        assertEquals(QUEUED, dao.rows[dedup.id]!!.state)
    }

    @Test fun `metadata-only change keeps the status`() = runTest {
        val row = dao.seed(ledgerRow(UPLOADED, 1).copy(uri = mediaRow(1).uri, mediaItemId = "m"))
        val result = repo.ingest(listOf(mediaRow(1, name = "renamed.jpg")), scope)
        assertEquals(1, result.refreshed)
        assertEquals(UPLOADED, dao.rows[row.id]!!.state)
        assertEquals("renamed.jpg", dao.rows[row.id]!!.displayName)
        assertEquals("m", dao.rows[row.id]!!.mediaItemId)
    }

    @Test fun `content change of a not-yet-uploaded row drops its hash and session`() = runTest {
        val row = dao.seed(ledgerRow(FAILED, 1, objectId = "o1").copy(contentHash = "abc", attempts = 2))
        repo.ingest(listOf(mediaRow(1, size = 5_000)), scope)
        val after = dao.rows[row.id]!!
        assertEquals(FAILED, after.state)
        assertNull(after.contentHash)
        assertNull(after.objectId)
        assertEquals(5_000, after.sizeBytes)
    }

    @Test fun `a file changed while uploading fails that attempt and is retried at once`() = runTest {
        val row = dao.seed(ledgerRow(UPLOADING, 1, objectId = "o1", attempts = 1).copy(contentHash = "abc"))
        val result = repo.ingest(listOf(mediaRow(1, size = 5_000)), scope)
        assertEquals(1, result.sourceChanged)
        val after = dao.rows[row.id]!!
        assertEquals(FAILED, after.state)
        assertEquals(2, after.attempts)
        assertEquals(now, after.nextAttemptAt)
        assertEquals(LedgerRepository.SOURCE_CHANGED, after.lastErrorCode)
        assertNull(after.objectId)
        assertNull(after.contentHash)

        val fourth = dao.seed(ledgerRow(HASHING, 2, attempts = 4))
        repo.ingest(listOf(mediaRow(2, size = 7)), scope)
        assertEquals("5th failure blocks", BLOCKED, dao.rows[fourth.id]!!.state)
    }

    @Test fun `a REGISTERING row is left alone so the next scan re-queues the new version`() = runTest {
        val row = dao.seed(ledgerRow(REGISTERING, 1, objectId = "o1"))
        repo.ingest(listOf(mediaRow(1, size = 9_999)), scope)
        assertEquals(row, dao.rows[row.id])
    }

    @Test fun `from_pairing excludes files taken before pairing`() = runTest {
        val paired = 1_700_000_000_000L
        val fp = scope.copy(uploadExisting = UploadExisting.FROM_PAIRING, pairedAtMs = paired)
        repo.ingest(listOf(mediaRow(1, dateTakenMs = paired - 1), mediaRow(2, dateTakenMs = paired + 1)), fp)
        assertEquals(EXCLUDED, dao.byMediaStoreId(1).state)
        assertEquals(QUEUED, dao.byMediaStoreId(2).state)
        // Switching back to 'all' restores the old file (D25).
        val change = repo.applyScope(fp.copy(uploadExisting = UploadExisting.ALL))
        assertEquals(1, change.requeued)
        assertEquals(QUEUED, dao.byMediaStoreId(1).state)
    }

    // --- folder selection -----------------------------------------------------------------------

    @Test fun `deselect excludes not-yet-uploaded rows, reselect re-queues them`() = runTest {
        val queued = dao.seed(ledgerRow(QUEUED, 1))
        val failed = dao.seed(ledgerRow(FAILED, 2, attempts = 2))
        val uploading = dao.seed(ledgerRow(UPLOADING, 3, objectId = "obj-3"))
        val registering = dao.seed(ledgerRow(REGISTERING, 4, objectId = "obj-4"))
        val uploaded = dao.seed(ledgerRow(UPLOADED, 5))
        val other = dao.seed(ledgerRow(QUEUED, 6, bucket = "screenshots"))

        val deselect = repo.applyFolderSelection(scope.copy(folders = setOf("screenshots")))
        assertEquals(3, deselect.excluded)
        assertEquals(listOf("obj-3"), deselect.abortedObjectIds)
        assertEquals(EXCLUDED, dao.rows[queued.id]!!.state)
        assertEquals(EXCLUDED, dao.rows[failed.id]!!.state)
        assertEquals(EXCLUDED, dao.rows[uploading.id]!!.state)
        assertNull("session dropped", dao.rows[uploading.id]!!.objectId)
        assertEquals("bytes complete: registration finishes", REGISTERING, dao.rows[registering.id]!!.state)
        assertEquals(UPLOADED, dao.rows[uploaded.id]!!.state)
        assertEquals(QUEUED, dao.rows[other.id]!!.state)

        val reselect = repo.applyFolderSelection(scope.copy(folders = setOf("camera", "screenshots")))
        assertEquals(3, reselect.requeued)
        listOf(queued, failed, uploading).forEach { assertEquals(QUEUED, dao.rows[it.id]!!.state) }
        assertEquals(UPLOADED, dao.rows[uploaded.id]!!.state)
    }

    @Test fun `type exclusion follows includePhotos and includeVideos`() = runTest {
        val photo = dao.seed(ledgerRow(QUEUED, 1))
        val video = dao.seed(ledgerRow(QUEUED, 2, isVideo = true))
        repo.applyScope(scope.copy(includeVideos = false))
        assertEquals(QUEUED, dao.rows[photo.id]!!.state)
        assertEquals(EXCLUDED, dao.rows[video.id]!!.state)
        repo.applyScope(scope)
        assertEquals(QUEUED, dao.rows[video.id]!!.state)
    }

    @Test fun `applyScope pages through many rows`() = runTest {
        repeat(2_500) { dao.seed(ledgerRow(QUEUED, it.toLong())) }
        assertEquals(2_500, repo.applyScope(scope.copy(folders = emptySet())).excluded)
        assertTrue(dao.all().all { it.state == EXCLUDED })
    }

    // --- vanished ---------------------------------------------------------------------------

    @Test fun `vanished removes only rows whose bytes are not complete`() = runTest {
        val ids = listOf(QUEUED, FAILED, BLOCKED, EXCLUDED, HASHING, UPLOADING, REGISTERING, UPLOADED, DEDUPLICATED)
            .mapIndexed { i, s -> dao.seed(ledgerRow(s, i.toLong())).id }
        assertEquals(6, repo.vanished(ids))
        assertEquals(setOf(REGISTERING, UPLOADED, DEDUPLICATED), dao.all().map { it.state }.toSet())
        assertEquals(0, repo.vanished(emptyList()))
    }

    // --- stats ------------------------------------------------------------------------------

    @Test fun `stats - every eligible row in exactly one bucket, FAILED only in failed (D8)`() = runTest {
        dao.seed(ledgerRow(QUEUED, 1, size = 10))
        dao.seed(ledgerRow(HASHING, 2, size = 20))
        dao.seed(ledgerRow(UPLOADING, 3, size = 30))
        dao.seed(ledgerRow(REGISTERING, 4, size = 40))
        dao.seed(ledgerRow(UPLOADED, 5, size = 50))
        dao.seed(ledgerRow(DEDUPLICATED, 6, size = 60))
        dao.seed(ledgerRow(FAILED, 7, size = 70, nextAttemptAt = 0)) // due
        dao.seed(ledgerRow(FAILED, 8, size = 80, nextAttemptAt = Long.MAX_VALUE)) // not due
        dao.seed(ledgerRow(BLOCKED, 9, size = 90, bucket = "whatsapp"))
        dao.seed(ledgerRow(EXCLUDED, 10, size = 100, bucket = "whatsapp"))

        val s = repo.stats()
        assertEquals(9, s.eligible)
        assertEquals(1, s.uploaded)
        assertEquals(1, s.deduplicated)
        assertEquals(2, s.pending)
        assertEquals(2, s.uploading)
        assertEquals(2, s.failed)
        assertEquals(1, s.blocked)
        assertEquals(1, s.excluded)
        assertEquals(s.eligible, s.uploaded + s.deduplicated + s.pending + s.uploading + s.failed + s.blocked)
        assertEquals(10L + 20 + 30 + 40 + 70 + 80 + 90, s.bytesPending)
        assertEquals(50L, s.bytesUploaded)
        assertEquals(2, s.synced)
        assertEquals(7, s.missing)

        assertEquals(8, s.perBucket["camera"]!!.eligible)
        assertEquals(1, s.perBucket["whatsapp"]!!.blocked)
        assertEquals(1, s.perBucket["whatsapp"]!!.excluded)
        assertEquals(1, s.perBucket["whatsapp"]!!.eligible)
    }

    @Test fun `check-in stats carry exactly the server keys`() = runTest {
        dao.seed(ledgerRow(QUEUED, 1))
        val json = Json.encodeToJsonElement(CheckinStats.serializer(), repo.stats().toCheckin()).jsonObject
        assertEquals(
            setOf("eligible", "uploaded", "deduplicated", "pending", "uploading", "failed", "blocked", "bytesPending", "bytesUploaded"),
            json.keys,
        )
    }

    @Test fun `empty ledger stats are zero`() = runTest {
        assertEquals(SyncStats(), repo.stats())
    }

    // --- nextBatch --------------------------------------------------------------------------

    @Test fun `nextBatch - resumes first, then QUEUED, then due FAILED, newest first`() = runTest {
        val oldQueued = dao.seed(ledgerRow(QUEUED, 1, dateTakenMs = 1_000))
        val newQueued = dao.seed(ledgerRow(QUEUED, 2, dateTakenMs = 3_000))
        val undated = dao.seed(ledgerRow(QUEUED, 3, dateTakenMs = null))
        val uploading = dao.seed(ledgerRow(UPLOADING, 4, dateTakenMs = 1, objectId = "o"))
        val registering = dao.seed(ledgerRow(REGISTERING, 5, dateTakenMs = 2, objectId = "o"))
        val dueFailed = dao.seed(ledgerRow(FAILED, 6, dateTakenMs = 9_999, nextAttemptAt = now))
        dao.seed(ledgerRow(FAILED, 7, nextAttemptAt = now + 1)) // backoff not elapsed
        dao.seed(ledgerRow(BLOCKED, 8))
        dao.seed(ledgerRow(HASHING, 9))
        dao.seed(ledgerRow(EXCLUDED, 10))

        val batch = repo.nextBatch(10, now).map { it.id }
        assertEquals(listOf(registering.id, uploading.id, newQueued.id, oldQueued.id, undated.id, dueFailed.id), batch)
        assertEquals(listOf(registering.id, uploading.id, newQueued.id), repo.nextBatch(3, now).map { it.id })
        assertEquals(emptyList<Long>(), repo.nextBatch(0, now).map { it.id })
        assertTrue("backoff elapses", 7L in repo.nextBatch(10, now + 1).map { dao.rows[it.id]!!.mediaStoreId })
    }

    @Test fun `recoverInterrupted sends HASHING leftovers back to QUEUED (T14)`() = runTest {
        val h = dao.seed(ledgerRow(HASHING, 1, attempts = 2))
        assertEquals(1, repo.recoverInterrupted())
        assertEquals(QUEUED, dao.rows[h.id]!!.state)
        assertEquals("not a failure", 2, dao.rows[h.id]!!.attempts)
    }

    // --- retry ------------------------------------------------------------------------------

    @Test fun `retry variants reset attempts and backoff (T15), keep lastError`() = runTest {
        val f1 = dao.seed(ledgerRow(FAILED, 1, attempts = 3, nextAttemptAt = now + 100).copy(lastError = "boom"))
        val f2 = dao.seed(ledgerRow(FAILED, 2, attempts = 1, nextAttemptAt = now + 100))
        val b1 = dao.seed(ledgerRow(BLOCKED, 3, attempts = 5))
        val b2 = dao.seed(ledgerRow(BLOCKED, 4, attempts = 5))
        val q = dao.seed(ledgerRow(QUEUED, 5))

        assertTrue(repo.retry(f1.id))
        with(dao.rows[f1.id]!!) {
            assertEquals(QUEUED, state)
            assertEquals(0, attempts)
            assertNull(nextAttemptAt)
            assertEquals("boom", lastError)
        }
        assertFalse("not FAILED/BLOCKED", repo.retry(q.id))
        assertFalse("gone", repo.retry(999))

        assertEquals(1, repo.retryFailed())
        assertEquals(QUEUED, dao.rows[f2.id]!!.state)
        assertEquals(BLOCKED, dao.rows[b1.id]!!.state)
        assertEquals(2, repo.retryBlocked())
        assertEquals(QUEUED, dao.rows[b2.id]!!.state)
        assertEquals(0, dao.rows[b2.id]!!.attempts)
    }

    @Test fun `failedSample lists failed and blocked files, newest first, capped at 50`() = runTest {
        repeat(60) { dao.seed(ledgerRow(FAILED, it.toLong(), attempts = 1, updatedAt = it.toLong()).copy(lastError = "x".repeat(900))) }
        dao.seed(ledgerRow(BLOCKED, 100, attempts = 5, updatedAt = 1_000).copy(lastError = "blocked"))
        dao.seed(ledgerRow(QUEUED, 101, updatedAt = 2_000))
        val sample = repo.failedSample()
        assertEquals(50, sample.size)
        assertEquals("IMG_100.jpg", sample.first().name)
        assertEquals(5, sample.first().attempts)
        assertEquals("DCIM/Camera/", sample.first().relativePath)
        assertTrue(sample.all { (it.lastError?.length ?: 0) <= 500 })
        assertEquals(3, repo.failedSample(3).size)
    }

    // --- runs and reset -----------------------------------------------------------------------

    @Test fun `runs keep the newest 50`() = runTest {
        repeat(55) { repo.recordRun(SyncRunEntity(trigger = "periodic", status = "ok", startedAt = it.toLong(), finishedAt = it + 1L)) }
        val recent = repo.recentRuns()
        assertEquals(50, recent.size)
        assertEquals(54L, recent.first().startedAt)
        assertEquals(5L, recent.last().startedAt)
    }

    @Test fun `resetLocalState clears the ledger and cursors, keeps runs`() = runTest {
        dao.seed(ledgerRow(UPLOADED, 1))
        cursors.setCursor("v", VolumeCursor(generation = 5))
        cursors.lastFullScanAtMs = 1
        repo.recordRun(SyncRunEntity(trigger = "manual", status = "ok", startedAt = 1, finishedAt = 2))
        repo.resetLocalState()
        assertTrue(repo.isEmpty())
        assertNull(cursors.cursor("v"))
        assertNull(cursors.lastFullScanAtMs)
        assertEquals(1, repo.recentRuns().size)
    }
}
