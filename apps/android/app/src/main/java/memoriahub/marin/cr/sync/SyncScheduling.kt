package memoriahub.marin.cr.sync

/**
 * Why a sync run started; the wire values are the server's `MediaSyncTrigger`
 * (docs/specs/android-media-sync.md §4.1, check-in `run.trigger`).
 */
enum class SyncTrigger(val wire: String) {
    PERIODIC("periodic"),
    CONTENT_TRIGGER("content_trigger"),
    MANUAL("manual"),
    APP_OPEN("app_open"),
    INITIAL("initial"),
}

/**
 * The seam between pairing (#509) and background sync (#512). Pairing calls it; it never
 * implements WorkManager itself.
 *
 * - [ensurePeriodic]: (re-)assert the periodic work (KEEP); called after every successful registration.
 * - [syncNow]: enqueue one expedited run; pairing calls it with [SyncTrigger.INITIAL].
 * - [cancelAll]: cancel every queued/running sync work item; called on unpair and on `DEVICE_REVOKED`.
 *
 * #512 provides the WorkManager implementation (`MediaSyncScheduler`) and swaps it into
 * `MobileApplication.syncScheduling`; until then [NoopSyncScheduling] is used.
 */
interface SyncScheduling {
    fun ensurePeriodic()
    fun syncNow(trigger: SyncTrigger)
    fun cancelAll()
}

/** Placeholder until #512: pairing works, nothing is scheduled. */
object NoopSyncScheduling : SyncScheduling {
    override fun ensurePeriodic() = Unit
    override fun syncNow(trigger: SyncTrigger) = Unit
    override fun cancelAll() = Unit
}
