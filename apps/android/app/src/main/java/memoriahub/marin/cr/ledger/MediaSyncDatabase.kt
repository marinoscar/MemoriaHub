package memoriahub.marin.cr.ledger

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.withTransaction
import memoriahub.marin.cr.BuildConfig

/**
 * The Media Sync file ledger (`<prefix>_sync.db`, docs/specs/android-media-sync.md §8). Built once
 * per process by `MobileApplication.mediaSyncDatabase`. The schema is exported to `app/schemas`;
 * bump [version] with a Room migration (never a destructive fallback: losing the ledger loses
 * in-flight multipart sessions and every count).
 */
@Database(entities = [SyncFileEntity::class, SyncRunEntity::class], version = 1, exportSchema = true)
@TypeConverters(LedgerConverters::class)
abstract class MediaSyncDatabase : RoomDatabase() {
    abstract fun syncFiles(): SyncFileDao
    abstract fun syncRuns(): SyncRunDao

    /** [LedgerTransactions] over this database. */
    fun transactions(): LedgerTransactions = object : LedgerTransactions {
        override suspend fun <T> run(block: suspend () -> T): T = withTransaction { block() }
    }

    companion object {
        const val NAME = BuildConfig.STORAGE_PREFIX + "_sync.db"

        fun create(context: Context): MediaSyncDatabase =
            Room.databaseBuilder(context.applicationContext, MediaSyncDatabase::class.java, NAME).build()
    }
}

/** Runs a block in one database transaction (a pass-through in JVM tests). */
interface LedgerTransactions {
    suspend fun <T> run(block: suspend () -> T): T
}
