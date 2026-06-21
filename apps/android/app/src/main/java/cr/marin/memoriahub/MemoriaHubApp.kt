package cr.marin.memoriahub

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application entry point.
 *
 * Hilt owns dependency graph construction. WorkManager's default initializer is
 * disabled in the manifest so that we can supply a [HiltWorkerFactory] here,
 * letting background workers receive injected dependencies (repositories, the
 * sync engine, the API client).
 */
@HiltAndroidApp
class MemoriaHubApp : Application(), Configuration.Provider {

    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .build()
}
