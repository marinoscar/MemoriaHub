package cr.marin.memoriahub.di

import android.content.Context
import androidx.room.Room
import cr.marin.memoriahub.data.db.AppDatabase
import cr.marin.memoriahub.data.db.SyncFileDao
import cr.marin.memoriahub.data.db.SyncRunDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "memoriahub.db")
            .fallbackToDestructiveMigration(dropAllTables = true)
            .build()

    @Provides
    fun provideSyncFileDao(db: AppDatabase): SyncFileDao = db.syncFileDao()

    @Provides
    fun provideSyncRunDao(db: AppDatabase): SyncRunDao = db.syncRunDao()
}
