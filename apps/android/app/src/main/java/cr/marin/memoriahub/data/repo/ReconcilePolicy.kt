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
