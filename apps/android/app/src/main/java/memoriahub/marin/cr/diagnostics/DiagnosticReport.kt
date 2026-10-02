package memoriahub.marin.cr.diagnostics

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.update.UpdatePolicy
import java.time.Instant

/**
 * The diagnostics report the phone uploads (`POST /api/media-sync/devices/:id/diagnostics`),
 * shares and copies (docs/specs/android-media-sync.md §13.3): app, device, config (never the
 * token), stats, checks, inventory, recent runs and the log tail. The web renders it (#515).
 */
@Serializable
data class DiagnosticReport(
    val schemaVersion: Int = 1,
    val generatedAt: String,
    val summary: String,
    val counts: Counts,
    val app: AppSection,
    val device: DeviceSnapshot,
    val server: ServerSection,
    val pairing: PairingSection,
    val config: ConfigSection? = null,
    val sync: SyncSection? = null,
    val stats: StatsSection? = null,
    val checks: List<CheckResult>,
    val inventory: List<FolderInventory>,
    val recentRuns: List<RunSection>,
    val log: List<String>,
) {
    @Serializable
    data class Counts(val pass: Int, val warn: Int, val fail: Int, val skip: Int)

    @Serializable
    data class AppSection(
        val versionName: String,
        val versionCode: Long,
        val packageName: String,
        val signingSha256: String? = null,
        val latestVersionCode: Long? = null,
        val latestVersionName: String? = null,
        val updateAvailable: Boolean? = null,
    )

    @Serializable
    data class ServerSection(val url: String? = null)

    @Serializable
    data class PairingSection(
        val paired: Boolean,
        val deviceId: String? = null,
        val tokenExpiresAt: String? = null,
        val expired: Boolean = false,
        val pairedAt: String? = null,
    )

    /** The desired config as cached on the phone. Never contains a credential. */
    @Serializable
    data class ConfigSection(
        val targetCircleId: String? = null,
        val folderIds: List<String>,
        val includePhotos: Boolean,
        val includeVideos: Boolean,
        val network: String,
        val requireCharging: Boolean,
        val paused: Boolean,
        val uploadExisting: String,
        val configVersion: Int,
        val appliedConfigVersion: Int,
    )

    @Serializable
    data class SyncSection(
        val running: Boolean,
        val lastRunAt: String? = null,
        val lastRunStatus: String? = null,
        val lastError: String? = null,
        val lastCheckinAt: String? = null,
        val permission: String? = null,
    )

    @Serializable
    data class StatsSection(
        val eligible: Int,
        val uploaded: Int,
        val deduplicated: Int,
        val pending: Int,
        val uploading: Int,
        val failed: Int,
        val blocked: Int,
        val excluded: Int,
        val bytesPending: Long,
        val bytesUploaded: Long,
    )

    @Serializable
    data class RunSection(
        val trigger: String,
        val status: String,
        val startedAt: String,
        val finishedAt: String? = null,
        val filesUploaded: Int,
        val filesDeduplicated: Int,
        val filesFailed: Int,
        val bytesUploaded: Long,
        val errorCode: String? = null,
    )
}

/** A built report: the typed document, its redacted JSON and pretty text. */
class BuiltReport(val report: DiagnosticReport, val json: JsonObject, val text: String) {
    val summary: String get() = report.summary
    val sizeBytes: Int get() = text.toByteArray(Charsets.UTF_8).size
}

object DiagnosticReportBuilder {
    /** The API accepts at most 256 KB; the spec keeps reports under 200 KB. */
    const val MAX_BYTES = 200 * 1024

    private val pretty = Json(ApiClient.ApiJson) { prettyPrint = true }

    /**
     * Builds the report from a self-test, the local runs and the log tail. Every string is
     * redacted ([Redaction], plus the stored token verbatim via [secret]) and shrunk (log first,
     * then runs, then check `data`) until it is under [maxBytes].
     */
    fun build(
        result: SelfTestResult,
        runs: List<SyncRunEntity>,
        log: List<String>,
        secret: String? = null,
        maxBytes: Int = MAX_BYTES,
    ): BuiltReport {
        val pairing = result.pairing
        val release = result.latestRelease
        var report = DiagnosticReport(
            generatedAt = result.generatedAt.toString(),
            summary = result.summary,
            counts = DiagnosticReport.Counts(result.passCount, result.warnCount, result.failCount, result.skipCount),
            app = DiagnosticReport.AppSection(
                versionName = result.app.versionName,
                versionCode = result.app.versionCode,
                packageName = result.app.packageName,
                signingSha256 = result.app.signingSha256,
                latestVersionCode = release?.versionCode,
                latestVersionName = release?.versionName,
                updateAvailable = release?.let { UpdatePolicy.isUpdate(it, result.app.packageName, result.app.versionCode) },
            ),
            device = result.device,
            server = DiagnosticReport.ServerSection(result.serverUrl),
            pairing = DiagnosticReport.PairingSection(
                paired = pairing.paired,
                deviceId = pairing.deviceId,
                tokenExpiresAt = pairing.tokenExpiresAt?.toString(),
                expired = pairing.expired,
                pairedAt = pairing.pairedAt?.toString(),
            ),
            config = result.config?.let {
                DiagnosticReport.ConfigSection(
                    targetCircleId = it.targetCircleId,
                    folderIds = it.folderIds,
                    includePhotos = it.includePhotos,
                    includeVideos = it.includeVideos,
                    network = it.network.name.lowercase(),
                    requireCharging = it.requireCharging,
                    paused = it.paused,
                    uploadExisting = it.uploadExisting,
                    configVersion = it.configVersion,
                    appliedConfigVersion = it.appliedConfigVersion,
                )
            },
            sync = DiagnosticReport.SyncSection(
                running = result.syncStatus?.running ?: false,
                lastRunAt = result.syncStatus?.lastRunAtMs?.let { Instant.ofEpochMilli(it).toString() },
                lastRunStatus = result.syncStatus?.lastRunStatus,
                lastError = result.syncStatus?.lastError,
                lastCheckinAt = result.syncStatus?.lastCheckinAtMs?.let { Instant.ofEpochMilli(it).toString() },
                permission = result.permission?.wire,
            ),
            stats = result.stats?.let(::statsSection),
            checks = result.checks,
            inventory = result.folders,
            recentRuns = runs.take(DiagnosticsLimits.REPORT_RUNS).map(::runSection),
            log = log.takeLast(DiagnosticsLimits.REPORT_LOG_LINES),
        )
        var built = serialize(report, secret)
        while (built.sizeBytes > maxBytes) {
            report = when {
                report.log.isNotEmpty() -> report.copy(log = report.log.takeLast(report.log.size / 2))
                report.recentRuns.isNotEmpty() -> report.copy(recentRuns = report.recentRuns.take(report.recentRuns.size / 2))
                report.inventory.size > 1 -> report.copy(inventory = report.inventory.take(report.inventory.size / 2))
                report.checks.any { it.data != null } -> report.copy(checks = report.checks.map { it.copy(data = null) })
                else -> break
            }
            built = serialize(report, secret)
        }
        return built
    }

    private fun statsSection(s: SyncStats) = DiagnosticReport.StatsSection(
        eligible = s.eligible, uploaded = s.uploaded, deduplicated = s.deduplicated, pending = s.pending,
        uploading = s.uploading, failed = s.failed, blocked = s.blocked, excluded = s.excluded,
        bytesPending = s.bytesPending, bytesUploaded = s.bytesUploaded,
    )

    private fun runSection(r: SyncRunEntity) = DiagnosticReport.RunSection(
        trigger = r.trigger,
        status = r.status,
        startedAt = Instant.ofEpochMilli(r.startedAt).toString(),
        finishedAt = r.finishedAt?.let { Instant.ofEpochMilli(it).toString() },
        filesUploaded = r.filesUploaded,
        filesDeduplicated = r.filesDeduplicated,
        filesFailed = r.filesFailed,
        bytesUploaded = r.bytesUploaded,
        errorCode = r.errorCode,
    )

    /**
     * Redaction runs on every string of the JSON tree (keys and values), not on the serialized
     * text: a URL's query mask would otherwise swallow the closing quote and break the document.
     */
    private fun serialize(report: DiagnosticReport, secret: String?): BuiltReport {
        val tree = ApiClient.ApiJson.encodeToJsonElement(DiagnosticReport.serializer(), report)
        val json = redact(tree, secret).jsonObject
        return BuiltReport(report, json, pretty.encodeToString(JsonElement.serializer(), json))
    }

    /** [element] with [Redaction] applied to every string key and value. */
    fun redact(element: JsonElement, secret: String?): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.entries.associate { (k, v) -> Redaction.redact(k, secret) to redact(v, secret) })
        is JsonArray -> JsonArray(element.map { redact(it, secret) })
        is JsonPrimitive -> if (element.isString) JsonPrimitive(Redaction.redact(element.content, secret)) else element
        else -> element
    }
}
