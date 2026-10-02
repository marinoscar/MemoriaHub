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
import memoriahub.marin.cr.ledger.UploadLedger
import memoriahub.marin.cr.net.ApiMediaSyncDevicesApi
import memoriahub.marin.cr.net.ApiMediaUploadApi
import memoriahub.marin.cr.net.MediaSyncDevicesApi
import memoriahub.marin.cr.notifications.AndroidPairingNotifier
import memoriahub.marin.cr.notifications.MediaSyncNotifications
import memoriahub.marin.cr.pairing.ApiDeviceFlowTransport
import memoriahub.marin.cr.pairing.ApiErrorReactions
import memoriahub.marin.cr.pairing.DeviceFlowPoller
import memoriahub.marin.cr.pairing.DeviceInfo
import memoriahub.marin.cr.pairing.PairingManager
import memoriahub.marin.cr.pairing.PairingNotifier
import memoriahub.marin.cr.pairing.PairingStateStore
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.pairing.SharedPrefsPairingStateStore
import memoriahub.marin.cr.sync.NoopSyncScheduling
import memoriahub.marin.cr.sync.SyncScheduling
import memoriahub.marin.cr.twa.TwaLauncherActivity
import memoriahub.marin.cr.upload.AndroidContentSource
import memoriahub.marin.cr.upload.AndroidNetworkPolicy
import memoriahub.marin.cr.upload.NetworkPreference
import memoriahub.marin.cr.upload.PartUploader
import memoriahub.marin.cr.upload.UploadEngine

/**
 * Process-wide singletons. Deliberately no DI framework (no Hilt/Dagger): every collaborator is
 * a lazy property here, typed by an interface wherever logic needs a fake on the JVM, and screens
 * and workers reach them through [MobileApplication.from].
 *
 * Seams later issues fill in (add a lazy property or a `newX()` factory here, nothing else):
 * - #509 pairing (done): [pairingState], [pairingNotifier], [mediaSyncDevices], [apiErrorReactions],
 *   [newPairingManager], [pairingStatus].
 * - #510 media discovery + Room ledger: `val ledger` (the Room database `<prefix>_sync.db`, built once).
 * - #511 upload engine (done): [newUploadEngine] over [apiClient] and a ledger.
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

    /** Non-secret pairing state: `pairingExpired`, `pairedAt` (plain prefs `<prefix>_pairing`). */
    val pairingState: PairingStateStore by lazy { SharedPrefsPairingStateStore.create(this) }

    /** "Pairing expired — re-pair" notification. */
    val pairingNotifier: PairingNotifier by lazy { AndroidPairingNotifier(this) }

    /** `POST`/`DELETE /api/media-sync/devices` (register, unpair). */
    val mediaSyncDevices: MediaSyncDevicesApi by lazy { ApiMediaSyncDevicesApi(apiClient) }

    /**
     * The pairing ↔ background-sync seam. TODO(#512): the WorkManager `MediaSyncScheduler`.
     * Pairing calls ensurePeriodic()/syncNow(INITIAL) after registering and cancelAll() on unpair
     * or DEVICE_REVOKED; read through a provider so the swap needs no other change.
     */
    val syncScheduling: SyncScheduling by lazy { NoopSyncScheduling }

    /**
     * Global 401 / 409 `DEVICE_REVOKED` reactions. Every authenticated Media Sync caller (#510–#514)
     * routes its failures through [ApiErrorReactions.handle] / [ApiErrorReactions.check].
     */
    val apiErrorReactions: ApiErrorReactions by lazy {
        ApiErrorReactions(tokenStore, pairingState, { syncScheduling }, pairingNotifier)
    }

    /** A pairing attempt's manager (each view model gets its own poller). */
    fun newPairingManager(): PairingManager {
        val transport = ApiDeviceFlowTransport(apiClient)
        return PairingManager(
            transport = transport,
            poller = DeviceFlowPoller(transport),
            devices = mediaSyncDevices,
            tokens = tokenStore,
            state = pairingState,
            scheduler = { syncScheduling },
            notifier = pairingNotifier,
            clientInfo = { DeviceInfo.clientInfo(this) },
            deviceRegistration = { installationId -> DeviceInfo.registration(this, installationId) },
        )
    }

    /**
     * A resumable upload engine over [apiClient] (issue #511). #512 builds one per sync run:
     * `newUploadEngine(ledger) { NetworkPreference.fromWire(config.network) }.run(target, …)`,
     * where `target = UploadTarget(config.targetCircleId, tokenStore.deviceId!!, deviceName)`.
     * Part PUTs use their own OkHttp client; the PAT is only ever sent to this server's origin.
     */
    fun newUploadEngine(ledger: UploadLedger, networkPreference: () -> NetworkPreference): UploadEngine =
        UploadEngine(
            ledger = ledger,
            api = ApiMediaUploadApi(apiClient),
            partUploader = PartUploader(
                serverBaseUrl = { serverConfig.serverUrl },
                tokenProvider = { tokenStore.token },
                userAgent = ApiClient.userAgent(BuildConfig.VERSION_NAME),
            ),
            source = AndroidContentSource(this),
            networkPolicy = AndroidNetworkPolicy(this, networkPreference),
            errorReactions = apiErrorReactions,
        )

    /** Pairing as stored on the phone (hub card, diagnostics, workers' "may I sync?" gate). */
    fun pairingStatus(): PairingStatus = PairingStatus.read(tokenStore, pairingState)

    /** Process-wide scope for short fire-and-forget calls (e.g. the update check on app open). */
    val appScope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }

    override fun onCreate() {
        super.onCreate()
        AppLog.init(this)
        AppLog.i("App", "app.start version=${BuildConfig.VERSION_NAME} code=${BuildConfig.VERSION_CODE} sdk=${Build.VERSION.SDK_INT}")
        MediaSyncNotifications.ensureChannels(this)
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
