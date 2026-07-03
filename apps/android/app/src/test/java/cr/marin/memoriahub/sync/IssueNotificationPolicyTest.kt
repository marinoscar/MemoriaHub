package cr.marin.memoriahub.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IssueNotificationPolicyTest {

    private val now = 1_750_000_000_000L

    @Test
    fun `muted issue alerts never fire`() {
        assertFalse(
            IssueNotificationPolicy.shouldNotify(
                issuesEnabled = false,
                failureCount = 7,
                lastNotifiedAtMs = 0L,
                nowMs = now,
            ),
        )
    }

    @Test
    fun `zero failures never notifies`() {
        assertFalse(
            IssueNotificationPolicy.shouldNotify(
                issuesEnabled = true,
                failureCount = 0,
                lastNotifiedAtMs = 0L,
                nowMs = now,
            ),
        )
    }

    @Test
    fun `within cooldown does not re-notify`() {
        val lastNotified = now - IssueNotificationPolicy.ISSUE_COOLDOWN_MS + 1
        assertFalse(
            IssueNotificationPolicy.shouldNotify(
                issuesEnabled = true,
                failureCount = 3,
                lastNotifiedAtMs = lastNotified,
                nowMs = now,
            ),
        )
    }

    @Test
    fun `exactly at cooldown boundary notifies`() {
        val lastNotified = now - IssueNotificationPolicy.ISSUE_COOLDOWN_MS
        assertTrue(
            IssueNotificationPolicy.shouldNotify(
                issuesEnabled = true,
                failureCount = 3,
                lastNotifiedAtMs = lastNotified,
                nowMs = now,
            ),
        )
    }

    @Test
    fun `failures past cooldown notify`() {
        assertTrue(
            IssueNotificationPolicy.shouldNotify(
                issuesEnabled = true,
                failureCount = 1,
                lastNotifiedAtMs = 0L,
                nowMs = now,
            ),
        )
    }
}
