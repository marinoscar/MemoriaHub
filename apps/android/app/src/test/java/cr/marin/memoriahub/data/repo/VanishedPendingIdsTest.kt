package cr.marin.memoriahub.data.repo

import org.junit.Assert.assertEquals
import org.junit.Test

class VanishedPendingIdsTest {

    @Test
    fun `pending id present in scan is kept`() {
        val vanished = computeVanishedPendingIds(
            scannedIds = setOf(1L, 2L),
            pending = listOf(PendingRef(1L, "bucketA")),
            selectedBucketIds = setOf("bucketA"),
        )
        assertEquals(emptyList<Long>(), vanished)
    }

    @Test
    fun `pending id absent from scan in selected bucket is deleted`() {
        val vanished = computeVanishedPendingIds(
            scannedIds = setOf(2L),
            pending = listOf(PendingRef(1L, "bucketA")),
            selectedBucketIds = setOf("bucketA"),
        )
        assertEquals(listOf(1L), vanished)
    }

    @Test
    fun `pending id in deselected bucket is kept`() {
        val vanished = computeVanishedPendingIds(
            scannedIds = setOf(2L),
            pending = listOf(PendingRef(1L, "bucketB")),
            selectedBucketIds = setOf("bucketA"),
        )
        assertEquals(emptyList<Long>(), vanished)
    }

    @Test
    fun `pending id with null bucket absent from scan is deleted`() {
        val vanished = computeVanishedPendingIds(
            scannedIds = setOf(2L),
            pending = listOf(PendingRef(1L, null)),
            selectedBucketIds = setOf("bucketA"),
        )
        assertEquals(listOf(1L), vanished)
    }

    @Test
    fun `legacy null selection puts every pending row in scope`() {
        val vanished = computeVanishedPendingIds(
            scannedIds = setOf(3L),
            pending = listOf(
                PendingRef(1L, "Camera"),
                PendingRef(2L, null),
                PendingRef(3L, "Camera"),
            ),
            selectedBucketIds = null,
        )
        assertEquals(listOf(1L, 2L), vanished)
    }

    @Test
    fun `empty scan deletes all in-scope pending rows`() {
        // A bucket whose last file was deleted contributes zero scan rows; the
        // diff must still clean its pending entries.
        val vanished = computeVanishedPendingIds(
            scannedIds = emptySet(),
            pending = listOf(PendingRef(1L, "bucketA"), PendingRef(2L, "bucketA")),
            selectedBucketIds = setOf("bucketA"),
        )
        assertEquals(listOf(1L, 2L), vanished)
    }
}
