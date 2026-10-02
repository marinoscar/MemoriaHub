package memoriahub.marin.cr

import android.app.Application
import android.content.Context
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import memoriahub.marin.cr.auth.EncryptedTokenStore
import memoriahub.marin.cr.auth.TokenStore
import memoriahub.marin.cr.config.ServerConfig
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.twa.TwaLauncherActivity

/**
 * Process-wide singletons. Deliberately no DI framework (no Hilt/Dagger): every collaborator is
 * a lazy property here, typed by an interface wherever logic needs a fake on the JVM, and screens
 * and workers reach them through [MobileApplication.from].
 *
 * Seams later issues fill in (add a lazy property or a `newX()` factory here, nothing else):
 * - #509 pairing: `fun newPairingManager()` over [apiClient] + [tokenStore].
 * - #510 media discovery + Room ledger: `val ledger` (the Room database `<prefix>_sync.db`, built once).
 * - #511 upload engine: `fun newUploader()` over [apiClient] and the ledger.
 * - #512 background sync: `val syncScheduler` (WorkManager), wired into [onAppOpen] and [onCreate].
 * - #514 diagnostics + updates: `val diagnostics`, `val updateChecker`, wired into [onAppOpen].
 */
class MobileApplication : Application() {
    /** The server this app talks to (plain prefs `<prefix>_config`). */
    val serverConfig: ServerConfig by lazy { ServerConfig.from(this) }

    /** Pairing credentials (Keystore-encrypted prefs `<prefix>_secure`). */
    val tokenStore: TokenStore by lazy { EncryptedTokenStore.create(this) }

    /** Client for the configured server; base URL and token are read on every request. */
    val apiClient: ApiClient by lazy {
        ApiClient(
            baseUrlProvider = { serverConfig.serverUrl },
            tokenProvider = { tokenStore.token },
            userAgent = ApiClient.userAgent(BuildConfig.VERSION_NAME),
        )
    }

    /** Process-wide scope for short fire-and-forget calls (e.g. the update check on app open). */
    val appScope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        AppLog.i("App", "app.start version=${BuildConfig.VERSION_NAME} code=${BuildConfig.VERSION_CODE} sdk=${Build.VERSION.SDK_INT}")
        // TODO(#512): re-assert the periodic sync (KEEP) when paired, e.g. after an app data restore.
    }

    /**
     * The user opened the app (a fresh [TwaLauncherActivity], not a recreation). Cheap and
     * non-blocking: anything slow is enqueued or launched on [appScope].
     */
    fun onAppOpen() {
        // TODO(#512): MediaSyncScheduler.onAppOpen(this) — debounced "sync now" when paired.
        // TODO(#514): AppUpdates.onAppOpen(this) — throttled check for a newer published release.
    }

    companion object {
        fun from(context: Context): MobileApplication = context.applicationContext as MobileApplication
    }
}
