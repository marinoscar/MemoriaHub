package memoriahub.marin.cr.media

import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncScope
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.DirectTransactions
import memoriahub.marin.cr.testing.FakeMediaGateway
import memoriahub.marin.cr.testing.FakeScanCursorStore
import memoriahub.marin.cr.testing.FakeSharedPreferences
import memoriahub.marin.cr.testing.FakeSyncFileDao
import memoriahub.marin.cr.testing.FakeSyncRunDao
import memoriahub.marin.cr.testing.mediaRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaScannerTest {
    private val gateway = FakeMediaGateway()
    private val dao = FakeSyncFileDao()
    private val cursors = FakeScanCursorStore()
    private var now = 1_800_000_000_000L
    private val ledger = LedgerRepository(dao, FakeSyncRunDao(), DirectTransactions, cursors) { now }
    private val scanner = MediaScanner(gateway, ledger, cursors) { now }
    private val scope = SyncScope(folders = setOf("camera"), includePhotos = true, includeVideos = true)
    private val volume = FakeMediaGateway.VOLUME

    @Test fun `first scan is full and stores the generation captured before it`() = runTest {
        gateway.put(mediaRow(1))
        gateway.put(mediaRow(2, bucket = "whatsapp"))
        gateway.put(mediaRow(3, isVideo = true))
        val result = scanner.scan(scope)
        assertTrue(result.wasFull)
        assertEquals(2, result.rowsSeen)
        assertEquals(2, result.ingest.queued)
        assertTrue(gateway.scans.single().isFull)
        assertEquals(3L, cursors.cursor(volume)!!.generation)
        assertEquals(now, cursors.lastFullScanAtMs)
        assertEquals(setOf(1L, 3L), dao.all().map { it.mediaStoreId }.toSet())
    }

    @Test fun `incremental scans use the generation cursor`() = runTest {
        gateway.put(mediaRow(1))
        scanner.scan(scope)
        gateway.put(mediaRow(2))
        gateway.put(mediaRow(1, size = 5_000)) // modified
        val result = scanner.scan(scope)
        assertFalse(result.wasFull)
        assertEquals(ScanCursor(volume, sinceGeneration = 1), gateway.scans.last())
        assertEquals(2, result.rowsSeen)
        assertEquals(1, result.ingest.queued)
        assertEquals(1, result.ingest.refreshed)
        assertEquals(3L, cursors.cursor(volume)!!.generation)
    }

    @Test fun `below API 30 incremental scans fall back to DATE_MODIFIED`() = runTest {
        gateway.useGenerations = false
        gateway.put(mediaRow(1, dateModifiedSec = 1_000))
        scanner.scan(scope)
        assertNull(cursors.cursor(volume)!!.generation)
        assertEquals(now / 1000, cursors.cursor(volume)!!.dateModifiedSec)
        gateway.put(mediaRow(2, dateModifiedSec = now / 1000 + 5))
        val result = scanner.scan(scope)
        assertEquals(ScanCursor(volume, sinceDateModifiedSec = now / 1000), gateway.scans.last())
        assertEquals(1, result.rowsSeen)
        assertEquals(2, dao.all().size)
    }

    @Test fun `a MediaStore version change forces a full scan`() = runTest {
        gateway.versions[volume] = "v1"
        gateway.put(mediaRow(1))
        scanner.scan(scope)
        gateway.versions[volume] = "v2"
        scanner.scan(scope)
        assertTrue(gateway.scans.last().isFull)
        assertEquals("v2", cursors.cursor(volume)!!.mediaStoreVersion)
    }

    @Test fun `widening the scope forces a full scan, narrowing does not`() = runTest {
        gateway.put(mediaRow(1))
        gateway.put(mediaRow(2, bucket = "screenshots"))
        scanner.scan(scope)
        scanner.scan(scope.copy(includeVideos = false))
        assertFalse(gateway.scans.last().isFull)
        scanner.scan(scope.copy(folders = setOf("camera", "screenshots")))
        assertTrue(gateway.scans.last().isFull)
        assertEquals(2, dao.all().size)
        scanner.scan(scope.copy(folders = setOf("camera", "screenshots")))
        assertFalse(gateway.scans.last().isFull)
    }

    @Test fun `a full scan with full permission removes vanished files`() = runTest {
        gateway.put(mediaRow(1))
        gateway.put(mediaRow(2))
        scanner.scan(scope)
        gateway.delete(2)
        assertEquals(0, scanner.scan(scope).vanished)
        assertEquals("incremental scans never infer deletion", 2, dao.all().size)
        val full = scanner.scan(scope, full = true)
        assertEquals(1, full.vanished)
        assertEquals(listOf(1L), dao.all().map { it.mediaStoreId })
    }

    @Test fun `partial permission never infers deletion`() = runTest {
        gateway.put(mediaRow(1))
        gateway.put(mediaRow(2))
        scanner.scan(scope)
        gateway.delete(2)
        gateway.permission = MediaPermissionState.PARTIAL
        val result = scanner.scan(scope, full = true)
        assertEquals(0, result.vanished)
        assertEquals(2, dao.all().size)
    }

    @Test fun `denied permission skips the scan and leaves the ledger untouched`() = runTest {
        gateway.put(mediaRow(1))
        scanner.scan(scope)
        val before = dao.all()
        gateway.permission = MediaPermissionState.DENIED
        gateway.rows.clear()
        val result = scanner.scan(scope, full = true)
        assertTrue(result.skipped)
        assertEquals(before, dao.all())
        assertEquals(emptyList<Bucket>(), scanner.inventory())
    }

    @Test fun `a permission lost mid-scan does not advance cursors`() = runTest {
        gateway.put(mediaRow(1))
        scanner.scan(scope)
        val cursor = cursors.cursor(volume)
        gateway.put(mediaRow(2))
        gateway.throwOnScan = SecurityException("revoked")
        val result = scanner.scan(scope)
        assertTrue(result.permissionLost)
        assertEquals(cursor, cursors.cursor(volume))
        assertEquals(1, dao.all().size)
    }

    @Test fun `an empty scope scans nothing`() = runTest {
        gateway.put(mediaRow(1))
        assertTrue(scanner.scan(scope.copy(folders = emptySet())).skipped)
        assertTrue(gateway.scans.isEmpty())
    }

    @Test fun `every volume has its own cursor`() = runTest {
        gateway.volumeNames += "1234-abcd"
        gateway.put(mediaRow(1))
        gateway.put(mediaRow(1, volume = "1234-abcd"))
        gateway.put(mediaRow(2, volume = "1234-abcd"))
        scanner.scan(scope)
        assertEquals(1L, cursors.cursor(volume)!!.generation)
        assertEquals(2L, cursors.cursor("1234-abcd")!!.generation)
        assertEquals(3, dao.all().size)
        assertEquals(SyncFileState.QUEUED, dao.byMediaStoreId(1, "1234-abcd").state)
    }

    @Test fun `full scan is due daily`() {
        assertTrue(scanner.fullScanDue(now))
        cursors.lastFullScanAtMs = now
        assertFalse(scanner.fullScanDue(now + 1_000))
        assertTrue(scanner.fullScanDue(now + MediaScanner.FULL_SCAN_INTERVAL_MS))
        assertTrue("clock went backwards", scanner.fullScanDue(now - 1))
    }

    @Test fun `inventory is capped at 500 buckets`() {
        repeat(600) { gateway.put(mediaRow(it.toLong(), bucket = "b$it")) }
        assertEquals(500, scanner.inventory().size)
    }

    @Test fun `shared-prefs cursor store round trip`() {
        val store = SharedPrefsScanCursorStore(FakeSharedPreferences())
        assertNull(store.cursor("v"))
        store.setCursor("v", VolumeCursor(generation = 7, dateModifiedSec = 9, mediaStoreVersion = "x"))
        assertEquals(VolumeCursor(7, 9, "x"), store.cursor("v"))
        store.lastFullScanAtMs = 5
        assertEquals(5L, store.lastFullScanAtMs)
        store.scannedScope = ScannedScope(setOf("a"), true, false)
        assertEquals(ScannedScope(setOf("a"), true, false), store.scannedScope)
        store.clear()
        assertNull(store.cursor("v"))
        assertNull(store.lastFullScanAtMs)
        assertNull(store.scannedScope)
    }

    @Test fun `scanned scope widening rules`() {
        val s = ScannedScope(setOf("a", "b"), includePhotos = true, includeVideos = false)
        assertFalse(s.isWidenedBy(ScannedScope(setOf("a"), true, false)))
        assertTrue(s.isWidenedBy(ScannedScope(setOf("a", "c"), true, false)))
        assertTrue(s.isWidenedBy(ScannedScope(setOf("a"), true, true)))
        assertFalse(s.isWidenedBy(ScannedScope(setOf("a"), false, false)))
    }
}
