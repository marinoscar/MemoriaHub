package memoriahub.marin.cr.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.SyncConfigView
import memoriahub.marin.cr.contract.SyncControl
import memoriahub.marin.cr.contract.SyncStatusView
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.SyncCommand
import memoriahub.marin.cr.pairing.ApiErrorReaction

/** A failed [SyncControl] call; [error] is the API error when the server answered. */
class SyncControlException(message: String, val error: ApiError? = null, val reaction: ApiErrorReaction = ApiErrorReaction.NONE) :
    Exception(message)

/**
 * The app's [SyncControl] (contract shared with #513/#514) and the #509 [SyncScheduling] seam,
 * over WorkManager ([MediaSyncScheduler] + [SyncWork]) and the check-in/outbox ([SyncCheckin]).
 *
 * Start/Stop (docs/specs/android-media-sync.md §10.4): a local toggle takes effect at once (the
 * outbox entry makes [effectivePaused] true, the sync work is cancelled and a running upload stops
 * at its next part boundary), then `POST /commands` tells the server so the web reflects it. Offline,
 * the command waits in the outbox and is replayed before the next check-in; the call still succeeds.
 * A command the server rejects returns a failure and is dropped from the outbox.
 */
class WorkManagerSyncControl(
    private val scheduler: MediaSyncScheduler,
    private val work: SyncWork,
    private val checkin: SyncCheckin,
    private val store: SyncStateStore,
    private val tracker: SyncStatusTracker,
    private val retryLocal: suspend () -> Unit,
    private val scope: CoroutineScope,
) : SyncControl, SyncScheduling by scheduler {

    override val status: StateFlow<SyncStatusView> get() = tracker.status

    override fun currentConfig(): SyncConfigView? =
        effectiveConfig(store)?.toView(store.configVersion, store.appliedConfigVersion)

    override fun syncNow() = scheduler.syncNow(SyncTrigger.MANUAL)

    override suspend fun setPaused(paused: Boolean): Result<Unit> {
        val command = if (paused) SyncCommand.PAUSE else SyncCommand.RESUME
        if (!checkin.enqueueCommand(command)) return Result.failure(SyncControlException("Not paired"))
        AppLog.i(TAG, "sync.control.${command.wire}")
        if (paused) scheduler.cancelAll() else scheduler.resumeWork(runNow = true)
        tracker.refresh()
        return result(checkin.flushOutbox(runNowOnResume = false))
    }

    override suspend fun retryFailed(): Result<Unit> {
        if (!checkin.enqueueCommand(SyncCommand.RETRY_FAILED)) return Result.failure(SyncControlException("Not paired"))
        retryLocal()
        val outcome = checkin.flushOutbox(runNowOnResume = false)
        scheduler.syncNow(SyncTrigger.MANUAL)
        return result(outcome)
    }

    override suspend fun updateConfig(patch: ConfigPatch): Result<Unit> {
        if (!checkin.enqueuePatch(patch.toStored())) return Result.failure(SyncControlException("Not paired"))
        // Constraints follow the (locally patched) config at once; the scope moves when the server confirms.
        scheduler.constraintsMaybeChanged()
        val outcome = checkin.flushOutbox(runNowOnResume = false)
        if (outcome is CheckinOutcome.Applied && outcome.apply.scope != null) scheduler.syncNow(SyncTrigger.MANUAL)
        return result(outcome)
    }

    override suspend fun checkinNow(): Result<Unit> {
        val outcome = checkin.checkin(run = null, runNowOnResume = true)
        if (outcome is CheckinOutcome.Applied && outcome.apply.syncNow) scheduler.syncNow(SyncTrigger.MANUAL)
        return result(outcome, offlineIsFailure = true)
    }

    override fun isPeriodicScheduled(): Boolean = work.isPeriodicScheduled()

    override fun isContentTriggerArmed(): Boolean = work.isContentTriggerArmed()

    override fun lastContentTriggerAtMs(): Long? = store.lastContentTriggerAtMs

    /**
     * The app was opened (TwaLauncherActivity, MediaSyncActivity): a debounced app-open sync, or,
     * while paused, a debounced check-in only, so a "Start" pressed on the web reaches the phone.
     */
    fun onAppOpen() {
        when (scheduler.onAppOpen()) {
            MediaSyncScheduler.AppOpenAction.CHECKIN_ONLY -> scope.launch {
                checkinNow().onFailure { AppLog.w(TAG, "sync.app_open.checkin_failed ${it.message}") }
            }
            else -> Unit
        }
    }

    private fun result(outcome: CheckinOutcome, offlineIsFailure: Boolean = false): Result<Unit> {
        tracker.refresh()
        return when (outcome) {
            is CheckinOutcome.Applied -> outcome.rejected
                ?.let { Result.failure(SyncControlException(it.message, it)) }
                ?: Result.success(Unit)
            CheckinOutcome.NotPaired -> Result.failure(SyncControlException("Not paired"))
            is CheckinOutcome.Failed -> when {
                outcome.reaction != ApiErrorReaction.NONE ->
                    Result.failure(SyncControlException(outcome.error.message, outcome.error, outcome.reaction))
                outcome.transient && !offlineIsFailure -> Result.success(Unit) // queued; replayed on the next check-in
                else -> Result.failure(SyncControlException(outcome.error.message, outcome.error))
            }
        }
    }

    private companion object {
        const val TAG = "Sync"
    }
}
