package memoriahub.marin.cr.ledger

import kotlinx.serialization.Serializable

/** Per-state counts of one bucket (local only; the server never receives `perBucket`). */
data class BucketStats(
    val eligible: Int = 0,
    val uploaded: Int = 0,
    val deduplicated: Int = 0,
    val pending: Int = 0,
    val uploading: Int = 0,
    val failed: Int = 0,
    val blocked: Int = 0,
    val excluded: Int = 0,
    val bytesPending: Long = 0,
    val bytesUploaded: Long = 0,
) {
    val synced: Int get() = uploaded + deduplicated
    val missing: Int get() = pending + uploading + failed + blocked
}

/**
 * The ledger statistics of docs/specs/android-media-sync.md §8.5. Every non-`EXCLUDED` row counts
 * in exactly one bucket (D8: `FAILED` only in [failed], never in [pending]), so
 * `eligible = uploaded + deduplicated + pending + uploading + failed + blocked`.
 */
data class SyncStats(
    val eligible: Int = 0,
    val uploaded: Int = 0,
    val deduplicated: Int = 0,
    val pending: Int = 0,
    val uploading: Int = 0,
    val failed: Int = 0,
    val blocked: Int = 0,
    val bytesPending: Long = 0,
    val bytesUploaded: Long = 0,
    /** Rows not counted above (deselected folder, excluded type, `from_pairing`). */
    val excluded: Int = 0,
    /** Keyed by `bucketId` (null for rows MediaStore gave no bucket). */
    val perBucket: Map<String?, BucketStats> = emptyMap(),
) {
    /** UI "Synced". */
    val synced: Int get() = uploaded + deduplicated

    /** UI "Missing". */
    val missing: Int get() = pending + uploading + failed + blocked

    /** The check-in `stats` object (exactly the server's strict keys). */
    fun toCheckin(): CheckinStats = CheckinStats(
        eligible = eligible, uploaded = uploaded, deduplicated = deduplicated, pending = pending,
        uploading = uploading, failed = failed, blocked = blocked, bytesPending = bytesPending, bytesUploaded = bytesUploaded,
    )

    companion object {
        fun from(rows: List<StateBucketCount>): SyncStats {
            var total = BucketStats()
            val perBucket = LinkedHashMap<String?, BucketStats>()
            for (row in rows) {
                total = total.add(row.state, row.files.toInt(), row.bytes)
                perBucket[row.bucketId] = (perBucket[row.bucketId] ?: BucketStats()).add(row.state, row.files.toInt(), row.bytes)
            }
            return SyncStats(
                eligible = total.eligible, uploaded = total.uploaded, deduplicated = total.deduplicated,
                pending = total.pending, uploading = total.uploading, failed = total.failed, blocked = total.blocked,
                bytesPending = total.bytesPending, bytesUploaded = total.bytesUploaded, excluded = total.excluded,
                perBucket = perBucket,
            )
        }

        private fun BucketStats.add(state: SyncFileState, files: Int, bytes: Long): BucketStats {
            val counted = if (state == SyncFileState.EXCLUDED) this else copy(eligible = eligible + files)
            val pendingBytes = when (state) {
                SyncFileState.DISCOVERED, SyncFileState.QUEUED, SyncFileState.HASHING, SyncFileState.UPLOADING,
                SyncFileState.REGISTERING, SyncFileState.FAILED, SyncFileState.BLOCKED,
                -> bytes
                else -> 0L
            }
            val withState = when (state) {
                SyncFileState.UPLOADED -> counted.copy(uploaded = counted.uploaded + files, bytesUploaded = counted.bytesUploaded + bytes)
                SyncFileState.DEDUPLICATED -> counted.copy(deduplicated = counted.deduplicated + files)
                SyncFileState.DISCOVERED, SyncFileState.QUEUED, SyncFileState.HASHING -> counted.copy(pending = counted.pending + files)
                SyncFileState.UPLOADING, SyncFileState.REGISTERING -> counted.copy(uploading = counted.uploading + files)
                SyncFileState.FAILED -> counted.copy(failed = counted.failed + files)
                SyncFileState.BLOCKED -> counted.copy(blocked = counted.blocked + files)
                SyncFileState.EXCLUDED -> counted.copy(excluded = counted.excluded + files)
            }
            return withState.copy(bytesPending = withState.bytesPending + pendingBytes)
        }
    }
}

/** Check-in `stats` (docs/specs/android-media-sync.md §6.4): strict, every key required. */
@Serializable
data class CheckinStats(
    val eligible: Int,
    val uploaded: Int,
    val deduplicated: Int,
    val pending: Int,
    val uploading: Int,
    val failed: Int,
    val blocked: Int,
    val bytesPending: Long,
    val bytesUploaded: Long,
)

/** Check-in `run.failedSample[]` entry (≤50 per run, `lastError` ≤500 chars). */
@Serializable
data class FailedSampleEntry(
    val name: String,
    val relativePath: String? = null,
    val sizeBytes: Long,
    val attempts: Int,
    val lastError: String? = null,
)
