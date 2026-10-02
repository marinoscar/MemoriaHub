package memoriahub.marin.cr.ledger

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update

/** The columns needed to re-evaluate eligibility without loading whole rows ([LedgerRepository.applyScope]). */
data class SyncFileScopeRow(
    val id: Long,
    val mediaStoreId: Long,
    val volume: String,
    val bucketId: String?,
    val isVideo: Boolean,
    val dateTaken: Long?,
    val dateModified: Long,
    val state: SyncFileState,
)

/** One `GROUP BY state, bucketId` cell of the statistics query. */
data class StateBucketCount(
    val state: SyncFileState,
    val bucketId: String?,
    val files: Long,
    val bytes: Long,
)

/**
 * `sync_files` access. Kept to simple, index-friendly statements; the policy (ordering of the
 * groups, the transition table, statistics math) lives in plain Kotlin so it is JVM-tested with an
 * in-memory fake of this interface. States are passed by name (`SyncFileState.name`).
 */
@Dao
interface SyncFileDao {
    @Query("SELECT * FROM sync_files WHERE id = :id")
    suspend fun get(id: Long): SyncFileEntity?

    @Query("SELECT * FROM sync_files WHERE volume = :volume AND mediaStoreId IN (:mediaStoreIds)")
    suspend fun findByMediaStoreIds(volume: String, mediaStoreIds: List<Long>): List<SyncFileEntity>

    @Insert
    suspend fun insertAll(rows: List<SyncFileEntity>): List<Long>

    @Update
    suspend fun update(row: SyncFileEntity)

    @Update
    suspend fun updateAll(rows: List<SyncFileEntity>)

    @Query("DELETE FROM sync_files WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)

    @Query("DELETE FROM sync_files")
    suspend fun deleteAll()

    /** Rows in [states], newest `dateTaken` first (null last), then by id. */
    @Query(
        "SELECT * FROM sync_files WHERE state IN (:states) " +
            "ORDER BY CASE WHEN dateTaken IS NULL THEN 1 ELSE 0 END, dateTaken DESC, id ASC LIMIT :limit",
    )
    suspend fun inStates(states: List<String>, limit: Int): List<SyncFileEntity>

    /** Rows in [state] whose `nextAttemptAt` is due (null counts as due), same order as [inStates]. */
    @Query(
        "SELECT * FROM sync_files WHERE state = :state AND (nextAttemptAt IS NULL OR nextAttemptAt <= :nowMs) " +
            "ORDER BY CASE WHEN dateTaken IS NULL THEN 1 ELSE 0 END, dateTaken DESC, id ASC LIMIT :limit",
    )
    suspend fun dueInState(state: String, nowMs: Long, limit: Int): List<SyncFileEntity>

    /** Keyset page of the eligibility projection, by id. */
    @Query(
        "SELECT id, mediaStoreId, volume, bucketId, isVideo, dateTaken, dateModified, state FROM sync_files " +
            "WHERE id > :afterId ORDER BY id ASC LIMIT :limit",
    )
    suspend fun scopePage(afterId: Long, limit: Int): List<SyncFileScopeRow>

    @Query("SELECT * FROM sync_files WHERE id IN (:ids)")
    suspend fun getAll(ids: List<Long>): List<SyncFileEntity>

    /** Vanished-detection candidates on [volume]: rows in [states]. */
    @Query(
        "SELECT id, mediaStoreId, volume, bucketId, isVideo, dateTaken, dateModified, state FROM sync_files " +
            "WHERE volume = :volume AND state IN (:states)",
    )
    suspend fun inVolumeAndStates(volume: String, states: List<String>): List<SyncFileScopeRow>

    /** T15 in bulk: `from` → QUEUED, attempts reset, nextAttemptAt cleared, lastError kept. */
    @Query("UPDATE sync_files SET state = 'QUEUED', attempts = 0, nextAttemptAt = NULL, updatedAt = :nowMs WHERE state = :from")
    suspend fun requeueAllInState(from: String, nowMs: Long): Int

    /** T14: `HASHING` leftovers of a killed process go back to `QUEUED`. */
    @Query("UPDATE sync_files SET state = 'QUEUED', updatedAt = :nowMs WHERE state = 'HASHING'")
    suspend fun requeueHashing(nowMs: Long): Int

    @Query("SELECT state, bucketId, COUNT(*) AS files, COALESCE(SUM(sizeBytes), 0) AS bytes FROM sync_files GROUP BY state, bucketId")
    suspend fun stateBucketCounts(): List<StateBucketCount>

    /** Most recently updated rows in [states] (the check-in `failedSample`). */
    @Query("SELECT * FROM sync_files WHERE state IN (:states) ORDER BY updatedAt DESC, id DESC LIMIT :limit")
    suspend fun recentInStates(states: List<String>, limit: Int): List<SyncFileEntity>

    @Query("SELECT COUNT(*) FROM sync_files")
    suspend fun count(): Int
}

@Dao
interface SyncRunDao {
    @Insert
    suspend fun insert(run: SyncRunEntity): Long

    /** Keeps the newest [keep] runs. */
    @Query("DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY startedAt DESC, id DESC LIMIT :keep)")
    suspend fun trim(keep: Int)

    @Query("SELECT * FROM sync_runs ORDER BY startedAt DESC, id DESC LIMIT :limit")
    suspend fun recent(limit: Int): List<SyncRunEntity>

    @Query("DELETE FROM sync_runs")
    suspend fun deleteAll()

    companion object {
        const val KEEP = 50
    }
}
