package memoriahub.marin.cr.ledger

import memoriahub.marin.cr.testing.ledgerRow
import memoriahub.marin.cr.testing.mediaRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class LedgerPolicyTest {
    private val scope = SyncScope(folders = setOf("camera"), includePhotos = true, includeVideos = false)

    @Test fun `eligible needs a selected bucket and an included type`() {
        assertTrue(LedgerPolicy.isEligible("camera", false, 1L, 1L, scope))
        assertFalse(LedgerPolicy.isEligible("whatsapp", false, 1L, 1L, scope))
        assertFalse(LedgerPolicy.isEligible(null, false, 1L, 1L, scope))
        assertFalse("videos excluded", LedgerPolicy.isEligible("camera", true, 1L, 1L, scope))
        assertTrue(LedgerPolicy.isEligible("camera", true, 1L, 1L, scope.copy(includeVideos = true)))
        assertTrue(SyncScope(emptySet(), true, true).isEmpty)
        assertTrue(SyncScope(setOf("a"), false, false).isEmpty)
    }

    @Test fun `from_pairing compares dateTaken (or dateModified) with pairedAt`() {
        val paired = 1_700_000_000_000L
        val fp = scope.copy(uploadExisting = UploadExisting.FROM_PAIRING, pairedAtMs = paired)
        assertTrue(LedgerPolicy.isEligible("camera", false, paired, 0, fp))
        assertTrue(LedgerPolicy.isEligible("camera", false, paired + 1, 0, fp))
        assertFalse(LedgerPolicy.isEligible("camera", false, paired - 1, 0, fp))
        // No dateTaken (or 0): falls back to DATE_MODIFIED (seconds).
        assertTrue(LedgerPolicy.isEligible("camera", false, null, paired / 1000, fp))
        assertFalse(LedgerPolicy.isEligible("camera", false, 0, paired / 1000 - 1, fp))
        // Unknown pairing time under from_pairing: nothing old is uploaded by surprise.
        assertFalse(LedgerPolicy.isEligible("camera", false, paired, 0, fp.copy(pairedAtMs = null)))
        // 'all' ignores the cut-off.
        assertTrue(LedgerPolicy.isEligible("camera", false, 1, 0, fp.copy(uploadExisting = UploadExisting.ALL)))
    }

    @Test fun `SyncScope from config fields`() {
        val s = SyncScope.of(listOf("a", "b", "a"), true, false, "from_pairing", Instant.ofEpochMilli(42))
        assertEquals(setOf("a", "b"), s.folders)
        assertEquals(UploadExisting.FROM_PAIRING, s.uploadExisting)
        assertEquals(42L, s.pairedAtMs)
        assertEquals(UploadExisting.ALL, UploadExisting.fromWire("bogus"))
        assertEquals(UploadExisting.ALL, UploadExisting.fromWire(null))
    }

    @Test fun `backoff is 30s 2m 10m 1h then blocked`() {
        val now = 1_000_000L
        assertEquals(now + 30_000, LedgerPolicy.nextAttemptAt(1, now))
        assertEquals(now + 120_000, LedgerPolicy.nextAttemptAt(2, now))
        assertEquals(now + 600_000, LedgerPolicy.nextAttemptAt(3, now))
        assertEquals(now + 3_600_000, LedgerPolicy.nextAttemptAt(4, now))
        assertNull(LedgerPolicy.nextAttemptAt(5, now))
    }

    @Test fun `reevaluate moves only what the config changes`() {
        assertEquals(SyncFileState.QUEUED, LedgerPolicy.reevaluate(SyncFileState.DISCOVERED, true))
        assertEquals(SyncFileState.EXCLUDED, LedgerPolicy.reevaluate(SyncFileState.DISCOVERED, false))
        assertEquals(SyncFileState.QUEUED, LedgerPolicy.reevaluate(SyncFileState.EXCLUDED, true))
        assertNull(LedgerPolicy.reevaluate(SyncFileState.EXCLUDED, false))
        for (s in listOf(SyncFileState.QUEUED, SyncFileState.FAILED, SyncFileState.BLOCKED, SyncFileState.HASHING, SyncFileState.UPLOADING)) {
            assertEquals(SyncFileState.EXCLUDED, LedgerPolicy.reevaluate(s, false))
            assertNull(LedgerPolicy.reevaluate(s, true))
        }
        for (s in listOf(SyncFileState.REGISTERING, SyncFileState.UPLOADED, SyncFileState.DEDUPLICATED)) {
            assertNull(LedgerPolicy.reevaluate(s, false))
            assertNull(LedgerPolicy.reevaluate(s, true))
        }
    }

    @Test fun `reconcile - queue, requeue on content change, refresh on metadata, unchanged`() {
        val row = mediaRow(1)
        assertEquals(ReconcileDecision.QUEUE, ReconcilePolicy.decide(null, row))
        val existing = ledgerRow(SyncFileState.UPLOADED, 1).copy(uri = row.uri, bucketName = row.bucketName)
        assertEquals(ReconcileDecision.UNCHANGED, ReconcilePolicy.decide(existing, row))
        assertEquals(ReconcileDecision.REQUEUE, ReconcilePolicy.decide(existing, row.copy(sizeBytes = 2_000)))
        assertEquals(ReconcileDecision.REQUEUE, ReconcilePolicy.decide(existing, row.copy(dateModifiedSec = row.dateModifiedSec + 1)))
        assertEquals(ReconcileDecision.REFRESH_META, ReconcilePolicy.decide(existing, row.copy(displayName = "renamed.jpg")))
        assertEquals(ReconcileDecision.REFRESH_META, ReconcilePolicy.decide(existing, row.copy(uri = "content://x")))
        assertEquals(
            "content change wins over metadata drift",
            ReconcileDecision.REQUEUE,
            ReconcilePolicy.decide(existing, row.copy(displayName = "x.jpg", sizeBytes = 5)),
        )
    }

    @Test fun `vanished is scoped to what the scan could see`() {
        val candidates = listOf(
            SyncFileScopeRow(1, 101, "v", "camera", false, null, 0, SyncFileState.QUEUED),
            SyncFileScopeRow(2, 102, "v", "camera", false, null, 0, SyncFileState.QUEUED), // seen
            SyncFileScopeRow(3, 103, "v", "other", false, null, 0, SyncFileState.EXCLUDED), // bucket not scanned
            SyncFileScopeRow(4, 104, "v", "camera", true, null, 0, SyncFileState.QUEUED), // type not scanned
            SyncFileScopeRow(5, 105, "v", "camera", false, null, 0, SyncFileState.UPLOADED), // terminal
        )
        assertEquals(listOf(1L), ReconcilePolicy.vanished(candidates, setOf(102L), scope))
    }

    @Test fun `errors are truncated to the check-in limit`() {
        assertEquals("short", LedgerPolicy.truncateError("short"))
        assertEquals(500, LedgerPolicy.truncateError("x".repeat(2_000)).length)
    }

    @Test fun `completed parts json round trip, dedup by part number`() {
        val parts = listOf(CompletedPart(2, "\"b\""), CompletedPart(1, "\"a\""), CompletedPart(2, "\"c\""))
        val json = CompletedParts.encode(parts)!!
        assertEquals(listOf(CompletedPart(1, "\"a\""), CompletedPart(2, "\"c\"")), CompletedParts.decode(json))
        assertNull(CompletedParts.encode(emptyList()))
        assertEquals(emptyList<CompletedPart>(), CompletedParts.decode(null))
        assertEquals(emptyList<CompletedPart>(), CompletedParts.decode("not json"))
        assertEquals(
            listOf(CompletedPart(1, "a"), CompletedPart(2, "z")),
            CompletedParts.plus(listOf(CompletedPart(1, "a"), CompletedPart(2, "b")), CompletedPart(2, "z")),
        )
    }
}
