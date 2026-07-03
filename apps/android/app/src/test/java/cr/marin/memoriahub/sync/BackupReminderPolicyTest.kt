package cr.marin.memoriahub.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupReminderPolicyTest {

    private val now = 1_750_000_000_000L

    @Test
    fun `muted reminders never fire`() {
        assertFalse(
            BackupReminderPolicy.shouldRemind(
                remindersEnabled = false,
                lastRemindedAtMs = 0L,
                nowMs = now,
                gapCount = 42,
            ),
        )
    }

    @Test
    fun `no gap means no reminder`() {
        assertFalse(
            BackupReminderPolicy.shouldRemind(
                remindersEnabled = true,
                lastRemindedAtMs = 0L,
                nowMs = now,
                gapCount = 0,
            ),
        )
    }

    @Test
    fun `within cooldown does not re-remind`() {
        val lastReminded = now - BackupReminderPolicy.REMINDER_COOLDOWN_MS + 1
        assertFalse(
            BackupReminderPolicy.shouldRemind(
                remindersEnabled = true,
                lastRemindedAtMs = lastReminded,
                nowMs = now,
                gapCount = 5,
            ),
        )
    }

    @Test
    fun `exactly at cooldown boundary reminds`() {
        val lastReminded = now - BackupReminderPolicy.REMINDER_COOLDOWN_MS
        assertTrue(
            BackupReminderPolicy.shouldRemind(
                remindersEnabled = true,
                lastRemindedAtMs = lastReminded,
                nowMs = now,
                gapCount = 5,
            ),
        )
    }

    @Test
    fun `gap past cooldown reminds`() {
        assertTrue(
            BackupReminderPolicy.shouldRemind(
                remindersEnabled = true,
                lastRemindedAtMs = 0L,
                nowMs = now,
                gapCount = 1,
            ),
        )
    }
}
