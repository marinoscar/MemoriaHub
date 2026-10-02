package memoriahub.marin.cr.media

import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ledger.IngestResult
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.ReconcilePolicy
import memoriahub.marin.cr.ledger.SyncScope
import memoriahub.marin.cr.permissions.MediaPermissionState

/** Outcome of [MediaScanner.scan]. */
data class ScanResult(
    val permission: MediaPermissionState,
    /** The scan did not run: permission denied, or the scope selects nothing. */
    val skipped: Boolean = false,
    /** MediaStore refused mid-scan (permission revoked): cursors were not advanced. */
    val permissionLost: Boolean = false,
    /** Volumes scanned in full (the others incrementally). */
    val fullVolumes: Set<String> = emptySet(),
    val volumes: Set<String> = emptySet(),
    val rowsSeen: Int = 0,
    val ingest: IngestResult = IngestResult(),
    val vanished: Int = 0,
) {
    val wasFull: Boolean get() = volumes.isNotEmpty() && fullVolumes == volumes
}

/**
 * Discovery (docs/specs/android-media-sync.md §8.3): incremental MediaStore scans per volume into
 * the ledger, full reconcile scans when due, and vanished detection.
 *
 * - Incremental on `GENERATION_MODIFIED` (API 30+), else `DATE_MODIFIED` (minus 2 s); the
 *   generation is captured **before** the scan so mid-scan changes are seen next time.
 * - A volume is scanned in full when asked ([scan] `full = true`), when it has no cursor, when
 *   `MediaStore.getVersion` changed (generations reset), or when the scope widened (a bucket newly
 *   selected or a type newly included: incremental cursors never looked at those rows).
 * - Vanished detection (T19) runs only after a **full** scan of a volume with permission `full`:
 *   under `partial` or `denied` absence proves nothing. A denied permission skips the scan entirely.
 *
 * Config re-evaluation is separate: call [LedgerRepository.applyScope] when a config is applied.
 */
class MediaScanner(
    private val gateway: MediaGateway,
    private val ledger: LedgerRepository,
    private val cursors: ScanCursorStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** Whether a periodic run should ask for a full reconcile scan (at most once per 24 h). */
    fun fullScanDue(nowMs: Long = clock()): Boolean {
        val last = cursors.lastFullScanAtMs ?: return true
        return nowMs - last >= FULL_SCAN_INTERVAL_MS || nowMs < last
    }

    suspend fun scan(scope: SyncScope, full: Boolean = false): ScanResult {
        val permission = gateway.permissionState()
        if (permission == MediaPermissionState.DENIED) {
            AppLog.i(TAG, "scan.skipped reason=permission_denied")
            return ScanResult(permission = permission, skipped = true)
        }
        if (scope.isEmpty) {
            return ScanResult(permission = permission, skipped = true)
        }
        val scanned = ScannedScope(scope.folders, scope.includePhotos, scope.includeVideos)
        val widened = cursors.scannedScope?.isWidenedBy(scanned) ?: true
        val volumes = gateway.volumes()
        val fullVolumes = mutableSetOf<String>()
        var rowsSeen = 0
        var vanished = 0
        var ingest = IngestResult()
        try {
            for (volume in volumes) {
                val version = gateway.mediaStoreVersion(volume)
                val stored = cursors.cursor(volume)
                val versionChanged = stored?.mediaStoreVersion != null && version != null && stored.mediaStoreVersion != version
                val volumeFull = full || widened || stored == null || versionChanged
                // Captured BEFORE the scan: anything changing during it is re-scanned next time.
                val generation = gateway.currentGeneration(volume)
                val startedSec = clock() / 1000
                val since = when {
                    volumeFull -> ScanCursor.full(volume)
                    generation != null && stored?.generation != null -> ScanCursor(volume, sinceGeneration = stored.generation)
                    stored?.dateModifiedSec != null -> ScanCursor(volume, sinceDateModifiedSec = stored.dateModifiedSec)
                    else -> ScanCursor.full(volume)
                }
                val isFull = since.isFull
                if (isFull) fullVolumes += volume
                val seen = if (isFull) HashSet<Long>() else null
                val batch = ArrayList<MediaRow>(BATCH)
                for (row in gateway.scan(since, scope.folders, scope.includePhotos, scope.includeVideos)) {
                    rowsSeen++
                    seen?.add(row.mediaStoreId)
                    batch += row
                    if (batch.size >= BATCH) {
                        ingest += ledger.ingest(batch.toList(), scope)
                        batch.clear()
                    }
                }
                if (batch.isNotEmpty()) ingest += ledger.ingest(batch.toList(), scope)
                if (seen != null && permission == MediaPermissionState.FULL) {
                    val gone = ReconcilePolicy.vanished(ledger.vanishedCandidates(volume), seen, scope)
                    vanished += ledger.vanished(gone)
                }
                cursors.setCursor(volume, VolumeCursor(generation = generation, dateModifiedSec = startedSec, mediaStoreVersion = version))
            }
        } catch (e: SecurityException) {
            AppLog.w(TAG, "scan.permission_lost")
            return ScanResult(permission, permissionLost = true, fullVolumes = fullVolumes, volumes = volumes, rowsSeen = rowsSeen, ingest = ingest, vanished = vanished)
        }
        cursors.scannedScope = scanned
        if (volumes.isNotEmpty() && fullVolumes.containsAll(volumes)) cursors.lastFullScanAtMs = clock()
        AppLog.i(
            TAG,
            "scan.done volumes=${volumes.size} full=${fullVolumes.size} rows=$rowsSeen queued=${ingest.queued} " +
                "requeued=${ingest.requeued} excluded=${ingest.excluded} vanished=$vanished permission=${permission.wire}",
        )
        return ScanResult(permission, fullVolumes = fullVolumes, volumes = volumes, rowsSeen = rowsSeen, ingest = ingest, vanished = vanished)
    }

    /** The check-in `inventory` (≤500 buckets, most populated first); empty without permission. */
    fun inventory(): List<Bucket> =
        if (gateway.permissionState() == MediaPermissionState.DENIED) emptyList() else gateway.inventory().take(MAX_INVENTORY)

    companion object {
        private const val TAG = "Media"
        const val BATCH = 500
        const val FULL_SCAN_INTERVAL_MS = 24L * 60 * 60 * 1000
        const val MAX_INVENTORY = 500
    }
}
