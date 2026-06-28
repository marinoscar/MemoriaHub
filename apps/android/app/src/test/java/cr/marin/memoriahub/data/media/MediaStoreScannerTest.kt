package cr.marin.memoriahub.data.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaStoreScannerTest {

    @Test
    fun `default buckets include Camera DCIM and Pictures`() {
        assertEquals(listOf("Camera", "DCIM", "Pictures"), MediaStoreScanner.CAMERA_BUCKETS)
        // Regression: emulator / some OEM cameras save captures to Pictures, not
        // DCIM/Camera, and were previously missed by the Camera-only filter.
        assertTrue("Pictures" in MediaStoreScanner.CAMERA_BUCKETS)
    }

    @Test
    fun `null selection falls back to the legacy camera display-name filter`() {
        val (selection, args) = MediaStoreScanner.buildBucketSelection(
            selectedBucketIds = null,
            sinceDateAddedSec = 0,
        )
        assertEquals("bucket_display_name IN (?, ?, ?)", selection)
        assertEquals(listOf("Camera", "DCIM", "Pictures"), args.toList())
    }

    @Test
    fun `a selection builds a bucket_id IN clause with one placeholder per id`() {
        val (selection, args) = MediaStoreScanner.buildBucketSelection(
            selectedBucketIds = linkedSetOf("11", "22"),
            sinceDateAddedSec = 0,
        )
        assertEquals("bucket_id IN (?, ?)", selection)
        assertEquals(listOf("11", "22"), args.toList())
    }

    @Test
    fun `an empty selection matches nothing`() {
        val (selection, args) = MediaStoreScanner.buildBucketSelection(
            selectedBucketIds = emptySet(),
            sinceDateAddedSec = 0,
        )
        assertEquals("0 = 1", selection)
        assertTrue(args.isEmpty())
    }

    @Test
    fun `high-water mark appends a date_added bound and its arg`() {
        val (selection, args) = MediaStoreScanner.buildBucketSelection(
            selectedBucketIds = linkedSetOf("99"),
            sinceDateAddedSec = 1700,
        )
        assertEquals("bucket_id IN (?) AND date_added >= ?", selection)
        assertEquals(listOf("99", "1700"), args.toList())
    }
}
