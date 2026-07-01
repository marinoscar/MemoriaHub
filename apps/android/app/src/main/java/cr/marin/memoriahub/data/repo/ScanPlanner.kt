package cr.marin.memoriahub.data.repo

/** How the next reconcile should scan MediaStore. */
sealed interface ScanPlan {
    /** Scan everything; the result is a complete universe, so the deletion diff runs. */
    data object Full : ScanPlan

    /**
     * Scan only changes: generation bounds (API 30+, catches adds AND edits) OR'd with
     * the DATE_ADDED high-water mark (belt-and-braces for untracked volumes / API < 30).
     */
    data class Incremental(val sinceGeneration: Long?, val sinceDateAddedSec: Long) : ScanPlan
}

/**
 * Decides between a full and an incremental scan. Pure logic, extracted for unit
 * testing. First matching rule wins:
 *
 * 1. Caller explicitly requested full.
 * 2. MediaStore version changed — the media DB was rebuilt, so generations (and even
 *    row ids) reset; rebaseline with a full scan.
 * 3. No baseline yet: generation mark unset (gen mode) / date mark unset (date mode).
 *    This is also how [resetScanMarks][cr.marin.memoriahub.core.storage.AppConfigStore]
 *    durably forces a full rescan after a folder-selection change.
 * 4. The daily full-reconcile interval elapsed (deletion-diff safety net; also catches
 *    SD-card edits invisible to the primary volume's generation counter).
 * 5. Otherwise incremental.
 */
object ScanPlanner {

    /** At most one automatic full reconcile per day. */
    const val FULL_RECONCILE_INTERVAL_MS: Long = 24L * 60 * 60 * 1000

    fun plan(
        requestedFull: Boolean,
        generationSupported: Boolean,
        storedGeneration: Long,
        storedDateAddedSec: Long,
        storedVersion: String?,
        currentVersion: String?,
        lastFullReconcileAtMs: Long,
        nowMs: Long,
    ): ScanPlan = when {
        requestedFull -> ScanPlan.Full
        storedVersion != null && currentVersion != null && storedVersion != currentVersion ->
            ScanPlan.Full
        generationSupported && storedGeneration == 0L -> ScanPlan.Full
        !generationSupported && storedDateAddedSec == 0L -> ScanPlan.Full
        nowMs - lastFullReconcileAtMs >= FULL_RECONCILE_INTERVAL_MS -> ScanPlan.Full
        generationSupported -> ScanPlan.Incremental(storedGeneration, storedDateAddedSec)
        else -> ScanPlan.Incremental(null, storedDateAddedSec)
    }
}
