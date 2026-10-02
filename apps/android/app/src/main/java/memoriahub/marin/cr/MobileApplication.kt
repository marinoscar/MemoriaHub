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
import memoriahub.marin.cr.contract.HealthSummary
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.TempNoopHealthSummary
import memoriahub.marin.cr.contract.TempNoopSyncControl
import memoriahub.marin.cr.contract.TempNoopUpdateStatus
import memoriahub.marin.cr.contract.UpdateStatus
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.MediaSyncDatabase
import memoriahub.marin.cr.ledger.RoomUploadLedger
import memoriahub.marin.cr.media.AndroidMediaGateway
import memoriahub.marin.cr.media.MediaGateway
import memoriahub.marin.cr.media.MediaScanner
import memoriahub.marin.cr.media.ScanCursorStore
import memoriahub.marin.cr.media.SharedPrefsScanCursorStore
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
import memoriahub.marin.cr.upload.AndroidNetworkPolicy
import memoriahub.marin.cr.upload.MediaGatewayContentSource
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
 * - #510 media discovery + Room ledger (done): [mediaSyncDatabase], [mediaGateway], [scanCursors],
 *   [ledger], [uploadLedger], [mediaScanner].
 * - #511 upload engine (done): [newUploadEngine] over [apiClient], [uploadLedger] and [mediaGateway].
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

    /** The Media Sync file ledger (Room, `<prefix>_sync.db`), built once per process. */
    val mediaSyncDatabase: MediaSyncDatabase by lazy { MediaSyncDatabase.create(this) }

    /** MediaStore: inventory, scans, byte ranges for uploads (D24 URI form), permission state. */
    val mediaGateway: MediaGateway by lazy { AndroidMediaGateway(this) }

    /** Per-volume scan cursors, last full-scan time and scanned scope (prefs `<prefix>_media_scan`). */
    val scanCursors: ScanCursorStore by lazy { SharedPrefsScanCursorStore.create(this) }

    /** Ledger policy: ingest, config re-evaluation, stats, retries, runs, local reset. */
    val ledger: LedgerRepository by lazy {
        LedgerRepository(
            files = mediaSyncDatabase.syncFiles(),
            runs = mediaSyncDatabase.syncRuns(),
            tx = mediaSyncDatabase.transactions(),
            cursors = scanCursors,
        )
    }

    /** The upload engine's (#511) view of the ledger. */
    val uploadLedger: RoomUploadLedger by lazy {
        RoomUploadLedger(mediaSyncDatabase.syncFiles(), mediaSyncDatabase.transactions())
    }

    /** Discovery: incremental/full MediaStore scans into [ledger], plus the check-in inventory. */
    val mediaScanner: MediaScanner by lazy { MediaScanner(mediaGateway, ledger, scanCursors) }

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
     * A resumable upload engine over [apiClient], [uploadLedger] and [mediaGateway] (issue #511).
     * #512 builds one per sync run:
     * `newUploadEngine { NetworkPreference.fromWire(config.network) }.run(target, shouldStop = { isStopped })`,
     * where `target = UploadTarget(config.targetCircleId, tokenStore.deviceId!!, deviceName)`.
     * Part PUTs use their own OkHttp client; the PAT is only ever sent to this server's origin.
     */
    fun newUploadEngine(
        ledger: UploadLedger = uploadLedger,
        networkPreference: () -> NetworkPreference,
    ): UploadEngine =
        UploadEngine(
            ledger = ledger,
            api = ApiMediaUploadApi(apiClient),
            partUploader = PartUploader(
                serverBaseUrl = { serverConfig.serverUrl },
                tokenProvider = { tokenStore.token },
                userAgent = ApiClient.userAgent(BuildConfig.VERSION_NAME),
            ),
            source = MediaGatewayContentSource(mediaGateway),
            networkPolicy = AndroidNetworkPolicy(this, networkPreference),
            errorReactions = apiErrorReactions,
        )

    // TEMP(#513) replaced at merge by #512/#514: the three contract seams the native UI reads
    // (issues #512–#514 contract). #512 provides WorkManagerSyncControl, #514 DiagnosticsHealth
    // and UpdateChecker; until then the Hub runs against no-ops.
    /** Start/Stop, Sync now, retry, config edits and live progress (#512). */
    val syncControl: SyncControl by lazy { TempNoopSyncControl }

    /** The Hub's "All checks pass" / "N problems" line (#514). */
    val healthSummary: HealthSummary by lazy { TempNoopHealthSummary }

    /** A newer published release, for the Hub's Update card (#514). */
    val updateStatus: UpdateStatus by lazy { TempNoopUpdateStatus }

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
