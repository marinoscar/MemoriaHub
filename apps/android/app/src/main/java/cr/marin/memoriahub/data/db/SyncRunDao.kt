package cr.marin.memoriahub.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface SyncRunDao {

    @Insert
    suspend fun insert(run: SyncRunEntity): Long

    @Update
    suspend fun update(run: SyncRunEntity)

    @Query("SELECT * FROM sync_runs ORDER BY startedAt DESC LIMIT 1")
    fun observeLatest(): Flow<SyncRunEntity?>

    @Query("SELECT * FROM sync_runs ORDER BY startedAt DESC LIMIT :limit")
    suspend fun recent(limit: Int): List<SyncRunEntity>
}
