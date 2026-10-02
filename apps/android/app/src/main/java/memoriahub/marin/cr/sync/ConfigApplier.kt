package memoriahub.marin.cr.sync

import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ledger.LedgerRepository
import memoriahub.marin.cr.ledger.ScopeChange
import memoriahub.marin.cr.ledger.SyncScope
import memoriahub.marin.cr.net.SyncCommand
import java.time.Instant

/** The ledger operations config application needs (a seam over [LedgerRepository]). */
interface ApplierLedger {
    suspend fun applyScope(scope: SyncScope): ScopeChange
    suspend fun retryFailed(): Int
    suspend fun retryBlocked(): Int
}

fun LedgerRepository.asApplierLedger(): ApplierLedger = object : ApplierLedger {
    override suspend fun applyScope(scope: SyncScope) = this@asApplierLedger.applyScope(scope)
    override suspend fun retryFailed() = this@asApplierLedger.retryFailed()
    override suspend fun retryBlocked() = this@asApplierLedger.retryBlocked()
}

/** What a config application does to WorkManager (implemented by [MediaSyncScheduler]). */
interface ConfigWorkHooks {
    /** Paused: cancel `media-sync-now`, `-trigger` and `-periodic` (a running upload stops between parts). */
    fun cancelSyncWork()

    /** Un-paused: re-arm periodic and trigger work and, when [runNow], run "now" ([SyncTrigger.MANUAL]). */
    fun resumeWork(runNow: Boolean)

    /** Re-enqueue the periodic work with `UPDATE` when the constraints hash changed (§10.1). */
    fun constraintsMaybeChanged()
}

/**
 * The deterministic decision of one config application (docs/specs/android-media-sync.md §5.3),
 * computed by [ConfigApplier.plan] before anything is written.
 */
data class ApplyPlan(
    val configVersion: Int,
    /** First application on this device (no cached config): scope re-evaluated, generations adopted. */
    val first: Boolean,
    val scopeChanged: Boolean,
    val constraintsChanged: Boolean,
    val paused: Boolean,
    val wasPaused: Boolean,
    /** `retryFailedGeneration` grew past the applied value: exactly one retry. */
    val retryFailed: Boolean,
    /** `syncNowGeneration` grew past the applied value: this run (or the next) is `manual`. */
    val syncNow: Boolean,
    val retryGeneration: Long,
    val syncNowGeneration: Long,
) {
    val resumed: Boolean get() = wasPaused && !paused
}

/** The outcome reported to the caller (the worker treats [syncNow] as a manual run). */
data class ApplyResult(
    val applied: Boolean,
    val paused: Boolean,
    val syncNow: Boolean = false,
    val retried: Boolean = false,
    val scope: ScopeChange? = null,
    val resumed: Boolean = false,
) {
    companion object {
        fun unchanged(paused: Boolean) = ApplyResult(applied = false, paused = paused)
    }
}

/**
 * Applies a desired config received from the server (check-in, `PATCH /config`, `/commands`),
 * §5.3:
 *
 * 1. Persist the config and `configVersion`.
 * 2. Re-evaluate every ledger row ([ApplierLedger.applyScope]) when the scope changed; abort the
 *    server sessions of rows that left the scope (best effort).
 * 3. `retryFailedGeneration` above the applied value: `retryFailed()` + `retryBlocked()`.
 * 4. `syncNowGeneration` above the applied value: report [ApplyResult.syncNow].
 * 5. Store the applied generations and `appliedConfigVersion`.
 * 6. Rebuild the WorkManager constraints; paused: cancel the sync work; resumed: re-arm it (and
 *    run now). Last, because cancelling may cancel the very worker applying the config.
 *
 * Each generation delta fires **exactly one** retry or sync. A command this phone sent itself
 * ([apply]'s `ownCommand`) already acted locally, so its generation is adopted without acting again.
 * The first application on a device adopts the generations too, so a re-paired phone does not
 * replay commands sent to it long ago.
 */
class ConfigApplier(
    private val store: SyncStateStore,
    private val ledger: ApplierLedger,
    private val work: ConfigWorkHooks,
    private val abortUpload: suspend (objectId: String) -> Unit,
    private val pairedAt: () -> Instant?,
) {
    /** Applies [config] at [configVersion] when it is newer than the applied one. */
    suspend fun apply(
        config: DeviceSyncConfig,
        configVersion: Int,
        ownCommand: SyncCommand? = null,
        inRun: Boolean = false,
    ): ApplyResult {
        val previous = store.config
        val plan = plan(
            previous = previous,
            appliedVersion = store.appliedConfigVersion,
            appliedRetry = store.appliedRetryGeneration,
            appliedSyncNow = store.appliedSyncNowGeneration,
            incoming = config,
            incomingVersion = configVersion,
            ownCommand = ownCommand,
        ) ?: return ApplyResult.unchanged(previous?.paused ?: config.paused)

        // 1. Persist.
        store.config = config
        store.configVersion = configVersion

        // 2. Scope.
        var scope: ScopeChange? = null
        if (plan.scopeChanged) {
            scope = ledger.applyScope(config.scope(pairedAt()))
            for (objectId in scope.abortedObjectIds) {
                try {
                    abortUpload(objectId)
                } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    AppLog.w(TAG, "config.abort.failed", e)
                }
            }
        }

        // 3. Retry (exactly once per delta).
        if (plan.retryFailed) {
            val failed = ledger.retryFailed()
            val blocked = ledger.retryBlocked()
            AppLog.i(TAG, "config.retry failed=$failed blocked=$blocked generation=${plan.retryGeneration}")
        }

        // 5. Applied markers (4 is reported to the caller). Written before touching WorkManager:
        // cancelling the sync work may cancel the worker that is applying this very config.
        store.appliedRetryGeneration = plan.retryGeneration
        store.appliedSyncNowGeneration = plan.syncNowGeneration
        store.appliedConfigVersion = configVersion

        // 6. Work. Inside a sync run ([inRun]) a resume only re-arms the schedule: the run
        // itself continues, and enqueueing "now" with REPLACE would cancel it.
        when {
            plan.paused -> work.cancelSyncWork()
            plan.resumed -> work.resumeWork(runNow = !inRun)
            plan.constraintsChanged -> work.constraintsMaybeChanged()
        }
        AppLog.i(
            TAG,
            "config.applied version=$configVersion paused=${plan.paused} scope=${plan.scopeChanged} " +
                "constraints=${plan.constraintsChanged} retry=${plan.retryFailed} syncNow=${plan.syncNow}",
        )
        return ApplyResult(
            applied = true, paused = plan.paused, syncNow = plan.syncNow, retried = plan.retryFailed, scope = scope,
            resumed = plan.resumed,
        )
    }

    companion object {
        private const val TAG = "Sync"

        /**
         * The pure decision. Null when [incomingVersion] is not newer than [appliedVersion] and a
         * config is already cached (nothing to apply).
         */
        fun plan(
            previous: DeviceSyncConfig?,
            appliedVersion: Int,
            appliedRetry: Long?,
            appliedSyncNow: Long?,
            incoming: DeviceSyncConfig,
            incomingVersion: Int,
            ownCommand: SyncCommand? = null,
        ): ApplyPlan? {
            val first = previous == null
            if (!first && incomingVersion <= appliedVersion) return null
            val retryBaseline = appliedRetry ?: incoming.retryFailedGeneration
            val syncBaseline = appliedSyncNow ?: incoming.syncNowGeneration
            val retry = incoming.retryFailedGeneration > retryBaseline && ownCommand != SyncCommand.RETRY_FAILED
            val syncNow = incoming.syncNowGeneration > syncBaseline && ownCommand != SyncCommand.SYNC_NOW
            return ApplyPlan(
                configVersion = incomingVersion,
                first = first,
                scopeChanged = first || previous!!.scopeDiffers(incoming),
                constraintsChanged = first || SyncConstraintSpec.of(previous) != SyncConstraintSpec.of(incoming),
                paused = incoming.paused,
                wasPaused = previous?.paused ?: false,
                retryFailed = retry,
                syncNow = syncNow,
                // Generations never move backwards locally (a stale response cannot replay a command).
                retryGeneration = maxOf(retryBaseline, incoming.retryFailedGeneration),
                syncNowGeneration = maxOf(syncBaseline, incoming.syncNowGeneration),
            )
        }
    }
}
