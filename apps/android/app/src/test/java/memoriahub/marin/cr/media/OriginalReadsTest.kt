package memoriahub.marin.cr.media

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class OriginalReadsTest {
    /** Splits a content URI the way `android.net.Uri` does (authority + non-empty path segments). */
    private fun wants(uri: String, sdkInt: Int = 34, granted: Boolean = true): Boolean {
        val parsed = URI(uri)
        val segments = parsed.path.split('/').filter { it.isNotEmpty() }
        return OriginalReads.wantsOriginal(sdkInt, parsed.authority, segments, granted)
    }

    @Test fun `photo URIs from the scan want the original`() {
        assertTrue(wants("content://media/external_primary/images/media/42"))
        assertTrue(wants("content://media/external/images/media/42"))
        assertTrue("an SD card volume", wants("content://media/1234-abcd/images/media/7"))
    }

    @Test fun `video URIs from the scan want the original too (issue 545)`() {
        assertTrue(wants("content://media/external_primary/video/media/42"))
        assertTrue(wants("content://media/external/video/media/42"))
        assertTrue("an SD card volume", wants("content://media/1234-abcd/video/media/7"))
    }

    @Test fun `no location permission reads the plain URI`() {
        assertFalse(wants("content://media/external_primary/images/media/42", granted = false))
        assertFalse(wants("content://media/external_primary/video/media/42", granted = false))
    }

    @Test fun `below Android 10 nothing is redacted, so the plain URI is read`() {
        assertFalse(wants("content://media/external/images/media/42", sdkInt = 28))
        assertFalse(wants("content://media/external/video/media/42", sdkInt = 28))
        assertTrue(wants("content://media/external/video/media/42", sdkInt = 29))
    }

    @Test fun `other collections and other providers read the plain URI`() {
        assertFalse("audio", wants("content://media/external_primary/audio/media/42"))
        assertFalse("files", wants("content://media/external_primary/file/42"))
        assertFalse("downloads", wants("content://media/external_primary/downloads/42"))
        assertFalse("another provider", wants("content://com.android.providers.downloads.documents/video/media/42"))
        assertFalse("a volume named like a collection", wants("content://media/video/file/42"))
        assertFalse("no path", wants("content://media"))
    }
}
