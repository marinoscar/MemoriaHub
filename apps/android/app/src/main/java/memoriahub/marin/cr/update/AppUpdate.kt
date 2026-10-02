package memoriahub.marin.cr.update

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import memoriahub.marin.cr.BuildConfig
import memoriahub.marin.cr.contract.AvailableUpdate
import memoriahub.marin.cr.contract.UpdateStatus
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.time.Duration
import java.time.Instant

// =============================================================================
// In-app updates (docs/specs/android-media-sync.md §13.6, issue #514). The server hosts the APK
// releases (`GET /api/android-app/releases/latest`, issue #504); the app compares versionCodes
// and hands a short-lived, same-origin download link to the browser, whose download ends in the
// system package installer. Ported from evopath `update/AppUpdate.kt`.
// =============================================================================

/** `GET /api/android-app/releases/latest`: the `PublicRelease` (`sizeBytes` is a BigInt string). */
@Serializable
data class AppRelease(
    val id: String,
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val fileSha256: String? = null,
    val sizeBytes: String? = null,
    val notes: String? = null,
    val createdAt: String? = null,
) {
    val sizeBytesValue: Long get() = sizeBytes?.toLongOrNull() ?: 0L
}

/** `POST /api/android-app/releases/:id/download-link`: [url] is a same-origin path (`/api/android-app/download/<token>`). */
@Serializable
data class DownloadLink(val url: String, val expiresAt: String? = null)

/** The two release calls the phone makes (PAT); an interface so the checker is JVM-tested. */
interface ReleaseApi {
    suspend fun latest(): ApiResult<AppRelease>
    suspend fun downloadLink(releaseId: String): ApiResult<DownloadLink>
}

class ApiReleaseApi(private val api: ApiClient) : ReleaseApi {
    override suspend fun latest(): ApiResult<AppRelease> = api.get(LATEST, AppRelease.serializer())

    override suspend fun downloadLink(releaseId: String): ApiResult<DownloadLink> {
        if (!UpdatePolicy.isValidReleaseId(releaseId)) {
            return ApiResult.Failure(ApiError(ApiError.Kind.PARSE, message = "Invalid release id."))
        }
        return api.post(
            "$RELEASES/$releaseId/download-link",
            JsonObject(emptyMap()),
            JsonObject.serializer(),
            DownloadLink.serializer(),
        )
    }

    companion object {
        const val RELEASES = "/api/android-app/releases"
        const val LATEST = "$RELEASES/latest"
    }
}

/** Pure update rules (unit-tested in `UpdateTest`). */
object UpdatePolicy {
    /** The server is asked at most this often (app open, Hub resume). */
    val CHECK_INTERVAL: Duration = Duration.ofHours(12)

    /** `details.reason` of the 404 the server answers when it publishes no release. */
    const val NO_RELEASE = "NO_RELEASE"

    private val RELEASE_ID = Regex("^[A-Za-z0-9-]{1,64}$")

    fun isValidReleaseId(id: String): Boolean = RELEASE_ID.matches(id)

    /** True when never checked, the last check is [interval] old, or the clock moved backwards. */
    fun checkDue(last: Instant?, now: Instant, interval: Duration = CHECK_INTERVAL): Boolean =
        last == null || !now.isBefore(last.plus(interval)) || now.isBefore(last)

    /** A release is an update only for this package (a debug build never matches) and a strictly higher versionCode. */
    fun isUpdate(release: AppRelease, ownPackage: String, ownVersionCode: Long): Boolean =
        release.packageName == ownPackage && release.versionCode > ownVersionCode

    fun isNoRelease(error: ApiError): Boolean =
        error.httpStatus == 404 && (error.reason == null || error.reason == NO_RELEASE)

    /**
     * The absolute URL the browser opens for a download link: a same-origin path is resolved
     * against [server]; an absolute URL is accepted only on the server's own origin (scheme, host,
     * port). Null when the link points anywhere else.
     */
    fun downloadUrl(server: String, link: String): String? {
        val base = server.trim().trimEnd('/').toHttpUrlOrNull() ?: return null
        if (link.startsWith("/") && !link.startsWith("//")) {
            return base.resolve(link)?.takeIf { sameOrigin(it, base) }?.toString()
        }
        val absolute = link.toHttpUrlOrNull() ?: return null
        return absolute.takeIf { sameOrigin(it, base) }?.toString()
    }

    private fun sameOrigin(a: HttpUrl, b: HttpUrl) = a.scheme == b.scheme && a.host == b.host && a.port == b.port

    /** `12.3 MB` (one decimal), or null for an unknown size. */
    fun formatSize(bytes: Long?): String? = bytes?.takeIf { it > 0 }?.let { "%.1f MB".format(java.util.Locale.ROOT, it / 1_000_000.0) }

    fun toAvailable(release: AppRelease) = AvailableUpdate(
        releaseId = release.id,
        versionName = release.versionName,
        versionCode = release.versionCode,
        sizeBytes = release.sizeBytesValue,
        notes = release.notes?.takeIf { it.isNotBlank() },
    )
}

/** Persisted update state (SharedPreferences on the phone, in memory in tests). */
interface UpdateStore {
    var lastCheckAt: Instant?
    var available: AvailableUpdate?

    /** The versionCode that last ran; a different one means the app was just updated. */
    var lastSeenVersionCode: Long?
}

class InMemoryUpdateStore : UpdateStore {
    override var lastCheckAt: Instant? = null
    override var available: AvailableUpdate? = null
    override var lastSeenVersionCode: Long? = null
}

class PrefsUpdateStore(private val prefs: SharedPreferences) : UpdateStore {
    override var lastCheckAt: Instant?
        get() = prefs.getLong(KEY_LAST_CHECK, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli)
        set(value) = edit { if (value == null) remove(KEY_LAST_CHECK) else putLong(KEY_LAST_CHECK, value.toEpochMilli()) }

    override var available: AvailableUpdate?
        get() {
            val id = prefs.getString(KEY_ID, null) ?: return null
            val name = prefs.getString(KEY_NAME, null) ?: return null
            val code = prefs.getLong(KEY_CODE, 0L).takeIf { it > 0 } ?: return null
            return AvailableUpdate(
                releaseId = id,
                versionName = name,
                versionCode = code,
                sizeBytes = prefs.getLong(KEY_SIZE, 0L),
                notes = prefs.getString(KEY_NOTES, null),
            )
        }
        set(value) = edit {
            if (value == null) {
                remove(KEY_ID); remove(KEY_NAME); remove(KEY_CODE); remove(KEY_NOTES); remove(KEY_SIZE)
            } else {
                putString(KEY_ID, value.releaseId)
                putString(KEY_NAME, value.versionName)
                putLong(KEY_CODE, value.versionCode)
                putLong(KEY_SIZE, value.sizeBytes)
                if (value.notes == null) remove(KEY_NOTES) else putString(KEY_NOTES, value.notes)
            }
        }

    override var lastSeenVersionCode: Long?
        get() = prefs.getLong(KEY_SEEN, 0L).takeIf { it > 0 }
        set(value) = edit { if (value == null) remove(KEY_SEEN) else putLong(KEY_SEEN, value) }

    private inline fun edit(block: SharedPreferences.Editor.() -> Unit) = prefs.edit().apply(block).apply()

    companion object {
        const val PREFS_NAME = BuildConfig.STORAGE_PREFIX + "_app_update"
        private const val KEY_LAST_CHECK = "last_check_at"
        private const val KEY_ID = "available_release_id"
        private const val KEY_NAME = "available_version_name"
        private const val KEY_CODE = "available_version_code"
        private const val KEY_NOTES = "available_notes"
        private const val KEY_SIZE = "available_size_bytes"
        private const val KEY_SEEN = "last_seen_version_code"

        fun from(context: Context) =
            PrefsUpdateStore(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE))
    }
}

/** What one [UpdateChecker.check] did (logged; tests assert on it). */
sealed interface UpdateCheckOutcome {
    data object NotPaired : UpdateCheckOutcome
    data object Throttled : UpdateCheckOutcome
    data object NoRelease : UpdateCheckOutcome
    data object UpToDate : UpdateCheckOutcome
    data class Available(val update: AvailableUpdate) : UpdateCheckOutcome
    data class Failed(val error: ApiError) : UpdateCheckOutcome
}

/**
 * [UpdateStatus] (the Hub's update card): asks the server for its current release at most every
 * [UpdatePolicy.CHECK_INTERVAL], only while paired (the endpoint needs the PAT), and remembers a
 * newer one. A failed call leaves the throttle alone (retry on the next open).
 *
 * [openUrl] hands the validated download URL to the browser (`ACTION_VIEW`); false when no app
 * can open it.
 */
class UpdateChecker(
    private val api: ReleaseApi,
    private val store: UpdateStore,
    private val ownPackage: String,
    private val ownVersionCode: Long,
    private val isPaired: () -> Boolean,
    private val serverUrl: () -> String?,
    private val openUrl: (String) -> Boolean,
    /** Global 401 / DEVICE_REVOKED reactions (`apiErrorReactions.handle`). */
    private val onApiFailure: (ApiError) -> Unit = {},
    private val clock: () -> Instant = Instant::now,
) : UpdateStatus {
    private val mutex = Mutex()
    private val _available = MutableStateFlow<AvailableUpdate?>(null)
    override val available: StateFlow<AvailableUpdate?> = _available.asStateFlow()

    init {
        onLaunch()
    }

    /**
     * First launch after an update (a different versionCode than last time): forget the offered
     * update and the throttle, so the next check asks the server again.
     */
    private fun onLaunch() {
        runCatching {
            if (store.lastSeenVersionCode != ownVersionCode) {
                store.available = null
                store.lastCheckAt = null
                store.lastSeenVersionCode = ownVersionCode
            }
            publish()
        }
    }

    private fun publish() {
        _available.value = store.available?.takeIf { it.versionCode > ownVersionCode }
    }

    override suspend fun checkNow(force: Boolean) {
        runCatching { check(force) }.onFailure { AppLog.w(TAG, "update.check crashed", it) }
    }

    /** Asks the server when due (or [force]); see [UpdateCheckOutcome]. */
    suspend fun check(force: Boolean = false): UpdateCheckOutcome = mutex.withLock {
        if (!isPaired()) {
            publish()
            return@withLock UpdateCheckOutcome.NotPaired
        }
        val now = clock()
        if (!force && !UpdatePolicy.checkDue(store.lastCheckAt, now)) {
            publish()
            return@withLock UpdateCheckOutcome.Throttled
        }
        val outcome = when (val result = api.latest()) {
            is ApiResult.Success -> {
                val release = result.value
                store.lastCheckAt = now
                if (UpdatePolicy.isUpdate(release, ownPackage, ownVersionCode)) {
                    val update = UpdatePolicy.toAvailable(release)
                    store.available = update
                    AppLog.i(TAG, "update.available version=${release.versionName} code=${release.versionCode}")
                    UpdateCheckOutcome.Available(update)
                } else {
                    store.available = null
                    UpdateCheckOutcome.UpToDate
                }
            }
            is ApiResult.Failure -> if (UpdatePolicy.isNoRelease(result.error)) {
                store.lastCheckAt = now
                store.available = null
                UpdateCheckOutcome.NoRelease
            } else {
                AppLog.w(TAG, "update.check.fail status=${result.error.httpStatus ?: result.error.kind}")
                runCatching { onApiFailure(result.error) }
                UpdateCheckOutcome.Failed(result.error)
            }
        }
        publish()
        outcome
    }

    override suspend fun openDownload(): Result<Unit> {
        val update = _available.value ?: return Result.failure(IllegalStateException("No update is available."))
        val server = serverUrl() ?: return Result.failure(IllegalStateException("No server is configured."))
        val link = when (val result = api.downloadLink(update.releaseId)) {
            is ApiResult.Success -> result.value
            is ApiResult.Failure -> {
                AppLog.w(TAG, "update.link.fail status=${result.error.httpStatus ?: result.error.kind}")
                runCatching { onApiFailure(result.error) }
                if (result.error.httpStatus == 404) {
                    // The release was replaced or deleted: look again on the next check.
                    mutex.withLock {
                        store.lastCheckAt = null
                        store.available = null
                        publish()
                    }
                    return Result.failure(IllegalStateException("This release is no longer offered. Check again later."))
                }
                return Result.failure(IllegalStateException("Could not get the download link: ${result.error.message}"))
            }
        }
        val url = UpdatePolicy.downloadUrl(server, link.url)
            ?: return Result.failure(IllegalStateException("The server returned an unexpected download link."))
        if (!openUrl(url)) return Result.failure(IllegalStateException("No browser is installed to download the update."))
        AppLog.i(TAG, "update.download version=${update.versionName} code=${update.versionCode}")
        return Result.success(Unit)
    }

    private companion object {
        const val TAG = "Update"
    }
}
