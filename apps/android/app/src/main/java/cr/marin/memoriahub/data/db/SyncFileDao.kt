package cr.marin.memoriahub.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import cr.marin.memoriahub.data.repo.PendingRef
import cr.marin.memoriahub.data.repo.ReconcileRow
import kotlinx.coroutines.flow.Flow

data class StatusCount(
    val status: SyncStatus,
    val count: Int,
)

/**
 * SQLite limits bound variables to 999 per statement; `IN (:ids)` queries must be
 * chunked below that. 900 leaves headroom for any fixed parameters.
 */
internal const val DB_QUERY_CHUNK = 900

@Dao
interface SyncFileDao {

    @Upsert
    suspend fun upsert(entity: SyncFileEntity)

    @Query("SELECT * FROM sync_files WHERE mediaStoreId = :id")
    suspend fun getById(id: Long): SyncFileEntity?

    /** Reconcile projection — only the fields the diff compares. Chunk ids ≤ [DB_QUERY_CHUNK]. */
    @Query(
        "SELECT mediaStoreId, sizeBytes, mtimeMs, contentUri, displayName FROM sync_files " +
            "WHERE mediaStoreId IN (:ids)",
    )
    suspend fun getReconcileRows(ids: List<Long>): List<ReconcileRow>

    /** Which of the given ids already have a state row. Chunk ids ≤ [DB_QUERY_CHUNK]. */
    @Query("SELECT mediaStoreId FROM sync_files WHERE mediaStoreId IN (:ids)")
    suspend fun getExistingIds(ids: List<Long>): List<Long>

    /**
     * All not-yet-synced rows, for the deletion diff. UPLOADED/SKIPPED rows are
     * deliberately excluded — they are kept as history even after the device file
     * is deleted (the server copy exists; re-adds dedup by content hash).
     */
    @Query(
        "SELECT mediaStoreId, bucketId FROM sync_files " +
            "WHERE status IN ('QUEUED', 'HASHING', 'UPLOADING', 'FAILED', 'BLOCKED')",
    )
    suspend fun getPendingRefs(): List<PendingRef>

    /** Delete rows by id. Chunk ids ≤ [DB_QUERY_CHUNK]. */
    @Query("DELETE FROM sync_files WHERE mediaStoreId IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>): Int

    @Query("DELETE FROM sync_files WHERE mediaStoreId = :id")
    suspend fun deleteById(id: Long): Int

    @Query("SELECT * FROM sync_files ORDER BY dateAddedSec DESC")
    fun observeAll(): Flow<List<SyncFileEntity>>

    @Query("SELECT status AS status, COUNT(*) AS count FROM sync_files GROUP BY status")
    fun observeStatusCounts(): Flow<List<StatusCount>>

    @Query("SELECT * FROM sync_files WHERE status = :status ORDER BY updatedAt DESC")
    fun observeByStatus(status: SyncStatus): Flow<List<SyncFileEntity>>

    @Query("SELECT * FROM sync_files WHERE status IN ('FAILED', 'BLOCKED') ORDER BY updatedAt DESC")
    fun observeFailures(): Flow<List<SyncFileEntity>>

    /** Next batch of queued work, newest capture first. */
    @Query(
        """
        SELECT * FROM sync_files
        WHERE status = 'QUEUED'
        ORDER BY dateAddedSec DESC
        LIMIT :limit
        """,
    )
    suspend fun nextWorkBatch(limit: Int): List<SyncFileEntity>

    @Query("SELECT COUNT(*) FROM sync_files WHERE status IN ('QUEUED', 'FAILED')")
    suspend fun pendingWorkCount(): Int

    @Query("SELECT COUNT(*) FROM sync_files WHERE status IN ('FAILED', 'BLOCKED')")
    suspend fun failureCount(): Int

    /** Crash recovery: rows left mid-flight by a killed process return to the queue. */
    @Query(
        "UPDATE sync_files SET status = 'QUEUED', updatedAt = :now " +
            "WHERE status IN ('HASHING', 'UPLOADING')",
    )
    suspend fun resetStaleActive(now: Long): Int

    /** Re-queue retryable failures; with [includeBlocked] also resets exhausted rows. */
    @Query(
        "UPDATE sync_files SET status = 'QUEUED', attemptCount = " +
            "CASE WHEN :resetAttempts THEN 0 ELSE attemptCount END, updatedAt = :now " +
            "WHERE status = 'FAILED' OR (:includeBlocked AND status = 'BLOCKED')",
    )
    suspend fun requeueFailed(includeBlocked: Boolean, resetAttempts: Boolean, now: Long): Int

    /**
     * Drop not-yet-uploaded rows for the given buckets (used when the user deselects a
     * folder). Already-uploaded items (UPLOADED/SKIPPED) are preserved so they remain on
     * the server.
     */
    @Query(
        "DELETE FROM sync_files " +
            "WHERE bucketId IN (:bucketIds) AND status NOT IN ('UPLOADED', 'SKIPPED')",
    )
    suspend fun deletePendingByBucketIds(bucketIds: List<String>): Int

    @Query("DELETE FROM sync_files")
    suspend fun clear()
}

/** Chunked variant of [SyncFileDao.getReconcileRows] for arbitrarily large id lists. */
suspend fun SyncFileDao.getReconcileRowsChunked(ids: List<Long>): List<ReconcileRow> =
    ids.chunked(DB_QUERY_CHUNK).flatMap { getReconcileRows(it) }

/** Chunked variant of [SyncFileDao.getExistingIds] for arbitrarily large id lists. */
suspend fun SyncFileDao.getExistingIdsChunked(ids: List<Long>): List<Long> =
    ids.chunked(DB_QUERY_CHUNK).flatMap { getExistingIds(it) }
