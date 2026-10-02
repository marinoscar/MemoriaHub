package memoriahub.marin.cr.ledger

import memoriahub.marin.cr.media.MediaRow
import java.time.Instant

/** Config `uploadExisting` (docs/specs/android-media-sync.md §5.1). */
enum class UploadExisting(val wire: String) {
    ALL("all"),
    FROM_PAIRING("from_pairing");

    companion object {
        /** Unknown or missing values fall back to the server default, `all`. */
        fun fromWire(value: String?): UploadExisting = entries.firstOrNull { it.wire == value } ?: ALL
    }
}

/**
 * The part of the device config that decides which files are eligible (§5.1, §8.3): selected
 * buckets, included media types and the `uploadExisting` policy with its cut-off.
 *
 * [pairedAtMs] is `app.pairingState.pairedAt` (the phone's first successful registration).
 */
data class SyncScope(
    val folders: Set<String>,
    val includePhotos: Boolean,
    val includeVideos: Boolean,
    val uploadExisting: UploadExisting = UploadExisting.ALL,
    val pairedAtMs: Long? = null,
) {
    /** Nothing can sync (no folder or no media type selected): scanning would be wasted work. */
    val isEmpty: Boolean get() = folders.isEmpty() || (!includePhotos && !includeVideos)

    fun includes(isVideo: Boolean): Boolean = if (isVideo) includeVideos else includePhotos

    companion object {
        /** Built from the device config fields and `PairingStateStore.pairedAt`. */
        fun of(
            folderBucketIds: Collection<String>,
            includePhotos: Boolean,
            includeVideos: Boolean,
            uploadExisting: String?,
            pairedAt: Instant?,
        ): SyncScope = SyncScope(
            folders = folderBucketIds.toSet(),
            includePhotos = includePhotos,
            includeVideos = includeVideos,
            uploadExisting = UploadExisting.fromWire(uploadExisting),
            pairedAtMs = pairedAt?.toEpochMilli(),
        )
    }
}

/** Pure ledger policy: eligibility, re-evaluation, reconcile decisions, backoff (§8.3, §8.4). */
object LedgerPolicy {
    /** A file fails this many times at most; the 5th failure blocks it (D10). */
    const val MAX_ATTEMPTS = 5

    /** Delay after the Nth failure (N = 1..4); the 5th blocks. */
    val BACKOFF_MS: List<Long> = listOf(30_000L, 120_000L, 600_000L, 3_600_000L)

    /** `lastError` is capped so a giant server message never bloats the ledger (check-in limit is 500). */
    const val MAX_ERROR_CHARS = 500

    /**
     * `isEligible(row, config, pairedAt)` (§8.3): the bucket is selected, the type included, and
     * under `from_pairing` the capture time is not before pairing. The capture time is `dateTaken`,
     * falling back to `dateModified` when MediaStore has none (screenshots, downloads). Under
     * `from_pairing` with no known `pairedAt` nothing is eligible: never upload old files by surprise.
     */
    fun isEligible(bucketId: String?, isVideo: Boolean, dateTakenMs: Long?, dateModifiedSec: Long, scope: SyncScope): Boolean {
        if (bucketId == null || bucketId !in scope.folders) return false
        if (!scope.includes(isVideo)) return false
        if (scope.uploadExisting == UploadExisting.FROM_PAIRING) {
            val pairedAt = scope.pairedAtMs ?: return false
            return captureTimeMs(dateTakenMs, dateModifiedSec) >= pairedAt
        }
        return true
    }

    fun isEligible(row: SyncFileScopeRow, scope: SyncScope): Boolean =
        isEligible(row.bucketId, row.isVideo, row.dateTaken, row.dateModified, scope)

    fun isEligible(row: SyncFileEntity, scope: SyncScope): Boolean =
        isEligible(row.bucketId, row.isVideo, row.dateTaken, row.dateModified, scope)

    fun captureTimeMs(dateTakenMs: Long?, dateModifiedSec: Long): Long =
        dateTakenMs?.takeIf { it > 0 } ?: (dateModifiedSec * 1000)

    /**
     * Config re-evaluation of one row (T2, T3, T17, T18): the state it must move to, or null when
     * it stays. `UPLOADED`, `DEDUPLICATED` and `REGISTERING` never move here.
     */
    fun reevaluate(state: SyncFileState, eligible: Boolean): SyncFileState? = when {
        state == SyncFileState.DISCOVERED -> if (eligible) SyncFileState.QUEUED else SyncFileState.EXCLUDED
        state == SyncFileState.EXCLUDED -> if (eligible) SyncFileState.QUEUED else null
        state in LedgerTransitions.excludable -> if (eligible) null else SyncFileState.EXCLUDED
        else -> null
    }

    /** `nextAttemptAt` after the [attempts]th failure, or null when that failure blocks the row. */
    fun nextAttemptAt(attempts: Int, nowMs: Long): Long? =
        if (attempts >= MAX_ATTEMPTS || attempts < 1) null else nowMs + BACKOFF_MS[attempts - 1]

    fun truncateError(error: String): String =
        if (error.length <= MAX_ERROR_CHARS) error else error.take(MAX_ERROR_CHARS - 1) + "…"
}

/** What a scan row means for the ledger (the legacy `ReconcilePolicy`, Appendix A). */
enum class ReconcileDecision {
    /** No row yet: insert (T1, then T2/T3). */
    QUEUE,
    /** Size or modification time changed: a new version (content change wins over metadata drift). */
    REQUEUE,
    /** Only metadata (URI, name, path, bucket, type, capture date, generation) changed: keep the status. */
    REFRESH_META,
    UNCHANGED,
}

object ReconcilePolicy {
    fun decide(existing: SyncFileEntity?, row: MediaRow): ReconcileDecision = when {
        existing == null -> ReconcileDecision.QUEUE
        existing.sizeBytes != row.sizeBytes || existing.dateModified != row.dateModifiedSec -> ReconcileDecision.REQUEUE
        existing.uri != row.uri ||
            existing.displayName != row.displayName ||
            existing.relativePath != row.relativePath ||
            existing.bucketId != row.bucketId ||
            existing.bucketName != row.bucketName ||
            existing.mimeType != row.mimeType ||
            existing.isVideo != row.isVideo ||
            existing.dateTaken != row.dateTakenMs ||
            existing.generationModified != row.generationModified -> ReconcileDecision.REFRESH_META
        else -> ReconcileDecision.UNCHANGED
    }

    /**
     * Vanished rows after a **full** scan (T19): candidates the scan could have seen (selected
     * bucket, included type, same volume, deletable state) whose MediaStore id was not returned.
     */
    fun vanished(candidates: List<SyncFileScopeRow>, seenMediaStoreIds: Set<Long>, scope: SyncScope): List<Long> =
        candidates.filter { row ->
            row.state in LedgerTransitions.deletable &&
                row.bucketId != null && row.bucketId in scope.folders &&
                scope.includes(row.isVideo) &&
                row.mediaStoreId !in seenMediaStoreIds
        }.map { it.id }
}
