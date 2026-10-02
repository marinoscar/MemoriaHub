package memoriahub.marin.cr.sync

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.ConfigEnvelope
import memoriahub.marin.cr.net.ConfigPatchRequest
import memoriahub.marin.cr.net.FolderRef
import memoriahub.marin.cr.net.MediaSyncCheckinApi
import memoriahub.marin.cr.net.SyncCommand
import memoriahub.marin.cr.pairing.ApiErrorReaction

/** Reads what the phone reports at check-in (ledger stats, permission, network, battery, folders). */
interface DeviceStateReader {
    suspend fun snapshot(): DeviceSnapshot

    /** The folder inventory alone (sent with a folder-selection PATCH so new folders validate). */
    fun inventory(): List<Bucket>
}

/** Outcome of [SyncCheckin.checkin] / [SyncCheckin.flushOutbox]. */
sealed interface CheckinOutcome {
    /**
     * The server answered; [apply] says what the returned config changed (possibly nothing).
     * [rejected] is the last outbox edit the server refused (dropped from the outbox), if any.
     */
    data class Applied(val apply: ApplyResult, val rejected: ApiError? = null) : CheckinOutcome

    /** No paired device id: nothing was sent. */
    data object NotPaired : CheckinOutcome

    /**
     * The call failed. [reaction] is the global 401 / `DEVICE_REVOKED` reaction (stop the run when
     * not [ApiErrorReaction.NONE]); [transient] means "offline or server trouble, try later".
     */
    data class Failed(val error: ApiError, val reaction: ApiErrorReaction, val transient: Boolean) : CheckinOutcome
}

/**
 * Check-in, the local outbox and config edits for this phone's device row
 * (docs/specs/android-media-sync.md §5.2, §6.4, D7). One [Mutex] serializes them, so a worker's
 * check-in and a UI toggle never interleave their store writes.
 *
 * - **Outbox.** Local edits (commands and config patches) are queued, then replayed in order
 *   through `POST /commands` / `PATCH /config` **before** every check-in; never carried in the
 *   check-in body. Offline or a 5xx keeps the rest of the queue; any other 4xx drops that entry
 *   (logged): the server rejected it and retrying cannot help.
 * - **Apply.** Every response's `{ config, configVersion }` goes through [ConfigApplier]; a command
 *   the phone sent itself is passed as `ownCommand` so its generation is adopted, not re-acted on.
 * - **Auth.** Every failure goes through [reactions] (401 → pairing expired, 409 `DEVICE_REVOKED`
 *   → forget pairing and cancel work) before anything else.
 */
class SyncCheckin(
    private val api: MediaSyncCheckinApi,
    private val store: SyncStateStore,
    private val applier: ConfigApplier,
    private val reactions: (ApiError) -> ApiErrorReaction,
    private val device: DeviceStateReader,
    private val deviceId: () -> String?,
    private val appVersion: String?,
    private val appVersionCode: Int?,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    /**
     * Queues a command in the outbox without sending it. Callers apply the local effect (cancel or
     * re-arm work, which reads the outbox through [effectivePaused]) and then [flushOutbox].
     */
    suspend fun enqueueCommand(command: SyncCommand): Boolean = mutex.withLock {
        bind() ?: return@withLock false
        store.outbox = OutboxQueue.withCommand(store.outbox, command)
        true
    }

    /** Queues a config patch in the outbox without sending it (see [enqueueCommand]). */
    suspend fun enqueuePatch(patch: StoredPatch): Boolean = mutex.withLock {
        bind() ?: return@withLock false
        store.outbox = store.outbox + OutboxEntry(patch = patch)
        true
    }

    /** Replays pending local edits only. */
    suspend fun flushOutbox(runNowOnResume: Boolean = false): CheckinOutcome = mutex.withLock {
        val id = bind() ?: return@withLock CheckinOutcome.NotPaired
        flushLocked(id, runNowOnResume)
    }

    /**
     * Replays the outbox, then `POST /devices/:id/checkin` with the current snapshot (inventory
     * when changed or every 24 h) and [run] when one just finished, then applies the returned
     * config. [runNowOnResume] is false inside a sync run (the run itself continues).
     */
    suspend fun checkin(run: SyncRunRecord? = null, runNowOnResume: Boolean = false): CheckinOutcome = mutex.withLock {
        val id = bind() ?: return@withLock CheckinOutcome.NotPaired
        val flushed = flushLocked(id, runNowOnResume)
        if (flushed is CheckinOutcome.Failed && (flushed.transient || flushed.reaction != ApiErrorReaction.NONE)) {
            return@withLock flushed
        }
        val snapshot = device.snapshot()
        val now = clock()
        val hash = CheckinPayload.inventoryHash(snapshot.inventory)
        val sendInventory = CheckinPayload.shouldSendInventory(hash, store.inventoryHash, store.inventorySentAtMs, now)
        val request = CheckinPayload.build(
            appliedConfigVersion = store.appliedConfigVersion,
            snapshot = snapshot,
            includeInventory = sendInventory,
            appVersion = appVersion,
            appVersionCode = appVersionCode,
            run = run,
        )
        when (val result = api.checkin(id, request)) {
            is ApiResult.Success -> {
                store.lastCheckinAtMs = now
                if (sendInventory) {
                    store.inventoryHash = hash
                    store.inventorySentAtMs = now
                }
                val applied = apply(result.value, ownCommand = null, runNowOnResume = runNowOnResume)
                AppLog.i(
                    TAG,
                    "sync.checkin ok version=${result.value.configVersion} applied=${store.appliedConfigVersion} " +
                        "inventory=$sendInventory run=${run?.status ?: "none"}",
                )
                val flushedApplied = flushed as? CheckinOutcome.Applied
                CheckinOutcome.Applied(merge(flushedApplied?.apply, applied), flushedApplied?.rejected)
            }
            is ApiResult.Failure -> failure(result.error, "checkin")
        }
    }

    private suspend fun flushLocked(id: String, runNowOnResume: Boolean): CheckinOutcome {
        var merged: ApplyResult? = null
        var rejected: ApiError? = null
        while (true) {
            val entry = store.outbox.firstOrNull() ?: break
            val command = entry.command?.let(SyncCommand::fromWire)
            val result: ApiResult<ConfigEnvelope> = when {
                command != null -> api.command(id, command)
                entry.patch != null -> api.patchConfig(id, patchRequest(entry.patch))
                else -> {
                    store.outbox = store.outbox.drop(1)
                    continue
                }
            }
            when (result) {
                is ApiResult.Success -> {
                    store.outbox = store.outbox.drop(1)
                    merged = merge(merged, apply(result.value, command, runNowOnResume))
                }
                is ApiResult.Failure -> {
                    val failed = failure(result.error, "outbox")
                    if (failed.transient || failed.reaction != ApiErrorReaction.NONE) return failed
                    // The server rejected this edit; it can never succeed. Drop it and keep going.
                    AppLog.w(TAG, "sync.outbox.rejected status=${result.error.httpStatus} reason=${result.error.reason}")
                    store.outbox = store.outbox.drop(1)
                    rejected = result.error
                }
            }
        }
        return CheckinOutcome.Applied(merged ?: ApplyResult.unchanged(store.config?.paused ?: false), rejected)
    }

    private suspend fun apply(envelope: ConfigEnvelope, ownCommand: SyncCommand?, runNowOnResume: Boolean): ApplyResult {
        val config = DeviceSyncConfig.fromJson(envelope.config)
        if (config == null) {
            AppLog.w(TAG, "sync.config.unreadable version=${envelope.configVersion}")
            return ApplyResult.unchanged(store.config?.paused ?: false)
        }
        return applier.apply(config, envelope.configVersion, ownCommand, inRun = !runNowOnResume)
    }

    private fun failure(error: ApiError, step: String): CheckinOutcome.Failed {
        val reaction = reactions(error)
        val transient = isTransient(error)
        AppLog.w(TAG, "sync.$step.failed kind=${error.kind} status=${error.httpStatus} reason=${error.reason} reaction=$reaction")
        return CheckinOutcome.Failed(error, reaction, transient)
    }

    /**
     * A folder selection also carries the current inventory (PAT callers only, §6.3) so a folder
     * created since the last check-in validates instead of failing with `UNKNOWN_FOLDER`. The
     * server overwrites folder names from the inventory; the names sent here are best effort.
     */
    private fun patchRequest(patch: StoredPatch): ConfigPatchRequest {
        val inventory = if (patch.folderIds != null) {
            CheckinPayload.sanitizeInventory(runCatching { device.inventory() }.getOrDefault(emptyList()))
        } else {
            emptyList()
        }
        val names = HashMap<String, String>()
        store.config?.folders?.forEach { names[it.bucketId] = it.name }
        inventory.forEach { names[it.bucketId] = it.name }
        return ConfigPatchRequest(
            folders = patch.folderIds?.distinct()?.map { FolderRef(it, (names[it] ?: it).ifBlank { it }.take(CheckinPayload.MAX_NAME)) },
            inventory = inventory.ifEmpty { null },
            includePhotos = patch.includePhotos,
            includeVideos = patch.includeVideos,
            network = patch.network,
            requireCharging = patch.requireCharging,
            uploadExisting = patch.uploadExisting,
        )
    }

    /** Binds the store to the paired device (a re-pair as a new device starts from scratch). */
    private fun bind(): String? {
        val id = deviceId() ?: return null
        store.bindTo(id)
        return id
    }

    companion object {
        private const val TAG = "Sync"

        /** Offline, unconfigured, 429 or 5xx: try again later; anything else is a definite answer. */
        fun isTransient(error: ApiError): Boolean = when (error.kind) {
            ApiError.Kind.NETWORK, ApiError.Kind.NOT_CONFIGURED -> true
            ApiError.Kind.HTTP -> (error.httpStatus ?: 0).let { it == 429 || it >= 500 }
            ApiError.Kind.PARSE -> false
        }

        fun merge(a: ApplyResult?, b: ApplyResult): ApplyResult = if (a == null) b else ApplyResult(
            applied = a.applied || b.applied,
            paused = b.paused,
            syncNow = a.syncNow || b.syncNow,
            retried = a.retried || b.retried,
            scope = b.scope ?: a.scope,
            resumed = a.resumed || b.resumed,
        )
    }
}

/** Outbox rules (pure). */
object OutboxQueue {
    /**
     * Adds [command]. A new `pause`/`resume` replaces any not-yet-sent `pause`/`resume` (the newest
     * local toggle wins, and an offline pause-then-resume never replays as two commands).
     */
    fun withCommand(outbox: List<OutboxEntry>, command: SyncCommand): List<OutboxEntry> {
        val toggles = setOf(SyncCommand.PAUSE.wire, SyncCommand.RESUME.wire)
        val kept = if (command.wire in toggles) outbox.filterNot { it.command in toggles } else outbox
        return kept + OutboxEntry(command = command.wire)
    }
}
