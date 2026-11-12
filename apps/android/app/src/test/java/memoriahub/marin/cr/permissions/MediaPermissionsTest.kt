package memoriahub.marin.cr.permissions

import memoriahub.marin.cr.permissions.MediaPermissions.ACCESS_MEDIA_LOCATION
import memoriahub.marin.cr.permissions.MediaPermissions.READ_EXTERNAL_STORAGE
import memoriahub.marin.cr.permissions.MediaPermissions.READ_MEDIA_IMAGES
import memoriahub.marin.cr.permissions.MediaPermissions.READ_MEDIA_VIDEO
import memoriahub.marin.cr.permissions.MediaPermissions.READ_MEDIA_VISUAL_USER_SELECTED
import org.junit.Assert.assertEquals
import org.junit.Test

class MediaPermissionsTest {
    private fun state(sdk: Int, vararg granted: String) = MediaPermissions.state(sdk) { it in granted }

    @Test fun `request set per Android version`() {
        assertEquals(listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_MEDIA_VISUAL_USER_SELECTED, ACCESS_MEDIA_LOCATION), MediaPermissions.requestSet(34))
        assertEquals(listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, ACCESS_MEDIA_LOCATION), MediaPermissions.requestSet(33))
        assertEquals(listOf(READ_EXTERNAL_STORAGE, ACCESS_MEDIA_LOCATION), MediaPermissions.requestSet(29))
        assertEquals(listOf(READ_EXTERNAL_STORAGE), MediaPermissions.requestSet(28))
    }

    @Test fun `Android 14+`() {
        assertEquals(MediaPermissionState.FULL, state(34, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO))
        assertEquals(MediaPermissionState.PARTIAL, state(34, READ_MEDIA_VISUAL_USER_SELECTED))
        assertEquals(MediaPermissionState.PARTIAL, state(34, READ_MEDIA_IMAGES))
        assertEquals(MediaPermissionState.DENIED, state(34))
    }

    @Test fun `Android 13`() {
        assertEquals(MediaPermissionState.FULL, state(33, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO))
        assertEquals(MediaPermissionState.PARTIAL, state(33, READ_MEDIA_VIDEO))
        assertEquals("user-selected does not exist on 13", MediaPermissionState.DENIED, state(33, READ_MEDIA_VISUAL_USER_SELECTED))
    }

    @Test fun `Android 12 and below`() {
        assertEquals(MediaPermissionState.FULL, state(32, READ_EXTERNAL_STORAGE))
        assertEquals(MediaPermissionState.DENIED, state(26))
    }

    @Test fun `wire values match the check-in enum`() {
        assertEquals(listOf("full", "partial", "denied"), MediaPermissionState.entries.map { it.wire })
    }

    @Test fun `rationale is judged on the visual permissions only`() {
        assertEquals(listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO), MediaPermissions.rationaleSet(34))
        assertEquals(listOf(READ_MEDIA_IMAGES, READ_MEDIA_VIDEO), MediaPermissions.rationaleSet(33))
        assertEquals(listOf(READ_EXTERNAL_STORAGE), MediaPermissions.rationaleSet(32))
    }

    @Test fun `next action requests in place until Android stops showing the dialog`() {
        val full = MediaPermissionState.FULL
        val partial = MediaPermissionState.PARTIAL
        val denied = MediaPermissionState.DENIED
        // Full access: nothing to do, whatever the flags say.
        assertEquals(MediaPermissionAction.NONE, MediaPermissions.nextAction(full, askedBefore = true, rationale = false))
        // Never asked: rationale is false too, but the dialog will show.
        assertEquals(MediaPermissionAction.REQUEST, MediaPermissions.nextAction(denied, askedBefore = false, rationale = false))
        // Denied once: Android wants a rationale and still shows the dialog.
        assertEquals(MediaPermissionAction.REQUEST, MediaPermissions.nextAction(denied, askedBefore = true, rationale = true))
        // Denied again (or "Don't ask again"): the dialog no longer appears, so go to settings.
        assertEquals(MediaPermissionAction.OPEN_SETTINGS, MediaPermissions.nextAction(denied, askedBefore = true, rationale = false))
        // Partial: Android 14+ re-shows the picker, so request (the card also offers settings).
        assertEquals(MediaPermissionAction.REQUEST, MediaPermissions.nextAction(partial, askedBefore = true, rationale = false))
        assertEquals(MediaPermissionAction.REQUEST, MediaPermissions.nextAction(partial, askedBefore = false, rationale = true))
    }
}
