package cr.marin.memoriahub.sync

/**
 * Decides whether a "backup is off" reminder may be posted. Pure logic, extracted
 * for unit testing.
 *
 * A reminder fires only when the user hasn't muted reminders, there is an actual
 * gap (items on the device that aren't backed up), and the last reminder is at
 * least [REMINDER_COOLDOWN_MS] old — nudge, don't nag.
 */
object BackupReminderPolicy {

    /** Remind at most once every 3 days. */
    const val REMINDER_COOLDOWN_MS: Long = 72L * 60 * 60 * 1000

    fun shouldRemind(
        remindersEnabled: Boolean,
        lastRemindedAtMs: Long,
        nowMs: Long,
        gapCount: Int,
    ): Boolean =
        remindersEnabled &&
            gapCount > 0 &&
            nowMs - lastRemindedAtMs >= REMINDER_COOLDOWN_MS
}
