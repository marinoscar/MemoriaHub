package memoriahub.marin.cr.deeplink

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaSyncLinksTest {
    @Test fun `the hub link has no path`() = assertEquals("memoriahub://media-sync", MediaSyncLinks.uri())

    @Test fun `every screen is addressable (decision D13)`() {
        assertEquals(
            listOf(
                "memoriahub://media-sync",
                "memoriahub://media-sync/connect",
                "memoriahub://media-sync/paired",
                "memoriahub://media-sync/folders",
                "memoriahub://media-sync/network",
                "memoriahub://media-sync/files",
                "memoriahub://media-sync/diagnostics",
            ),
            MediaSyncPath.entries.map { MediaSyncLinks.uri(it) },
        )
    }

    @Test fun `actions are appended as a query parameter`() {
        assertEquals("memoriahub://media-sync?action=sync", MediaSyncLinks.uri(action = MediaSyncAction.SYNC))
        assertEquals(
            "memoriahub://media-sync/files?action=retry",
            MediaSyncLinks.uri(MediaSyncPath.FILES, MediaSyncAction.RETRY),
        )
        assertEquals(listOf("apply", "sync", "retry", "pause", "resume"), MediaSyncAction.entries.map { it.value })
    }

    @Test fun `the device flow return uri is the paired path`() =
        assertEquals("memoriahub://media-sync/paired", MediaSyncLinks.pairedReturnUri)
}
