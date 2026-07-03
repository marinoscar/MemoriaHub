package cr.marin.memoriahub.core.storage

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Non-secret app configuration: the server base URL the user entered on first
 * run, and the circle that camera media syncs into.
 *
 * Backed by [SharedPreferences] (not DataStore) deliberately: OkHttp interceptors
 * run on network threads and need a *synchronous* read of the server URL, which
 * DataStore's suspend/Flow API cannot provide without blocking. Reactive [StateFlow]s
 * are exposed for the UI layer.
 */
@Singleton
class AppConfigStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("app_config", Context.MODE_PRIVATE)

    private val _serverUrl = MutableStateFlow(prefs.getString(KEY_SERVER_URL, null))
    val serverUrlFlow: StateFlow<String?> = _serverUrl.asStateFlow()

    private val _targetCircleId = MutableStateFlow(prefs.getString(KEY_TARGET_CIRCLE, null))
    val targetCircleIdFlow: StateFlow<String?> = _targetCircleId.asStateFlow()

    private val _selectedBucketIds = MutableStateFlow(readSelectedBucketIds())
    /** The MediaStore bucket ids the user chose to back up; `null` until first configured. */
    val selectedBucketIdsFlow: StateFlow<Set<String>?> = _selectedBucketIds.asStateFlow()

    private val _backupEnabled = MutableStateFlow(readInitialBackupEnabled())
    /** Whether photo/video backup is on. Fresh installs default to off (opt-in). */
    val backupEnabledFlow: StateFlow<Boolean> = _backupEnabled.asStateFlow()

    private val _notifyBackupReminders =
        MutableStateFlow(prefs.getBoolean(KEY_NOTIFY_REMINDERS, true))
    /** Whether "backup is off and new items aren't backed up" reminders may be shown. */
    val notifyBackupRemindersFlow: StateFlow<Boolean> = _notifyBackupReminders.asStateFlow()

    private val _notifyBackupIssues =
        MutableStateFlow(prefs.getBoolean(KEY_NOTIFY_ISSUES, true))
    /** Whether "items failed to back up" alerts may be shown. */
    val notifyBackupIssuesFlow: StateFlow<Boolean> = _notifyBackupIssues.asStateFlow()

    /** Synchronous accessor for interceptors. */
    val serverUrl: String? get() = _serverUrl.value

    val targetCircleId: String? get() = _targetCircleId.value

    /** `null` = never configured (falls back to legacy camera-folder scanning). */
    val selectedBucketIds: Set<String>? get() = _selectedBucketIds.value

    /** Synchronous accessor for workers/schedulers. */
    val backupEnabled: Boolean get() = _backupEnabled.value

    val notifyBackupReminders: Boolean get() = _notifyBackupReminders.value

    val notifyBackupIssues: Boolean get() = _notifyBackupIssues.value

    fun setServerUrl(url: String?) {
        val normalized = url?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
        _serverUrl.value = normalized
    }

    fun setTargetCircleId(circleId: String?) {
        prefs.edit().putString(KEY_TARGET_CIRCLE, circleId).apply()
        _targetCircleId.value = circleId
    }

    fun setSelectedBucketIds(ids: Set<String>) {
        // Copy defensively: SharedPreferences must not be handed a mutable set it keeps a
        // reference to, and StateFlow needs a distinct instance to emit.
        val snapshot = ids.toSet()
        prefs.edit().putStringSet(KEY_SELECTED_BUCKETS, snapshot).apply()
        _selectedBucketIds.value = snapshot
    }

    fun setBackupEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_BACKUP_ENABLED, enabled).apply()
        _backupEnabled.value = enabled
    }

    fun setNotifyBackupReminders(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_REMINDERS, enabled).apply()
        _notifyBackupReminders.value = enabled
    }

    fun setNotifyBackupIssues(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_ISSUES, enabled).apply()
        _notifyBackupIssues.value = enabled
    }

    /** When the last "backup is off" reminder notification was posted (anti-spam cooldown). */
    var lastReminderNotifiedAtMs: Long
        get() = prefs.getLong(KEY_LAST_REMINDER_AT, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_REMINDER_AT, value).apply()
        }

    /** When the last "backup issues" notification was posted (anti-spam cooldown). */
    var lastIssueNotifiedAtMs: Long
        get() = prefs.getLong(KEY_LAST_ISSUE_AT, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_ISSUE_AT, value).apply()
        }

    /**
     * One-time default resolution for [backupEnabled]. Fresh installs start with backup
     * OFF (opt-in), but installs that were already syncing before the toggle existed must
     * stay ON — the update must never silently stop someone's backups. The computed
     * default is persisted, so `prefs.contains(KEY_BACKUP_ENABLED)` doubles as the
     * migration flag.
     */
    private fun readInitialBackupEnabled(): Boolean {
        if (!prefs.contains(KEY_BACKUP_ENABLED)) {
            val default = resolveInitialBackupEnabled(
                hasTargetCircle = prefs.getString(KEY_TARGET_CIRCLE, null) != null,
                lastScanDateAddedSec = prefs.getLong(KEY_LAST_SCAN_ADDED, 0L),
            )
            prefs.edit().putBoolean(KEY_BACKUP_ENABLED, default).apply()
        }
        return prefs.getBoolean(KEY_BACKUP_ENABLED, false)
    }

    private fun readSelectedBucketIds(): Set<String>? =
        if (prefs.contains(KEY_SELECTED_BUCKETS)) {
            prefs.getStringSet(KEY_SELECTED_BUCKETS, emptySet())?.toSet() ?: emptySet()
        } else {
            null
        }

    /** High-water mark (MediaStore DATE_ADDED, seconds) of the last incremental scan. */
    var lastScanDateAddedSec: Long
        get() = prefs.getLong(KEY_LAST_SCAN_ADDED, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SCAN_ADDED, value).apply()
        }

    /** MediaStore generation (primary volume) captured before the last scan; 0 = none. */
    var lastScanGeneration: Long
        get() = prefs.getLong(KEY_LAST_SCAN_GENERATION, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_SCAN_GENERATION, value).apply()
        }

    /** MediaStore version token of the last scan; a change means the media DB was rebuilt. */
    var mediaStoreVersion: String?
        get() = prefs.getString(KEY_MEDIA_STORE_VERSION, null)
        set(value) {
            prefs.edit().putString(KEY_MEDIA_STORE_VERSION, value).apply()
        }

    /** When the last FULL reconcile (deletion diff) completed. */
    var lastFullReconcileAtMs: Long
        get() = prefs.getLong(KEY_LAST_FULL_RECONCILE_AT, 0L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_FULL_RECONCILE_AT, value).apply()
        }

    /**
     * Durably force the next reconcile to run a full scan (e.g. after a folder-selection
     * change). Persisted marks survive WorkManager request replacement and process death,
     * unlike an input-data flag.
     */
    fun resetScanMarks() {
        prefs.edit()
            .putLong(KEY_LAST_SCAN_ADDED, 0L)
            .putLong(KEY_LAST_SCAN_GENERATION, 0L)
            .putLong(KEY_LAST_FULL_RECONCILE_AT, 0L)
            .apply()
    }

    /** Stable per-install device id sent as MediaItem provenance; created lazily. */
    val deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, null) ?: java.util.UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_DEVICE_ID, it).apply()
        }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_TARGET_CIRCLE = "target_circle_id"
        const val KEY_SELECTED_BUCKETS = "selected_bucket_ids"
        const val KEY_LAST_SCAN_ADDED = "last_scan_date_added_sec"
        const val KEY_LAST_SCAN_GENERATION = "last_scan_generation"
        const val KEY_MEDIA_STORE_VERSION = "media_store_version"
        const val KEY_LAST_FULL_RECONCILE_AT = "last_full_reconcile_at_ms"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_BACKUP_ENABLED = "backup_enabled"
        const val KEY_NOTIFY_REMINDERS = "notify_backup_reminders"
        const val KEY_NOTIFY_ISSUES = "notify_backup_issues"
        const val KEY_LAST_REMINDER_AT = "last_reminder_notified_at_ms"
        const val KEY_LAST_ISSUE_AT = "last_issue_notified_at_ms"
    }
}

/**
 * Whether backup should default to ON for an install that predates the backup toggle:
 * a configured target circle or a non-zero scan high-water mark proves the install was
 * already backing up. Pure function, extracted for unit testing.
 */
internal fun resolveInitialBackupEnabled(
    hasTargetCircle: Boolean,
    lastScanDateAddedSec: Long,
): Boolean = hasTargetCircle || lastScanDateAddedSec > 0
