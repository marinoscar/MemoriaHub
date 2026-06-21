package cr.marin.memoriahub.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

data class StatusCount(
    val status: SyncStatus,
    val count: Int,
)

@Dao
interface SyncFileDao {

    @Upsert
    suspend fun upsert(entity: SyncFileEntity)

    @Query("SELECT * FROM sync_files WHERE mediaStoreId = :id")
    suspend fun getById(id: Long): SyncFileEntity?

    @Query("SELECT * FROM sync_files ORDER BY dateAddedSec DESC")
    fun observeAll(): Flow<List<SyncFileEntity>>

    @Query("SELECT status AS status, COUNT(*) AS count FROM sync_files GROUP BY status")
    fun observeStatusCounts(): Flow<List<StatusCount>>

    @Query("SELECT * FROM sync_files WHERE status = :status ORDER BY updatedAt DESC")
    fun observeByStatus(status: SyncStatus): Flow<List<SyncFileEntity>>

    /** Next batch of work: queued (or retryable failed) items, newest capture first. */
    @Query(
        """
        SELECT * FROM sync_files
        WHERE status IN ('QUEUED', 'FAILED')
        ORDER BY dateAddedSec DESC
        LIMIT :limit
        """,
    )
    suspend fun nextWorkBatch(limit: Int): List<SyncFileEntity>

    @Query("SELECT COUNT(*) FROM sync_files WHERE status IN ('QUEUED', 'FAILED')")
    suspend fun pendingWorkCount(): Int

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

    @Query("DELETE FROM sync_files")
    suspend fun clear()
}
