package cr.marin.memoriahub.data.db

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

@Database(
    entities = [SyncFileEntity::class, SyncRunEntity::class],
    // v2: added SyncFileEntity.bucketId for per-folder sync selection. The local sync
    // state is a reconstructable cache (reconcile + server-side dedup), so the module's
    // destructive-migration fallback safely rebuilds it on upgrade.
    version = 2,
    exportSchema = false,
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun syncFileDao(): SyncFileDao
    abstract fun syncRunDao(): SyncRunDao
}
