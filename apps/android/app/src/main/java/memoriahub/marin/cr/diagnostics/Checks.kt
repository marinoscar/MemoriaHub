package memoriahub.marin.cr.diagnostics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.MediaSyncDevice
import memoriahub.marin.cr.net.MediaSyncReasons
import memoriahub.marin.cr.pairing.PairingStatus
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.update.AppRelease
import memoriahub.marin.cr.update.UpdatePolicy
import memoriahub.marin.cr.util.AppInfo
import memoriahub.marin.cr.util.Brand
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Check ids (docs/specs/android-media-sync.md §13.2). Stable: the web report viewer (#515) and
 * the runbook's troubleshooting table key on them. Order here is the report order.
 */
object CheckIds {
    const val APP_VERSION = "app.version"
    const val APP_UPDATE = "app.update"
    const val SERVER_CONFIGURED = "server.configured"
    const val SERVER_REACHABLE = "server.reachable"
    const val PAIRING_TOKEN = "pairing.token"
    const val AUTH_VALID = "auth.valid"
    const val API_CONNECTION = "api.connection"
    const val MEDIA_PERMISSION = "media.permission"
    const val MEDIA_LOCATION = "media.location"
    const val MEDIA_FOLDERS = "media.folders"
    const val MEDIA_TRIGGER = "media.trigger"
    const val WORK_PERIODIC = "work.periodic"
    const val SYNC_PAUSED = "sync.paused"
    const val NETWORK_POLICY = "network.policy"
    const val BATTERY = "battery.optimization"
    const val NOTIFICATIONS = "notifications.permission"
    const val SYNC_LAST = "sync.last"
    const val UPLOAD_BACKLOG = "upload.backlog"
    const val UPLOAD_STALLED = "upload.stalled"
    const val UPLOAD_TARGET = "upload.target"
    const val STORAGE_SPACE = "storage.space"
    const val TWA_VERIFICATION = "twa.verification"

    /** Every id, in report order (22). */
    val ALL = listOf(
        APP_VERSION, APP_UPDATE, SERVER_CONFIGURED, SERVER_REACHABLE, PAIRING_TOKEN, AUTH_VALID, API_CONNECTION,
        MEDIA_PERMISSION, MEDIA_LOCATION, MEDIA_FOLDERS, MEDIA_TRIGGER, WORK_PERIODIC, SYNC_PAUSED, NETWORK_POLICY,
        BATTERY, NOTIFICATIONS, SYNC_LAST, UPLOAD_BACKLOG, UPLOAD_STALLED, UPLOAD_TARGET, STORAGE_SPACE, TWA_VERIFICATION,
    )
}

/** Labels shown on the phone and stored with each check (§13.2). */
object CheckLabels {
    const val APP_VERSION = "App version"
    const val APP_UPDATE = "App update"
    const val SERVER_CONFIGURED = "Server address"
    const val SERVER_REACHABLE = "Server reachable"
    const val PAIRING_TOKEN = "Pairing token"
    const val AUTH_VALID = "Token accepted"
    const val API_CONNECTION = "API connection"
    const val MEDIA_PERMISSION = "Photo & video access"
    const val MEDIA_LOCATION = "Photo & video location access"
    const val MEDIA_FOLDERS = "Folders selected"
    const val MEDIA_TRIGGER = "New-photo trigger"
    const val WORK_PERIODIC = "Background sync scheduled"
    const val SYNC_PAUSED = "Sync state"
    const val NETWORK_POLICY = "Network"
    const val BATTERY = "Battery optimization"
    const val NOTIFICATIONS = "Notifications"
    const val SYNC_LAST = "Last sync"
    const val UPLOAD_BACKLOG = "Upload backlog"
    const val UPLOAD_STALLED = "Stalled uploads"
    const val UPLOAD_TARGET = "Target circle"
    const val STORAGE_SPACE = "Free space"
    const val TWA_VERIFICATION = "Full-screen web app (Digital Asset Links)"
}

/** Run error codes the checks branch on (§17.4). */
object RunErrorCodes {
    const val TARGET_CIRCLE_FORBIDDEN = "TARGET_CIRCLE_FORBIDDEN"
}

/**
 * Pure evaluation of each self-test check: inputs are what [SelfTest] probed; nothing here
 * touches Android, the network or the database, so every verdict is unit-tested (`ChecksTest`).
 */
object Checks {
    private val TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    fun formatTime(instant: Instant?, zone: ZoneId): String = instant?.let { TIME.format(it.atZone(zone)) } ?: "unknown"

    /** "12 min ago", "3 h ago", "2 days ago". */
    fun age(from: Instant, now: Instant): String {
        val d = Duration.between(from, now)
        return when {
            d.isNegative -> "in the future"
            d.toMinutes() < 1 -> "just now"
            d.toMinutes() < 60 -> "${d.toMinutes()} min ago"
            d.toHours() < 48 -> "${d.toHours()} h ago"
            else -> "${d.toDays()} days ago"
        }
    }

    fun formatBytes(bytes: Long): String = when {
        bytes >= 1L shl 30 -> "%.1f GB".format(java.util.Locale.ROOT, bytes / (1L shl 30).toDouble())
        bytes >= 1L shl 20 -> "%.0f MB".format(java.util.Locale.ROOT, bytes / (1L shl 20).toDouble())
        else -> "${bytes / 1024} KB"
    }

    private fun plural(n: Long, word: String) = "$n $word${if (n == 1L) "" else "s"}"
    private fun plural(n: Int, word: String) = plural(n.toLong(), word)

    private fun describe(error: ApiError): String = when (error.kind) {
        ApiError.Kind.HTTP -> "HTTP ${error.httpStatus} ${error.code.orEmpty()}${error.reason?.let { " ($it)" }.orEmpty()}"
        else -> error.message
    }

    private fun <T> describe(probe: Probe<ApiResult<T>>): String? = when (probe) {
        is Probe.Ok -> (probe.value as? ApiResult.Failure)?.error?.let(::describe)
        is Probe.Error -> probe.description
        is Probe.TimedOut -> "no answer within ${probe.timeoutMs / 1000} s"
    }

    private fun failure(probe: Probe<*>): String = when (probe) {
        is Probe.Ok -> "ok"
        is Probe.Error -> probe.description
        is Probe.TimedOut -> "no answer within ${probe.timeoutMs / 1000} s"
    }

    // --- app and server -------------------------------------------------------------------

    /** `app.version`: informational. */
    fun appVersion(app: AppInfo): CheckResult {
        val signer = app.signingSha256?.let { "signed with $it" } ?: "the signing certificate could not be read"
        val data = buildJsonObject {
            put("versionName", app.versionName)
            put("versionCode", app.versionCode)
            put("packageName", app.packageName)
            put("signingSha256", app.signingSha256)
        }
        return CheckResult.of(
            CheckIds.APP_VERSION, CheckLabels.APP_VERSION, CheckStatus.PASS,
            "${Brand.name} ${app.versionName} (${app.versionCode}), ${app.packageName}, $signer.",
            data = data,
        )
    }

    /**
     * `app.update`: warn when the server's current release has a higher versionCode; skip when
     * not paired, no release is published, the release is for another package, or the call failed.
     */
    fun appUpdate(paired: Boolean, app: AppInfo, latest: Probe<ApiResult<AppRelease>>?): CheckResult {
        val id = CheckIds.APP_UPDATE
        val label = CheckLabels.APP_UPDATE
        val installed = "${app.versionName} (${app.versionCode})"
        fun skip(detail: String) = CheckResult.of(id, label, CheckStatus.SKIP, detail)
        if (!paired) return skip("Not paired: checking for updates needs this phone's pairing.")
        val result = when (latest) {
            null -> return skip("Not checked.")
            is Probe.TimedOut -> return skip("The server did not answer the update check within ${latest.timeoutMs / 1000} s.")
            is Probe.Error -> return skip("The update check failed: ${latest.description}.")
            is Probe.Ok -> latest.value
        }
        val release = when (result) {
            is ApiResult.Failure -> return if (UpdatePolicy.isNoRelease(result.error)) {
                skip("The server publishes no Android app release.")
            } else {
                skip("The update check failed: ${describe(result.error)}.")
            }
            is ApiResult.Success -> result.value
        }
        val data = buildJsonObject {
            put("latestVersionCode", release.versionCode)
            put("latestVersionName", release.versionName)
            put("updateAvailable", UpdatePolicy.isUpdate(release, app.packageName, app.versionCode))
        }
        return when {
            release.packageName != app.packageName -> CheckResult.of(
                id, label, CheckStatus.SKIP,
                "The server's release is for ${release.packageName}, not this app (${app.packageName}).",
                data = data,
            )
            release.versionCode > app.versionCode -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "${Brand.name} ${release.versionName} (${release.versionCode}) is available; you have $installed.",
                remedy = "Tap Get the update: the browser downloads the APK and Android installs it.",
                action = CheckAction.GET_UPDATE,
                data = data,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Up to date ($installed).", data = data)
        }
    }

    /** `server.configured`: fail when unset. */
    fun serverConfigured(url: String?): CheckResult =
        if (url.isNullOrBlank()) {
            CheckResult.of(
                CheckIds.SERVER_CONFIGURED, CheckLabels.SERVER_CONFIGURED, CheckStatus.FAIL,
                "No ${Brand.name} server address is set.",
                remedy = "Set the server address on the Media sync screen.",
                action = CheckAction.SET_SERVER,
            )
        } else {
            CheckResult.of(CheckIds.SERVER_CONFIGURED, CheckLabels.SERVER_CONFIGURED, CheckStatus.PASS, url)
        }

    /** `server.reachable`: `GET /api/health/live` within 5 s; fail otherwise. */
    fun serverReachable(url: String?, live: Probe<ApiResult<JsonElement>>?): CheckResult {
        val id = CheckIds.SERVER_REACHABLE
        val label = CheckLabels.SERVER_REACHABLE
        if (url.isNullOrBlank() || live == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No server address is set.")
        val failure = describe(live)
        val ms = (live as? Probe.Ok)?.elapsedMs
        val data = buildJsonObject { ms?.let { put("latencyMs", it) } }
        return if (failure != null) {
            CheckResult.of(
                id, label, CheckStatus.FAIL,
                "GET /api/health/live failed: $failure.",
                remedy = "Check the phone's network and the server address: $url/api/health/live must answer in a browser.",
                data = data,
            )
        } else {
            CheckResult.of(id, label, CheckStatus.PASS, "The server answered in $ms ms.", data = data)
        }
    }

    /** `pairing.token`: fail with no token (or registration missing / expired); warn under 14 days left. */
    fun pairingToken(pairing: PairingStatus, now: Instant, zone: ZoneId): CheckResult {
        val id = CheckIds.PAIRING_TOKEN
        val label = CheckLabels.PAIRING_TOKEN
        val expiresAt = pairing.tokenExpiresAt
        val data = buildJsonObject {
            put("tokenExpiresAt", expiresAt?.toString())
            put("expired", pairing.expired)
            put("deviceId", pairing.deviceId)
        }
        fun fail(detail: String, remedy: String) = CheckResult.of(id, label, CheckStatus.FAIL, detail, remedy, CheckAction.REPAIR, data)
        return when {
            !pairing.hasToken -> fail("This phone is not paired with a ${Brand.name} account.", "Pair on the Connect screen.")
            pairing.expired && expiresAt != null && !expiresAt.isAfter(now) ->
                fail("The pairing token expired on ${formatTime(expiresAt, zone)}. Syncing is stopped.", "Re-pair on the Connect screen.")
            pairing.expired -> fail(
                "The server refused this phone's token (pairing expired or revoked). Syncing is stopped.",
                "Re-pair on the Connect screen.",
            )
            pairing.deviceId.isNullOrEmpty() ->
                fail("Signed in, but the phone was never registered.", "Retry registration or re-pair on the Connect screen.")
            expiresAt == null -> CheckResult.of(id, label, CheckStatus.PASS, "Paired (the server reported no expiry).", data = data)
            else -> {
                val days = Duration.between(now, expiresAt).toDays()
                if (days < DiagnosticsLimits.TOKEN_WARN_DAYS) {
                    CheckResult.of(
                        id, label, CheckStatus.WARN,
                        "The pairing token expires in ${plural(days, "day")} (${formatTime(expiresAt, zone)}).",
                        remedy = "Re-pair before it expires, or syncing stops at expiry.",
                        action = CheckAction.REPAIR,
                        data = data,
                    )
                } else {
                    CheckResult.of(id, label, CheckStatus.PASS, "Valid until ${formatTime(expiresAt, zone)} ($days days).", data = data)
                }
            }
        }
    }

    /** `auth.valid`: `GET /api/media-sync/devices/:id`; 401 fails (expired), 404/409 fail (revoked). */
    fun authValid(url: String?, paired: Boolean, device: Probe<ApiResult<MediaSyncDevice>>?): CheckResult {
        val id = CheckIds.AUTH_VALID
        val label = CheckLabels.AUTH_VALID
        if (url.isNullOrBlank()) return CheckResult.of(id, label, CheckStatus.SKIP, "No server address is set.")
        if (!paired || device == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: nothing to authenticate.")
        val ms = (device as? Probe.Ok)?.elapsedMs
        val data = buildJsonObject { ms?.let { put("latencyMs", it) } }
        fun revoked(detail: String) = CheckResult.of(
            id, label, CheckStatus.FAIL, detail,
            remedy = "The device was removed on the web. Pair this phone again on the Connect screen.",
            action = CheckAction.REPAIR,
            data = data,
        )
        val result = (device as? Probe.Ok)?.value
        if (result is ApiResult.Success) {
            val view = result.value
            return if (view.status == "revoked") {
                revoked("The server lists this phone as revoked.")
            } else {
                CheckResult.of(id, label, CheckStatus.PASS, "Token accepted; device ${view.name ?: view.id} is ${view.status ?: "active"} ($ms ms).", data = data)
            }
        }
        val error = (result as? ApiResult.Failure)?.error
        return when {
            error?.httpStatus == 401 -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "Pairing expired: the server refused the token (HTTP 401).",
                remedy = "Re-pair on the Connect screen.",
                action = CheckAction.REPAIR,
                data = data,
            )
            error?.httpStatus == 404 || error?.httpStatus == 409 || error?.reason == MediaSyncReasons.DEVICE_REVOKED ->
                revoked("Device revoked: the server no longer knows this phone (HTTP ${error.httpStatus}${error.reason?.let { " $it" }.orEmpty()}).")
            else -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "GET /api/media-sync/devices/:id failed: ${describe(device)}.",
                remedy = "Fix the server connection first (see ${CheckLabels.SERVER_REACHABLE}).",
                data = data,
            )
        }
    }

    /** `api.connection`: the last successful check-in is under 24 h old. */
    fun apiConnection(paired: Boolean, lastCheckinAt: Instant?, now: Instant): CheckResult {
        val id = CheckIds.API_CONNECTION
        val label = CheckLabels.API_CONNECTION
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: the phone checks in only while paired.")
        val data = buildJsonObject { put("lastCheckinAt", lastCheckinAt?.toString()) }
        if (lastCheckinAt == null) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "This phone has not checked in with the server yet.",
                remedy = "Tap Sync now: every sync starts with a check-in.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
        }
        val hours = Duration.between(lastCheckinAt, now).toHours()
        return if (hours >= DiagnosticsLimits.CHECKIN_STALE_HOURS) {
            CheckResult.of(
                id, label, CheckStatus.FAIL,
                "The last successful check-in was ${age(lastCheckinAt, now)}: the server has not heard from this phone for over a day.",
                remedy = "Tap Sync now, then look at ${CheckLabels.BATTERY} and ${CheckLabels.WORK_PERIODIC}.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
        } else {
            CheckResult.of(id, label, CheckStatus.PASS, "Last successful check-in ${age(lastCheckinAt, now)}.", data = data)
        }
    }

    // --- media ------------------------------------------------------------------------------

    /** `media.permission`: full passes, partial warns, denied fails. */
    fun mediaPermission(state: MediaPermissionState?): CheckResult {
        val id = CheckIds.MEDIA_PERMISSION
        val label = CheckLabels.MEDIA_PERMISSION
        return when (state) {
            null -> CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the media permission.")
            MediaPermissionState.FULL -> CheckResult.of(id, label, CheckStatus.PASS, "${Brand.name} can read all photos and videos.")
            MediaPermissionState.PARTIAL -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Access is limited to selected photos and videos: only selected photos sync.",
                remedy = "Allow access to all photos and videos.",
                action = CheckAction.GRANT_MEDIA,
            )
            MediaPermissionState.DENIED -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "${Brand.name} cannot read photos or videos: nothing syncs.",
                remedy = "Allow access to photos and videos.",
                action = CheckAction.GRANT_MEDIA,
            )
        }
    }

    /** `media.location`: warn when `ACCESS_MEDIA_LOCATION` is missing (Android 10+), since photo and video uploads lose their location. */
    fun mediaLocation(sdkInt: Int, granted: Boolean?): CheckResult {
        val id = CheckIds.MEDIA_LOCATION
        val label = CheckLabels.MEDIA_LOCATION
        return when {
            sdkInt < 29 -> CheckResult.of(id, label, CheckStatus.PASS, "Photo and video locations are readable (no separate permission before Android 10).")
            granted == null -> CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the location permission.")
            granted -> CheckResult.of(id, label, CheckStatus.PASS, "Uploads keep the location of photos and videos.")
            else -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Location access is not granted: Android strips the location from uploaded photos and videos.",
                remedy = "Allow access to photo and video locations.",
                action = CheckAction.GRANT_MEDIA,
            )
        }
    }

    /**
     * `media.folders`: fail with no folder selected; warn when a selected bucket no longer exists
     * on the phone ([inventory] null = unknown, e.g. no media permission, so not judged).
     */
    fun mediaFolders(paired: Boolean, config: SyncConfigView?, inventory: List<Bucket>?): CheckResult {
        val id = CheckIds.MEDIA_FOLDERS
        val label = CheckLabels.MEDIA_FOLDERS
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired.")
        if (config == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No configuration yet: it arrives with the first check-in.")
        val selected = config.folderIds.distinct()
        val data = buildJsonObject {
            put("selected", selected.size)
            putJsonArray("folderIds") { selected.forEach { add(JsonPrimitive(it)) } }
        }
        if (selected.isEmpty()) {
            return CheckResult.of(
                id, label, CheckStatus.FAIL,
                "No folder is selected: nothing syncs.",
                remedy = "Choose the folders to back up (for example Camera).",
                action = CheckAction.CHOOSE_FOLDERS,
                data = data,
            )
        }
        val known = inventory?.associateBy { it.bucketId }
        val missing = if (known == null) emptyList() else selected.filter { it !in known }
        if (missing.isNotEmpty()) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "${plural(missing.size, "selected folder")} no longer exist${if (missing.size == 1) "s" else ""} on this phone (of ${selected.size} selected).",
                remedy = "Review the folder selection.",
                action = CheckAction.CHOOSE_FOLDERS,
                data = buildJsonObject {
                    put("selected", selected.size)
                    putJsonArray("missingBucketIds") { missing.forEach { add(JsonPrimitive(it)) } }
                },
            )
        }
        val names = known?.let { k -> selected.mapNotNull { k[it]?.name } }.orEmpty()
        val detail = if (names.isNotEmpty()) "${plural(selected.size, "folder")}: ${names.joinToString(", ").take(200)}." else "${plural(selected.size, "folder")} selected."
        return CheckResult.of(id, label, CheckStatus.PASS, detail, data = data)
    }

    /** `media.trigger`: the `media-sync-trigger` work is enqueued; fail otherwise, unless paused. */
    fun mediaTrigger(paired: Boolean, paused: Boolean, armed: Probe<Boolean>?, lastTriggerAt: Instant?, now: Instant): CheckResult {
        val id = CheckIds.MEDIA_TRIGGER
        val label = CheckLabels.MEDIA_TRIGGER
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: new photos are watched only while paired.")
        if (paused) return CheckResult.of(id, label, CheckStatus.SKIP, "Sync is paused: new photos are not watched.")
        val data = buildJsonObject { put("lastTriggerAt", lastTriggerAt?.toString()) }
        if (armed !is Probe.Ok) {
            return CheckResult.of(id, label, CheckStatus.FAIL, "Could not read WorkManager: ${armed?.let(::failure) ?: "not checked"}.", data = data)
        }
        return if (armed.value) {
            val last = lastTriggerAt?.let { "; last fired ${age(it, now)}" }.orEmpty()
            CheckResult.of(id, label, CheckStatus.PASS, "New photos and videos start a sync within a few minutes$last.", data = data)
        } else {
            CheckResult.of(
                id, label, CheckStatus.FAIL,
                "The new-photo trigger is not armed: new photos wait for the 6-hourly catch-up.",
                remedy = "Tap Sync now (it re-arms the trigger).",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
        }
    }

    /** `work.periodic`: `media-sync-periodic` is enqueued (6-hourly catch-up). */
    fun workPeriodic(paired: Boolean, paused: Boolean, scheduled: Probe<Boolean>?): CheckResult {
        val id = CheckIds.WORK_PERIODIC
        val label = CheckLabels.WORK_PERIODIC
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: background sync runs only while paired.")
        if (paused) return CheckResult.of(id, label, CheckStatus.SKIP, "Sync is paused: background sync is off until you resume.")
        if (scheduled !is Probe.Ok) {
            return CheckResult.of(id, label, CheckStatus.FAIL, "Could not read WorkManager: ${scheduled?.let(::failure) ?: "not checked"}.")
        }
        return if (scheduled.value) {
            CheckResult.of(id, label, CheckStatus.PASS, "The 6-hourly catch-up sync is scheduled.")
        } else {
            CheckResult.of(
                id, label, CheckStatus.FAIL,
                "The background sync is not scheduled.",
                remedy = "Tap Sync now (this schedules it again); re-pair if not paired.",
                action = CheckAction.SYNC_NOW,
            )
        }
    }

    /** `sync.paused`: warn when paused. */
    fun syncPaused(paired: Boolean, config: SyncConfigView?): CheckResult {
        val id = CheckIds.SYNC_PAUSED
        val label = CheckLabels.SYNC_PAUSED
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired.")
        if (config == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No configuration yet.")
        return if (config.paused) {
            CheckResult.of(
                id, label, CheckStatus.WARN,
                "Syncing is paused (here or on the web).",
                remedy = "Resume syncing.",
                action = CheckAction.RESUME,
            )
        } else {
            CheckResult.of(id, label, CheckStatus.PASS, "Syncing is on.")
        }
    }

    /** `network.policy`: warn when Wi-Fi only is set, the phone is on cellular, and files are pending. */
    fun networkPolicy(config: SyncConfigView?, onCellularOnly: Boolean?, pending: Int): CheckResult {
        val id = CheckIds.NETWORK_POLICY
        val label = CheckLabels.NETWORK_POLICY
        if (config == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No configuration yet.")
        val mode = if (config.network == NetworkMode.WIFI) "Wi-Fi only" else "Wi-Fi and mobile data"
        val charging = if (config.requireCharging) ", only while charging" else ""
        val data = buildJsonObject {
            put("network", config.network.name.lowercase())
            put("requireCharging", config.requireCharging)
            onCellularOnly?.let { put("onCellular", it) }
            put("pending", pending)
        }
        return if (config.network == NetworkMode.WIFI && onCellularOnly == true && pending > 0) {
            CheckResult.of(
                id, label, CheckStatus.WARN,
                "Uploads are set to Wi-Fi only and the phone is on mobile data: ${plural(pending, "file")} wait for Wi-Fi.",
                remedy = "Connect to Wi-Fi, or allow mobile data in Network & power.",
                action = CheckAction.NETWORK_SETTINGS,
                data = data,
            )
        } else {
            CheckResult.of(id, label, CheckStatus.PASS, "$mode$charging.", data = data)
        }
    }

    // --- phone ------------------------------------------------------------------------------

    /** `battery.optimization`: warn when the app is not exempt. */
    fun batteryOptimization(ignoring: Boolean?): CheckResult {
        val id = CheckIds.BATTERY
        val label = CheckLabels.BATTERY
        return when (ignoring) {
            null -> CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the battery setting.")
            true -> CheckResult.of(id, label, CheckStatus.PASS, "${Brand.name} is exempt from battery optimization.")
            false -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Battery optimization is on for ${Brand.name}: Android may delay or skip background syncs and new-photo triggers.",
                remedy = "Allow ${Brand.name} to run unrestricted in the background.",
                action = CheckAction.BATTERY_SETTINGS,
            )
        }
    }

    /** `notifications.permission`: warn when denied (Android 13+) or turned off. */
    fun notifications(sdkInt: Int, permissionGranted: Boolean?, enabled: Boolean?): CheckResult {
        val id = CheckIds.NOTIFICATIONS
        val label = CheckLabels.NOTIFICATIONS
        return when {
            sdkInt >= 33 && permissionGranted == false -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "The notification permission is not granted: you will miss upload progress and \"Re-pair\" prompts.",
                remedy = "Allow notifications for ${Brand.name}.",
                action = CheckAction.NOTIFICATION_SETTINGS,
            )
            enabled == false -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "Notifications are turned off for ${Brand.name}: you will miss \"Re-pair\" and permission prompts.",
                remedy = "Turn notifications on for ${Brand.name}.",
                action = CheckAction.NOTIFICATION_SETTINGS,
            )
            permissionGranted == null && enabled == null -> CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the notification settings.")
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Notifications are allowed.")
        }
    }

    /** `storage.space`: informational; warn under 500 MB (hashing and temp files). */
    fun storageSpace(freeBytes: Long?): CheckResult {
        val id = CheckIds.STORAGE_SPACE
        val label = CheckLabels.STORAGE_SPACE
        if (freeBytes == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the free space.")
        val data = buildJsonObject { put("freeBytes", freeBytes) }
        return if (freeBytes < DiagnosticsLimits.LOW_SPACE_BYTES) {
            CheckResult.of(
                id, label, CheckStatus.WARN,
                "Only ${formatBytes(freeBytes)} free on the phone.",
                remedy = "Free some space: Android pauses background work when storage is low.",
                data = data,
            )
        } else {
            CheckResult.of(id, label, CheckStatus.PASS, "${formatBytes(freeBytes)} free.", data = data)
        }
    }

    // --- sync and uploads -------------------------------------------------------------------

    /**
     * `sync.last` over the local `sync_runs` (newest first): fail on 3 failed runs in a row;
     * warn when the last `ok` run is older than 24 h while files are pending.
     */
    fun syncLast(paired: Boolean, runs: List<SyncRunEntity>?, pending: Int, now: Instant): CheckResult {
        val id = CheckIds.SYNC_LAST
        val label = CheckLabels.SYNC_LAST
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired: no sync runs.")
        if (runs == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the local run history.")
        val last = runs.firstOrNull()
            ?: return CheckResult.of(id, label, CheckStatus.WARN, "No sync has run on this phone yet.", remedy = "Tap Sync now.", action = CheckAction.SYNC_NOW)
        val lastAt = Instant.ofEpochMilli(last.finishedAt ?: last.startedAt)
        val lastOk = runs.firstOrNull { it.status == "ok" }
        val lastOkAt = lastOk?.let { Instant.ofEpochMilli(it.finishedAt ?: it.startedAt) }
        val failedInARow = runs.takeWhile { it.status == "failed" }.size
        val data = buildJsonObject {
            put("lastRunAt", lastAt.toString())
            put("lastStatus", last.status)
            put("lastTrigger", last.trigger)
            put("lastErrorCode", last.errorCode)
            put("lastOkAt", lastOkAt?.toString())
            put("failedInARow", failedInARow)
            put("pending", pending)
        }
        val error = last.errorCode?.let { " ($it)" }.orEmpty()
        return when {
            failedInARow >= DiagnosticsLimits.FAILED_RUNS_IN_A_ROW -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "The last $failedInARow syncs failed; the latest ${age(lastAt, now)}$error.",
                remedy = "Fix the failing checks above, then tap Sync now.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
            pending > 0 && (lastOkAt == null || Duration.between(lastOkAt, now).toHours() >= DiagnosticsLimits.SYNC_STALE_HOURS) -> CheckResult.of(
                id, label, CheckStatus.WARN,
                (lastOkAt?.let { "The last complete sync was ${age(it, now)}" } ?: "No sync has completed yet") +
                    " and ${plural(pending, "file")} ${if (pending == 1) "is" else "are"} waiting. Latest run: ${last.status}$error, ${age(lastAt, now)}.",
                remedy = "Check ${CheckLabels.BATTERY}, ${CheckLabels.NETWORK_POLICY} and ${CheckLabels.WORK_PERIODIC}, then tap Sync now.",
                action = CheckAction.SYNC_NOW,
                data = data,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "Last sync ${age(lastAt, now)}: ${last.status} (${last.trigger})$error.", data = data)
        }
    }

    /** `upload.backlog`: warn when files failed (retrying), fail when files are blocked. */
    fun uploadBacklog(stats: SyncStats?): CheckResult {
        val id = CheckIds.UPLOAD_BACKLOG
        val label = CheckLabels.UPLOAD_BACKLOG
        if (stats == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the ledger.")
        val data = buildJsonObject {
            put("pending", stats.pending)
            put("uploading", stats.uploading)
            put("failed", stats.failed)
            put("blocked", stats.blocked)
            put("synced", stats.synced)
        }
        return when {
            stats.blocked > 0 -> CheckResult.of(
                id, label, CheckStatus.FAIL,
                "${plural(stats.blocked, "file")} ${if (stats.blocked == 1) "is" else "are"} blocked (no more automatic retries)" +
                    (if (stats.failed > 0) " and ${stats.failed} failed" else "") + ".",
                remedy = "See Files → Blocked for the reasons, then retry.",
                action = CheckAction.RETRY_FAILED,
                data = data,
            )
            stats.failed > 0 -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "${plural(stats.failed, "file")} failed and will be retried automatically.",
                remedy = "Retry now, or see Files → Failed.",
                action = CheckAction.RETRY_FAILED,
                data = data,
            )
            else -> CheckResult.of(
                id, label, CheckStatus.PASS,
                "No failed uploads; ${stats.synced} synced, ${stats.pending + stats.uploading} waiting.",
                data = data,
            )
        }
    }

    /** `upload.stalled`: warn when a row has been `UPLOADING` with no part progress for over 1 h. */
    fun uploadStalled(uploading: List<SyncFileEntity>?, now: Instant): CheckResult {
        val id = CheckIds.UPLOAD_STALLED
        val label = CheckLabels.UPLOAD_STALLED
        if (uploading == null) return CheckResult.of(id, label, CheckStatus.SKIP, "Could not read the ledger.")
        val cutoff = now.toEpochMilli() - DiagnosticsLimits.STALLED_UPLOAD_MS
        val stalled = uploading.filter { it.updatedAt < cutoff }
        if (stalled.isEmpty()) {
            val detail = if (uploading.isEmpty()) "No upload in progress." else "${plural(uploading.size, "upload")} in progress, all advancing."
            return CheckResult.of(id, label, CheckStatus.PASS, detail)
        }
        val oldest = stalled.minOf { it.updatedAt }
        val data = buildJsonObject {
            put("stalled", stalled.size)
            put("oldestProgressAt", Instant.ofEpochMilli(oldest).toString())
        }
        return CheckResult.of(
            id, label, CheckStatus.WARN,
            "${plural(stalled.size, "upload")} made no progress for over an hour (oldest ${age(Instant.ofEpochMilli(oldest), now)}).",
            remedy = "Retry; if it repeats, check the network and the server.",
            action = CheckAction.RETRY_FAILED,
            data = data,
        )
    }

    /** `upload.target`: fail when the latest run stopped on `TARGET_CIRCLE_FORBIDDEN`. */
    fun uploadTarget(paired: Boolean, config: SyncConfigView?, runs: List<SyncRunEntity>?): CheckResult {
        val id = CheckIds.UPLOAD_TARGET
        val label = CheckLabels.UPLOAD_TARGET
        if (!paired) return CheckResult.of(id, label, CheckStatus.SKIP, "Not paired.")
        val data = buildJsonObject { put("targetCircleId", config?.targetCircleId) }
        val last = runs?.firstOrNull { it.status != "paused" && it.status != "skipped" }
        return if (last?.errorCode == RunErrorCodes.TARGET_CIRCLE_FORBIDDEN) {
            CheckResult.of(
                id, label, CheckStatus.FAIL,
                "The server refused uploads to the target circle (you may have lost access to it).",
                remedy = "Choose another target circle on the web: Settings → Media sync.",
                action = CheckAction.OPEN_WEB_SETTINGS,
                data = data,
            )
        } else if (config?.targetCircleId == null) {
            CheckResult.of(id, label, CheckStatus.SKIP, "No target circle known yet: it arrives with the first check-in.", data = data)
        } else {
            CheckResult.of(id, label, CheckStatus.PASS, "Uploads go to the circle chosen on the web.", data = data)
        }
    }

    // --- TWA --------------------------------------------------------------------------------

    /** `twa.verification`: assetlinks.json lists this package with this build's signing SHA-256. Warn only. */
    fun twaVerification(url: String?, app: AppInfo, assetLinks: Probe<ApiResult<String>>?): CheckResult {
        val id = CheckIds.TWA_VERIFICATION
        val label = CheckLabels.TWA_VERIFICATION
        if (url.isNullOrBlank() || assetLinks == null) return CheckResult.of(id, label, CheckStatus.SKIP, "No server address is set.")
        val fingerprint = app.signingSha256
        val trustRemedy = "An administrator trusts this build in ${Brand.name}: Admin → Settings → Android app (${app.packageName}, $fingerprint); then reopen the app."
        val failure = describe(assetLinks)
        if (failure != null) {
            return CheckResult.of(
                id, label, CheckStatus.WARN,
                "Could not fetch $url/.well-known/assetlinks.json: $failure. Without it the web app opens with a browser address bar.",
                remedy = trustRemedy,
                action = CheckAction.OPEN_ANDROID_APP_ADMIN,
            )
        }
        val body = ((assetLinks as Probe.Ok).value as ApiResult.Success).value
        val listed = AssetLinks.fingerprintsFor(body, app.packageName)
        val data = buildJsonObject {
            put("packageName", app.packageName)
            put("signingSha256", fingerprint)
            if (listed != null) putJsonArray("listedFingerprints") { listed.forEach { add(JsonPrimitive(it)) } }
        }
        return when {
            listed == null -> CheckResult.of(
                id, label, CheckStatus.WARN, "assetlinks.json is not a valid statement list.",
                remedy = trustRemedy, action = CheckAction.OPEN_ANDROID_APP_ADMIN, data = data,
            )
            fingerprint == null -> CheckResult.of(id, label, CheckStatus.WARN, "This app's signing certificate could not be read, so the match cannot be checked.", data = data)
            listed.isEmpty() -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "assetlinks.json does not list ${app.packageName}: the web app opens with an address bar. This build's fingerprint: $fingerprint.",
                remedy = trustRemedy,
                action = CheckAction.OPEN_ANDROID_APP_ADMIN,
                data = data,
            )
            listed.none { AssetLinks.sameFingerprint(it, fingerprint) } -> CheckResult.of(
                id, label, CheckStatus.WARN,
                "assetlinks.json lists ${app.packageName} but not this build's fingerprint $fingerprint.",
                remedy = trustRemedy,
                action = CheckAction.OPEN_ANDROID_APP_ADMIN,
                data = data,
            )
            else -> CheckResult.of(id, label, CheckStatus.PASS, "assetlinks.json lists ${app.packageName} with this build's fingerprint.", data = data)
        }
    }
}

/** Digital Asset Links parsing (`/.well-known/assetlinks.json`). */
object AssetLinks {
    private const val RELATION = "delegate_permission/common.handle_all_urls"
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Fingerprints the document grants [packageName] for `handle_all_urls`; empty when the package
     * is not listed; null when the body is not a JSON array of statements.
     */
    fun fingerprintsFor(body: String, packageName: String): List<String>? {
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonArray ?: return null
        val out = mutableListOf<String>()
        for (statement in root) {
            val obj = statement as? JsonObject ?: continue
            val relations = runCatching { obj["relation"]?.jsonArray?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } }.getOrNull().orEmpty()
            if (RELATION !in relations) continue
            val target = runCatching { obj["target"]?.jsonObject }.getOrNull() ?: continue
            if ((target["namespace"] as? JsonPrimitive)?.contentOrNull != "android_app") continue
            if ((target["package_name"] as? JsonPrimitive)?.contentOrNull != packageName) continue
            runCatching { target["sha256_cert_fingerprints"]?.jsonArray }.getOrNull()
                ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                ?.let { out += it }
        }
        return out
    }

    /** `AA:BB:…` vs `aabb…`: equal ignoring case and colons. */
    fun sameFingerprint(a: String, b: String): Boolean =
        a.replace(":", "").equals(b.replace(":", ""), ignoreCase = true)
}
