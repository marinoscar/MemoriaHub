package memoriahub.marin.cr.permissions

import memoriahub.marin.cr.testing.FakeSharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaPermissionPromptsTest {
    @Test fun `the first tap requests, a later permanent denial opens settings`() {
        val prompts = MediaPermissionPrompts(FakeSharedPreferences())
        assertFalse(prompts.askedBefore)
        assertEquals(MediaPermissionAction.REQUEST, prompts.nextAction(MediaPermissionState.DENIED, rationale = false))

        prompts.markAsked()
        assertTrue(prompts.askedBefore)
        assertEquals(MediaPermissionAction.REQUEST, prompts.nextAction(MediaPermissionState.DENIED, rationale = true))
        assertEquals(MediaPermissionAction.OPEN_SETTINGS, prompts.nextAction(MediaPermissionState.DENIED, rationale = false))
    }

    @Test fun `a grant forgets the flag so a later revoke requests in place again`() {
        val prefs = FakeSharedPreferences()
        val prompts = MediaPermissionPrompts(prefs)
        prompts.markAsked()

        prompts.observe(MediaPermissionState.DENIED)
        assertTrue("still denied: keep it", prompts.askedBefore)

        prompts.observe(MediaPermissionState.PARTIAL)
        assertFalse(prompts.askedBefore)

        prompts.markAsked()
        prompts.observe(MediaPermissionState.FULL)
        assertFalse(MediaPermissionPrompts(prefs).askedBefore)
        assertEquals(MediaPermissionAction.REQUEST, prompts.nextAction(MediaPermissionState.DENIED, rationale = false))
    }
}
