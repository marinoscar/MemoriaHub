package memoriahub.marin.cr.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaStoreQueriesTest {
    private val buckets = listOf("111", "222")

    @Test fun `generation path on API 30+`() {
        val s = MediaStoreQueries.scanSelection(30, ScanCursor("external_primary", sinceGeneration = 42), buckets)!!
        assertEquals(
            "bucket_id IN (?,?) AND is_pending = 0 AND is_trashed = 0 AND (generation_added > ? OR generation_modified > ?)",
            s.sql,
        )
        assertEquals(listOf("111", "222", "42", "42"), s.args)
    }

    @Test fun `DATE_MODIFIED fallback below API 30, minus 2 seconds`() {
        val s = MediaStoreQueries.scanSelection(29, ScanCursor("external_primary", sinceGeneration = 42, sinceDateModifiedSec = 1_000), buckets)!!
        assertEquals("bucket_id IN (?,?) AND is_pending = 0 AND (date_modified >= ? OR date_added >= ?)", s.sql)
        assertEquals(listOf("111", "222", "998", "998"), s.args)
        val legacy = MediaStoreQueries.scanSelection(26, ScanCursor("external", sinceDateModifiedSec = 1), listOf("1"))!!
        assertEquals("bucket_id IN (?) AND (date_modified >= ? OR date_added >= ?)", legacy.sql)
        assertEquals(listOf("1", "0", "0"), legacy.args)
    }

    @Test fun `API 30+ without a generation cursor uses the date cursor`() {
        val s = MediaStoreQueries.scanSelection(33, ScanCursor("v", sinceDateModifiedSec = 100), listOf("1"))!!
        assertTrue(s.sql.endsWith("(date_modified >= ? OR date_added >= ?)"))
    }

    @Test fun `full scan has no change filter, empty bucket set queries nothing`() {
        val s = MediaStoreQueries.scanSelection(34, ScanCursor.full("v"), listOf("1"))!!
        assertEquals("bucket_id IN (?) AND is_pending = 0 AND is_trashed = 0", s.sql)
        assertNull(MediaStoreQueries.scanSelection(34, ScanCursor.full("v"), emptyList()))
        assertTrue(ScanCursor.full("v").isFull)
        assertFalse(ScanCursor("v", sinceGeneration = 0).isFull)
    }

    @Test fun `projections per SDK and media type`() {
        val v34 = MediaStoreQueries.scanProjection(34, isVideo = true).toList()
        assertTrue(v34.containsAll(listOf("_id", "relative_path", "generation_modified", "duration", "datetaken", "bucket_id")))
        assertFalse("_data" in v34)
        val p29 = MediaStoreQueries.scanProjection(29, isVideo = false).toList()
        assertTrue("relative_path" in p29)
        assertFalse("generation_modified" in p29)
        assertFalse("duration" in p29)
        val p28 = MediaStoreQueries.scanProjection(28, isVideo = false).toList()
        assertTrue("_data" in p28)
        assertFalse("relative_path" in p28)
        assertEquals(listOf("bucket_id", "bucket_display_name", "_data", "_size"), MediaStoreQueries.inventoryProjection(28).toList())
    }

    @Test fun `inventory excludes pending and trashed where they exist`() {
        assertEquals("is_pending = 0 AND is_trashed = 0", MediaStoreQueries.inventorySelection(30)!!.sql)
        assertEquals("is_pending = 0", MediaStoreQueries.inventorySelection(29)!!.sql)
        assertNull(MediaStoreQueries.inventorySelection(28))
    }

    @Test fun `relative path from DATA below API 29`() {
        assertEquals("DCIM/Camera/", RelativePaths.fromData("/storage/emulated/0/DCIM/Camera/IMG_1.jpg"))
        assertEquals("Pictures/", RelativePaths.fromData("/storage/1234-ABCD/Pictures/a.png"))
        assertEquals("", RelativePaths.fromData("/storage/emulated/0/a.png"))
        assertEquals("WhatsApp/Media/WhatsApp Images/", RelativePaths.fromData("/sdcard/WhatsApp/Media/WhatsApp Images/x.jpg"))
        assertNull(RelativePaths.fromData("/data/user/0/x.jpg"))
        assertNull(RelativePaths.fromData(null))
    }

    @Test fun `inventory aggregates photos, videos and bytes per bucket`() {
        val agg = InventoryAggregator()
        agg.add("cam", "Camera", "DCIM/Camera/", isVideo = false, sizeBytes = 100)
        agg.add("cam", "Camera", "DCIM/Camera/", isVideo = true, sizeBytes = 1_000)
        agg.add("cam", "Camera", "DCIM/Camera/", isVideo = false, sizeBytes = 50)
        agg.add("shots", "Screenshots", "Pictures/Screenshots/", isVideo = false, sizeBytes = 10)
        agg.add("wa", null, "WhatsApp/Media/WhatsApp Images/", isVideo = false, sizeBytes = 5)
        agg.add(null, "Lost", null, isVideo = false, sizeBytes = 5)
        val result = agg.result()
        assertEquals(listOf("cam", "shots", "wa"), result.map { it.bucketId })
        assertEquals(Bucket("cam", "Camera", "DCIM/Camera/", 2, 1, 1_150), result[0])
        assertEquals("name falls back to the folder", "WhatsApp Images", result[2].name)
    }
}
