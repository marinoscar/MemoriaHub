package cr.marin.memoriahub.sync

/**
 * Decides whether a "backup issues" alert may be posted after a sync run that
 * failed items. Pure logic, extracted for unit testing.
 *
 * Alerts fire only when the user hasn't muted issue notifications, there are
 * failed/blocked items right now, and the last alert is at least
 * [ISSUE_COOLDOWN_MS] old — repeated failing runs (every ~15 min) must not nag.
 */
object IssueNotificationPolicy {

    /** Alert at most once a day. */
    const val ISSUE_COOLDOWN_MS: Long = 24L * 60 * 60 * 1000

    fun shouldNotify(
        issuesEnabled: Boolean,
        failureCount: Int,
        lastNotifiedAtMs: Long,
        nowMs: Long,
    ): Boolean =
        issuesEnabled &&
            failureCount > 0 &&
            nowMs - lastNotifiedAtMs >= ISSUE_COOLDOWN_MS
}
