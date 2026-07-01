package cr.marin.memoriahub.data.repo

import cr.marin.memoriahub.data.media.ScannedMedia

/** A minimal projection of a sync_files row — just the fields reconcile compares. */
data class ReconcileRow(
    val mediaStoreId: Long,
    val sizeBytes: Long,
    val mtimeMs: Long,
    val contentUri: String,
    val displayName: String,
)

/** What reconcile should do with one scanned MediaStore item. */
sealed interface ReconcileAction {
    /** No state row yet — queue for upload. */
    data object Queue : ReconcileAction

    /** Content changed on device (size/mtime) — reset upload identity and re-queue. */
    data object Requeue : ReconcileAction

    /** Pure metadata drift (uri/name) — refresh the row, preserve sync status. */
    data object RefreshMeta : ReconcileAction

    /** Nothing to do. */
    data object Unchanged : ReconcileAction
}

/**
 * The reconcile decision, extracted as a pure function for unit testing. Content
 * change (size/mtime) wins over metadata drift — a changed file must re-upload
 * even if its uri/name also moved.
 */
fun computeReconcileAction(scanned: ScannedMedia, existing: ReconcileRow?): ReconcileAction =
    when {
        existing == null -> ReconcileAction.Queue
        existing.sizeBytes != scanned.sizeBytes || existing.mtimeMs != scanned.mtimeMs ->
            ReconcileAction.Requeue
        existing.contentUri != scanned.contentUri || existing.displayName != scanned.displayName ->
            ReconcileAction.RefreshMeta
        else -> ReconcileAction.Unchanged
    }

/** A pending sync_files row reference for the deletion diff. */
data class PendingRef(
    val mediaStoreId: Long,
    val bucketId: String?,
)

/**
 * Which pending rows correspond to files that vanished from the device — pure
 * function for unit testing. Only call with the result of a FULL scan: an
 * incremental result set is not a complete universe, so absence proves nothing.
 *
 * Bucket scope: a row participates in the diff only when the scan that produced
 * [scannedIds] could have seen it.
 * - `selectedBucketIds == null` (legacy camera-name filter): every pending row is
 *   in scope — the selection can never revert to null once configured, so all
 *   existing rows came from the identical filter. This also correctly cleans a
 *   bucket whose last file was deleted (it contributes no scan rows at all).
 * - non-null: in scope iff `bucketId == null || bucketId in selectedBucketIds`.
 *   Rows in deselected buckets were already removed by dropPendingForBuckets;
 *   any that survive a race are left alone (safe choice).
 */
fun computeVanishedPendingIds(
    scannedIds: Set<Long>,
    pending: List<PendingRef>,
    selectedBucketIds: Set<String>?,
): List<Long> =
    pending.asSequence()
        .filter { it.mediaStoreId !in scannedIds }
        .filter { ref ->
            selectedBucketIds == null || ref.bucketId == null || ref.bucketId in selectedBucketIds
        }
        .map { it.mediaStoreId }
        .toList()
