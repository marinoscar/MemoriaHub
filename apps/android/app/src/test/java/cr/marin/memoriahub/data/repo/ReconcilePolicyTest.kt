package cr.marin.memoriahub.data.repo

import cr.marin.memoriahub.data.db.MediaType
import cr.marin.memoriahub.data.media.ScannedMedia
import org.junit.Assert.assertEquals
import org.junit.Test

class ReconcilePolicyTest {

    private val scanned = ScannedMedia(
        mediaStoreId = 42L,
        contentUri = "content://media/external/images/media/42",
        displayName = "IMG_0042.jpg",
        bucketId = "123",
        bucket = "Camera",
        mimeType = "image/jpeg",
        type = MediaType.PHOTO,
        sizeBytes = 1_000L,
        mtimeMs = 5_000L,
        dateAddedSec = 1_700_000_000L,
        dateTakenMs = null,
    )

    private val matchingRow = ReconcileRow(
        mediaStoreId = 42L,
        sizeBytes = 1_000L,
        mtimeMs = 5_000L,
        contentUri = "content://media/external/images/media/42",
        displayName = "IMG_0042.jpg",
    )

    @Test
    fun `no existing row queues`() {
        assertEquals(ReconcileAction.Queue, computeReconcileAction(scanned, null))
    }

    @Test
    fun `size change requeues`() {
        assertEquals(
            ReconcileAction.Requeue,
            computeReconcileAction(scanned, matchingRow.copy(sizeBytes = 999L)),
        )
    }

    @Test
    fun `mtime change requeues`() {
        assertEquals(
            ReconcileAction.Requeue,
            computeReconcileAction(scanned, matchingRow.copy(mtimeMs = 4_000L)),
        )
    }

    @Test
    fun `uri change refreshes metadata`() {
        assertEquals(
            ReconcileAction.RefreshMeta,
            computeReconcileAction(scanned, matchingRow.copy(contentUri = "content://old/uri")),
        )
    }

    @Test
    fun `name change refreshes metadata`() {
        assertEquals(
            ReconcileAction.RefreshMeta,
            computeReconcileAction(scanned, matchingRow.copy(displayName = "old-name.jpg")),
        )
    }

    @Test
    fun `content change wins over metadata drift`() {
        assertEquals(
            ReconcileAction.Requeue,
            computeReconcileAction(
                scanned,
                matchingRow.copy(sizeBytes = 999L, contentUri = "content://old/uri"),
            ),
        )
    }

    @Test
    fun `identical row is unchanged`() {
        assertEquals(ReconcileAction.Unchanged, computeReconcileAction(scanned, matchingRow))
    }
}
