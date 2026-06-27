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
    fun `selection builds an IN clause with one placeholder per bucket`() {
        val (selection, args) = MediaStoreScanner.buildBucketSelection(
            listOf("Camera", "DCIM", "Pictures"),
            sinceDateAddedSec = 0,
        )
        assertEquals("bucket_display_name IN (?, ?, ?)", selection)
        assertEquals(listOf("Camera", "DCIM", "Pictures"), args.toList())
    }

    @Test
    fun `high-water mark appends a date_added bound and its arg`() {
        val (selection, args) = MediaStoreScanner.buildBucketSelection(
            listOf("Camera"),
            sinceDateAddedSec = 1700,
        )
        assertEquals("bucket_display_name IN (?) AND date_added >= ?", selection)
        assertEquals(listOf("Camera", "1700"), args.toList())
    }
}
