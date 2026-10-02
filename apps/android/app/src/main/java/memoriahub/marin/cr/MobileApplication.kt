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
// #514 diagnostics + updates
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.HealthSummary
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.contract.UpdateStatus
import memoriahub.marin.cr.diagnostics.AndroidDiagnosticsPlatform
import memoriahub.marin.cr.diagnostics.ApiDiagnosticsApi
import memoriahub.marin.cr.diagnostics.ApiServerProbe
import memoriahub.marin.cr.diagnostics.AutoDiagnostics
import memoriahub.marin.cr.diagnostics.DiagnosticsHealth
import memoriahub.marin.cr.diagnostics.DiagnosticsService
import memoriahub.marin.cr.diagnostics.LedgerDiagnosticsSource
import memoriahub.marin.cr.diagnostics.PrefsAutoDiagnosticsStore
import memoriahub.marin.cr.diagnostics.SelfTest
import memoriahub.marin.cr.update.ApiReleaseApi
import memoriahub.marin.cr.update.PrefsUpdateStore
import memoriahub.marin.cr.update.ReleaseApi
import memoriahub.marin.cr.update.UpdateChecker
import memoriahub.marin.cr.update.openInBrowser

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
 * - #514 diagnostics + updates (done): [diagnostics] / [healthSummary], [autoDiagnostics], [updateStatus],
 *   wired into [onAppOpen].
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

    // ---------------------------------------------------------------------------------------------
    // #514 diagnostics + updates (docs/specs/android-media-sync.md §13)
    // ---------------------------------------------------------------------------------------------

    /**
     * TEMP(#514) replaced at merge by #512's `syncControl` (WorkManagerSyncControl). Diagnostics reads
     * sync state only through this seam; the no-op reports nothing scheduled and no check-in yet.
     */
    val syncControl: SyncControl by lazy { TempNoopSyncControl }

    /** `GET /api/android-app/releases/latest`, `POST …/:id/download-link` (PAT). */
    val releaseApi: ReleaseApi by lazy { ApiReleaseApi(apiClient) }

    /** The Hub's update card (§13.6): checked on app open and Hub resume, at most every 12 h, only while paired. */
    val updateStatus: UpdateStatus by lazy {
        UpdateChecker(
            api = releaseApi,
            store = PrefsUpdateStore.from(this),
            ownPackage = packageName,
            ownVersionCode = BuildConfig.VERSION_CODE.toLong(),
            isPaired = { pairingStatus().paired },
            serverUrl = { serverConfig.serverUrl },
            openUrl = { url -> openInBrowser(this, url) },
            onApiFailure = { apiErrorReactions.handle(it) },
        )
    }

    private val diagnosticsService: DiagnosticsService by lazy {
        val api = ApiDiagnosticsApi(apiClient)
        DiagnosticsService(
            selfTest = {
                SelfTest(
                    platform = AndroidDiagnosticsPlatform(this),
                    serverUrl = { serverConfig.serverUrl },
                    server = ApiServerProbe(apiClient),
                    api = api,
                    releases = releaseApi,
                    pairing = ::pairingStatus,
                    sync = { syncControl },
                    ledger = LedgerDiagnosticsSource(ledger, mediaSyncDatabase.syncFiles(), mediaScanner),
                    onApiFailure = { apiErrorReactions.handle(it) },
                )
            },
            api = api,
            pairing = ::pairingStatus,
            token = { tokenStore.token },
            runs = { ledger.recentRuns(10) },
            onApiFailure = { apiErrorReactions.handle(it) },
        )
    }

    /** Self-test state shared by the Diagnostics screen and the Hub's health line. */
    val diagnostics: DiagnosticsHealth by lazy {
        DiagnosticsHealth(
            service = diagnosticsService,
            sync = { syncControl },
            recentRuns = { limit -> ledger.recentRuns(limit) },
            resetLedger = { ledger.resetLocalState() },
            scope = appScope,
        )
    }

    /** The Hub's `HealthLine` ("All checks pass" / "N problems"). */
    val healthSummary: HealthSummary get() = diagnostics

    /**
     * Uploads a report after a `failed`/`partial` run (at most every 6 h, only when paired and live).
     * #512's worker calls `autoDiagnostics.onRunFinished(status)` after recording each run.
     */
    val autoDiagnostics: AutoDiagnostics by lazy {
        AutoDiagnostics(
            pairing = ::pairingStatus,
            server = ApiServerProbe(apiClient),
            service = diagnosticsService,
            store = PrefsAutoDiagnosticsStore.from(this),
            scope = appScope,
        )
    }

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
        // #514: throttled (12 h) check for a newer published release; only while paired.
        appScope.launch { updateStatus.checkNow() }
    }

    companion object {
        fun from(context: Context): MobileApplication = context.applicationContext as MobileApplication
    }
}

/** TEMP(#514) replaced at merge by #512's WorkManagerSyncControl. */
private object TempNoopSyncControl : SyncControl {
    override val status: StateFlow<SyncStatusView> = MutableStateFlow(
        SyncStatusView(
            running = false, currentFile = null, bytesSent = 0, bytesTotal = 0, filesDone = 0, filesTotal = 0,
            lastRunAtMs = null, lastRunStatus = null, lastError = null, lastCheckinAtMs = null,
        ),
    )
    override fun currentConfig(): SyncConfigView? = null
    override fun syncNow() = Unit
    override suspend fun setPaused(paused: Boolean): Result<Unit> = Result.failure(UnsupportedOperationException("Background sync is not available yet."))
    override suspend fun retryFailed(): Result<Unit> = Result.failure(UnsupportedOperationException("Background sync is not available yet."))
    override suspend fun updateConfig(patch: memoriahub.marin.cr.contract.ConfigPatch): Result<Unit> =
        Result.failure(UnsupportedOperationException("Background sync is not available yet."))
    override suspend fun checkinNow(): Result<Unit> = Result.failure(UnsupportedOperationException("Background sync is not available yet."))
    override fun isPeriodicScheduled(): Boolean = false
    override fun isContentTriggerArmed(): Boolean = false
    override fun lastContentTriggerAtMs(): Long? = null
}
