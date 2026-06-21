package cr.marin.memoriahub

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.VideoFrameDecoder
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
class MemoriaHubApp : Application(), Configuration.Provider, ImageLoaderFactory {

    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .build()

    // Adds video-frame decoding so the photo grid can thumbnail local videos.
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .components { add(VideoFrameDecoder.Factory()) }
            .crossfade(true)
            .build()
}
