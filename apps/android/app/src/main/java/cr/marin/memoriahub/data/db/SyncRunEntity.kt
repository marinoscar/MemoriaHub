package cr.marin.memoriahub.data.db

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "sync_runs")
data class SyncRunEntity(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val trigger: String,
    val startedAt: Long,
    val finishedAt: Long? = null,
    val total: Int = 0,
    val uploaded: Int = 0,
    val skipped: Int = 0,
    val failed: Int = 0,
)
