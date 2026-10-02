package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.deeplink.MediaSyncAction
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.deeplink.MediaSyncPath
import memoriahub.marin.cr.testing.RecordingSyncControl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaSyncActionsTest {
    @Test fun `apply checks in and reports settings applied`() = runTest {
        val control = RecordingSyncControl()
        val outcome = MediaSyncActions.run(MediaSyncAction.APPLY, paired = true, control = control)
        assertEquals(listOf("checkinNow"), control.calls)
        assertEquals("Settings applied", outcome.message)
        assertTrue(outcome.ok)
    }

    @Test fun `sync runs sync now`() = runTest {
        val control = RecordingSyncControl()
        MediaSyncActions.run(MediaSyncAction.SYNC, paired = true, control = control)
        assertEquals(listOf("syncNow"), control.calls)
    }

    @Test fun `retry retries failed then syncs`() = runTest {
        val control = RecordingSyncControl()
        MediaSyncActions.run(MediaSyncAction.RETRY, paired = true, control = control)
        assertEquals(listOf("retryFailed", "syncNow"), control.calls)
    }

    @Test fun `pause and resume set the paused flag`() = runTest {
        val control = RecordingSyncControl()
        assertEquals("Sync paused", MediaSyncActions.run(MediaSyncAction.PAUSE, paired = true, control = control).message)
        assertEquals("Sync resumed", MediaSyncActions.run(MediaSyncAction.RESUME, paired = true, control = control).message)
        assertEquals(listOf("setPaused(true)", "setPaused(false)"), control.calls)
    }

    @Test fun `failures report the reason and do not sync`() = runTest {
        val control = RecordingSyncControl().apply { result = Result.failure(IllegalStateException("offline")) }
        val outcome = MediaSyncActions.run(MediaSyncAction.RETRY, paired = true, control = control)
        assertFalse(outcome.ok)
        assertEquals("Could not retry the failed files: offline", outcome.message)
        assertEquals(listOf("retryFailed"), control.calls)
        assertEquals("Could not apply the settings: offline", MediaSyncActions.run(MediaSyncAction.APPLY, true, control).message)
    }

    @Test fun `nothing runs when the phone is not paired`() = runTest {
        val control = RecordingSyncControl()
        for (action in MediaSyncAction.entries) {
            val outcome = MediaSyncActions.run(action, paired = false, control = control)
            assertFalse(outcome.ok)
            assertEquals("Pair this phone first.", outcome.message)
        }
        assertTrue(control.calls.isEmpty())
    }

    @Test fun `every deep-link path opens its screen`() {
        val expected = mapOf(
            "memoriahub://media-sync" to MediaSyncScreen.Hub,
            "memoriahub://media-sync/" to MediaSyncScreen.Hub,
            "memoriahub://media-sync/connect" to MediaSyncScreen.Connect,
            "memoriahub://media-sync/paired" to MediaSyncScreen.Hub,
            "memoriahub://media-sync/folders" to MediaSyncScreen.Folders,
            "memoriahub://media-sync/network" to MediaSyncScreen.Network,
            "memoriahub://media-sync/files" to MediaSyncScreen.Files,
            "memoriahub://media-sync/diagnostics" to MediaSyncScreen.Diagnostics,
            "memoriahub://media-sync/unknown" to MediaSyncScreen.Hub,
            "https://evil.example.com/media-sync/files" to MediaSyncScreen.Hub,
        )
        for ((uri, screen) in expected) {
            val target = MediaSyncActions.target(MediaSyncLinks.route(uri, null, scheme = "memoriahub"))
            assertEquals(uri, screen, target.screen)
            assertNull(uri, target.action)
        }
        assertTrue(MediaSyncActions.target(MediaSyncLinks.route("memoriahub://media-sync/paired", null, "memoriahub")).pokePairing)
        assertFalse(MediaSyncActions.target(MediaSyncLinks.route("memoriahub://media-sync", null, "memoriahub")).pokePairing)
    }

    @Test fun `every action is parsed alongside a path`() {
        for (action in MediaSyncAction.entries) {
            val uri = MediaSyncLinks.uri(MediaSyncPath.FILES, action, scheme = "memoriahub")
            val target = MediaSyncActions.target(MediaSyncLinks.route(uri, null, "memoriahub"))
            assertEquals(MediaSyncScreen.Files, target.screen)
            assertEquals(action, target.action)
        }
        val unknown = MediaSyncActions.target(MediaSyncLinks.route("memoriahub://media-sync?action=explode", null, "memoriahub"))
        assertNull(unknown.action)
    }

    @Test fun `EXTRA_OPEN from a notification wins over the uri path`() {
        val target = MediaSyncActions.target(MediaSyncLinks.route("memoriahub://media-sync?action=sync", "connect", "memoriahub"))
        assertEquals(MediaSyncScreen.Connect, target.screen)
        assertEquals(MediaSyncAction.SYNC, target.action)
        assertEquals(MediaSyncScreen.Diagnostics, MediaSyncActions.target(MediaSyncLinks.route(null, "diagnostics", "memoriahub")).screen)
    }

    @Test fun `saved screen names restore, unknown falls back to hub`() {
        assertEquals(MediaSyncScreen.Files, MediaSyncScreen.named("Files"))
        assertEquals(MediaSyncScreen.Hub, MediaSyncScreen.named(null))
        assertEquals(MediaSyncScreen.Hub, MediaSyncScreen.named("Nope"))
    }
}
