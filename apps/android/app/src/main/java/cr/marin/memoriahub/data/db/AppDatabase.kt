package cr.marin.memoriahub.data.db

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

@Database(
    entities = [SyncFileEntity::class, SyncRunEntity::class],
    version = 1,
    exportSchema = false,
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun syncFileDao(): SyncFileDao
    abstract fun syncRunDao(): SyncRunDao
}
