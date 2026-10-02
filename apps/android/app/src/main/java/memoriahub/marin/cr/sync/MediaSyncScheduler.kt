package memoriahub.marin.cr.sync

import memoriahub.marin.cr.diagnostics.AppLog
import java.time.Duration

/** WorkManager policy for the "now" work (§10.2). */
enum class NowPolicy { REPLACE, KEEP }

/**
 * The raw WorkManager operations, behind an interface so [MediaSyncScheduler]'s decisions (which
 * policy, which constraints, when to re-arm) are JVM-tested with a fake. [WorkManagerWork] is the
 * real implementation.
 */
interface SyncWork {
    /** `media-sync-now`: expedited when [constraints] allow it ([SyncConstraintSpec.expeditable]). */
    fun enqueueNow(trigger: SyncTrigger, policy: NowPolicy, constraints: SyncConstraintSpec)

    /** `media-sync-periodic`: every 6 h, flex 1 h, exponential 60 s backoff; `UPDATE` when [update], else `KEEP`. */
    fun enqueuePeriodic(constraints: SyncConstraintSpec, update: Boolean)

    /** `media-sync-trigger`: content-URI work on Images and Video (descendants), 15 s / 2 min delays. */
    fun armContentTrigger(replace: Boolean)

    /** Cancels `media-sync-now`, `media-sync-trigger` and `media-sync-periodic`. */
    fun cancelAll()

    fun isPeriodicScheduled(): Boolean

    fun isContentTriggerArmed(): Boolean
}

/**
 * The scheduling policy (docs/specs/android-media-sync.md §10.1, §10.2), implementing the #509
 * [SyncScheduling] seam and the [ConfigWorkHooks] the config applier drives:
 *
 * | Work | Policy |
 * |---|---|
 * | periodic | `UPDATE` when the stored constraints hash differs from the current config's, else `KEEP` |
 * | trigger | `KEEP` when re-asserted (app start, pairing), `REPLACE` when the trigger worker re-arms itself |
 * | now | `REPLACE` for manual, initial and remote commands; `KEEP` for app-open and content triggers |
 *
 * Nothing is scheduled while unpaired or paused; [syncNow] while paused is dropped (a paused
 * phone only checks in, see [MediaSyncControl.checkinNow]).
 */
class MediaSyncScheduler(
    private val work: SyncWork,
    private val store: SyncStateStore,
    private val isPaired: () -> Boolean,
    private val isPaused: () -> Boolean = { effectivePaused(store) },
    private val clock: () -> Long = System::currentTimeMillis,
) : SyncScheduling, ConfigWorkHooks {

    /** Constraints for the current (possibly locally patched) config. */
    fun constraints(): SyncConstraintSpec = SyncConstraintSpec.of(effectiveConfig(store))

    override fun ensurePeriodic() {
        if (!isPaired() || isPaused()) return
        assertPeriodic()
        work.armContentTrigger(replace = false)
    }

    override fun syncNow(trigger: SyncTrigger) {
        if (!isPaired()) return
        if (isPaused()) {
            AppLog.i(TAG, "sync.now.skipped reason=paused trigger=${trigger.wire}")
            return
        }
        work.enqueueNow(trigger, policyFor(trigger), constraints())
    }

    override fun cancelAll() {
        work.cancelAll()
        store.constraintsHash = null
    }

    override fun cancelSyncWork() = cancelAll()

    override fun resumeWork(runNow: Boolean) {
        if (!isPaired()) return
        assertPeriodic()
        work.armContentTrigger(replace = false)
        if (runNow) work.enqueueNow(SyncTrigger.MANUAL, NowPolicy.REPLACE, constraints())
    }

    override fun constraintsMaybeChanged() {
        if (!isPaired() || isPaused()) return
        assertPeriodic()
    }

    /** The content-trigger worker fired: run now (KEEP) and re-arm itself (content-URI work is one-shot). */
    fun onContentTriggered() {
        store.lastContentTriggerAtMs = clock()
        if (!isPaired() || isPaused()) return
        work.enqueueNow(SyncTrigger.CONTENT_TRIGGER, NowPolicy.KEEP, constraints())
        work.armContentTrigger(replace = true)
    }

    /**
     * The app was opened (§10.2): keeps the schedule in place and, at most every 15 minutes,
     * starts an app-open sync. Returns what it did, for logging and tests.
     */
    fun onAppOpen(): AppOpenAction {
        if (!isPaired()) return AppOpenAction.NONE
        val now = clock()
        if (!appOpenDue(store.lastAppOpenAtMs, now)) return AppOpenAction.DEBOUNCED
        store.lastAppOpenAtMs = now
        if (isPaused()) return AppOpenAction.CHECKIN_ONLY
        ensurePeriodic()
        work.enqueueNow(SyncTrigger.APP_OPEN, NowPolicy.KEEP, constraints())
        return AppOpenAction.SYNC
    }

    private fun assertPeriodic() {
        val spec = constraints()
        val changed = store.constraintsHash != spec.hash
        work.enqueuePeriodic(spec, update = changed)
        if (changed) store.constraintsHash = spec.hash
    }

    enum class AppOpenAction { NONE, DEBOUNCED, CHECKIN_ONLY, SYNC }

    companion object {
        private const val TAG = "Sync"

        const val PERIODIC_WORK = "media-sync-periodic"
        const val TRIGGER_WORK = "media-sync-trigger"
        const val NOW_WORK = "media-sync-now"
        const val TAG_ALL = "media-sync"

        val PERIODIC_INTERVAL: Duration = Duration.ofHours(6)
        val PERIODIC_FLEX: Duration = Duration.ofHours(1)
        val BACKOFF: Duration = Duration.ofSeconds(60)
        val TRIGGER_UPDATE_DELAY: Duration = Duration.ofSeconds(15)
        val TRIGGER_MAX_DELAY: Duration = Duration.ofMinutes(2)

        /** App-open syncs run at most this often. */
        val APP_OPEN_DEBOUNCE: Duration = Duration.ofMinutes(15)

        fun policyFor(trigger: SyncTrigger): NowPolicy = when (trigger) {
            SyncTrigger.APP_OPEN, SyncTrigger.CONTENT_TRIGGER, SyncTrigger.PERIODIC -> NowPolicy.KEEP
            SyncTrigger.MANUAL, SyncTrigger.INITIAL -> NowPolicy.REPLACE
        }

        /** Due when never ran, the last one is older than [debounce], or the clock went backwards. */
        fun appOpenDue(lastMs: Long?, nowMs: Long, debounce: Duration = APP_OPEN_DEBOUNCE): Boolean =
            lastMs == null || nowMs - lastMs >= debounce.toMillis() || nowMs < lastMs
    }
}

/**
 * The paused state the phone acts on: a pending `pause`/`resume` in the outbox (a local toggle not
 * yet acknowledged by the server) wins over the cached server config.
 */
fun effectivePaused(store: SyncStateStore): Boolean {
    val pending = store.outbox.lastOrNull { it.command == "pause" || it.command == "resume" }
    return pending?.let { it.command == "pause" } ?: (store.config?.paused ?: false)
}

/** The cached config with pending local patches (outbox) applied on top, or null before the first check-in. */
fun effectiveConfig(store: SyncStateStore): DeviceSyncConfig? {
    var config = store.config ?: return null
    for (entry in store.outbox) {
        entry.patch?.let { config = config.withPatch(it.toConfigPatch()) }
    }
    return config.copy(paused = effectivePaused(store))
}
