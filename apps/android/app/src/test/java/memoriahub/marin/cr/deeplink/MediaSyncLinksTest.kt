package memoriahub.marin.cr.deeplink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test fun `parses every path and action`() {
        for (path in MediaSyncPath.entries) {
            for (action in listOf<MediaSyncAction?>(null) + MediaSyncAction.entries) {
                assertEquals(MediaSyncRoute(path, action), MediaSyncLinks.parse(MediaSyncLinks.uri(path, action)))
            }
        }
    }

    @Test fun `the device-flow return is a pairing return`() {
        val route = MediaSyncLinks.parse("memoriahub://media-sync/paired")!!
        assertEquals(MediaSyncPath.PAIRED, route.path)
        assertTrue(route.isPairingReturn)
        assertFalse(MediaSyncLinks.parse("memoriahub://media-sync/connect")!!.isPairingReturn)
    }

    @Test fun `tolerates a trailing slash, case and unknown parts`() {
        assertEquals(MediaSyncRoute(MediaSyncPath.HUB), MediaSyncLinks.parse("memoriahub://media-sync/"))
        assertEquals(MediaSyncRoute(MediaSyncPath.PAIRED), MediaSyncLinks.parse("MemoriaHub://Media-Sync/Paired/"))
        assertEquals(MediaSyncRoute(MediaSyncPath.HUB), MediaSyncLinks.parse("memoriahub://media-sync/nope"))
        assertEquals(MediaSyncRoute(MediaSyncPath.FILES), MediaSyncLinks.parse("memoriahub://media-sync/files?action=explode&x=1"))
        assertEquals(
            MediaSyncRoute(MediaSyncPath.HUB, MediaSyncAction.SYNC),
            MediaSyncLinks.parse("memoriahub://media-sync?x=1&action=sync"),
        )
    }

    @Test fun `other schemes and hosts are not ours`() {
        assertNull(MediaSyncLinks.parse("https://media-sync/paired"))
        assertNull(MediaSyncLinks.parse("memoriahub://elsewhere/paired"))
        assertNull(MediaSyncLinks.parse(null))
        assertNull(MediaSyncLinks.parse("::not a uri::"))
    }

    @Test fun `EXTRA_OPEN wins over the data path and the action comes from the URI`() {
        assertEquals(MediaSyncRoute(MediaSyncPath.CONNECT), MediaSyncLinks.route("memoriahub://media-sync", "connect"))
        assertEquals(
            MediaSyncRoute(MediaSyncPath.DIAGNOSTICS, MediaSyncAction.RETRY),
            MediaSyncLinks.route("memoriahub://media-sync/files?action=retry", "diagnostics"),
        )
        assertEquals(MediaSyncRoute(MediaSyncPath.HUB), MediaSyncLinks.route(null, "hub"))
        assertEquals(MediaSyncRoute(MediaSyncPath.FILES), MediaSyncLinks.route("memoriahub://media-sync/files", "bogus"))
        assertEquals(MediaSyncRoute(MediaSyncPath.HUB), MediaSyncLinks.route(null, null))
        assertEquals("paired is never an EXTRA_OPEN target", MediaSyncRoute(MediaSyncPath.HUB), MediaSyncLinks.route(null, "paired"))
    }
}
