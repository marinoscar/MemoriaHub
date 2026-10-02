package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.contract.NetworkMode
import memoriahub.marin.cr.notifications.SummaryNotificationPrefs
import memoriahub.marin.cr.testing.FakeSharedPreferences
import memoriahub.marin.cr.testing.RecordingSyncControl
import memoriahub.marin.cr.testing.syncConfigView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

@OptIn(ExperimentalCoroutinesApi::class)
class NetworkControllerTest {
    private val prefs = SummaryNotificationPrefs(FakeSharedPreferences())

    private fun TestScope.controller(control: RecordingSyncControl, paired: Boolean = true): NetworkController {
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        return NetworkController(control, { paired }, prefs, scope).also { it.load() }
    }

    @Test fun `loads the saved config, wifi only by default`() = runTest {
        val c = controller(RecordingSyncControl(null))
        val s = c.state.value
        assertEquals(NetworkMode.WIFI, s.network)
        assertFalse(s.requireCharging)
        assertEquals(UploadExisting.ALL, s.uploadExisting)
        assertTrue(s.summaryNotifications)
        assertNull(s.patch())
    }

    @Test fun `saves only the changed fields`() = runTest {
        val control = RecordingSyncControl(syncConfigView())
        val c = controller(control)
        c.setNetwork(NetworkMode.ANY)
        c.setRequireCharging(true)
        c.save(); advanceUntilIdle()
        assertEquals(ConfigPatch(network = NetworkMode.ANY, requireCharging = true), control.patches.single())
        assertEquals("Saved", c.state.value.message)
        assertFalse(c.state.value.dirty)
    }

    @Test fun `only new ones needs a confirmation`() = runTest {
        val control = RecordingSyncControl(syncConfigView())
        val c = controller(control)
        c.chooseUploadExisting(UploadExisting.FROM_PAIRING)
        assertTrue(c.state.value.confirmFromPairing)
        assertEquals(UploadExisting.ALL, c.state.value.uploadExisting)
        c.cancelFromPairing()
        assertFalse(c.state.value.confirmFromPairing)
        assertNull(c.state.value.patch())
        c.chooseUploadExisting(UploadExisting.FROM_PAIRING)
        c.confirmFromPairing()
        assertEquals(ConfigPatch(uploadExisting = UploadExisting.FROM_PAIRING), c.state.value.patch())
    }

    @Test fun `going back to all is immediate`() = runTest {
        val c = controller(RecordingSyncControl(syncConfigView(uploadExisting = UploadExisting.FROM_PAIRING)))
        c.chooseUploadExisting(UploadExisting.ALL)
        assertFalse(c.state.value.confirmFromPairing)
        assertEquals(ConfigPatch(uploadExisting = UploadExisting.ALL), c.state.value.patch())
    }

    @Test fun `offline save is queued, errors keep the edit`() = runTest {
        val control = RecordingSyncControl(syncConfigView()).apply { result = Result.failure(IOException("offline")) }
        val c = controller(control)
        c.setNetwork(NetworkMode.ANY)
        c.save(); advanceUntilIdle()
        assertTrue(c.state.value.message!!.startsWith("Saved on this phone"))
        assertFalse(c.state.value.dirty)

        control.result = Result.failure(IllegalStateException("DEVICE_REVOKED"))
        c.setNetwork(NetworkMode.WIFI)
        c.save(); advanceUntilIdle()
        assertEquals("Could not save: DEVICE_REVOKED", c.state.value.error)
        assertTrue(c.state.value.dirty)
    }

    @Test fun `summary notifications toggle is stored locally`() = runTest {
        val c = controller(RecordingSyncControl(syncConfigView()))
        c.setSummaryNotifications(false)
        assertFalse(prefs.enabled)
        assertFalse(c.state.value.summaryNotifications)
        assertNull(c.state.value.patch())
    }

    @Test fun `unpaired phones cannot save`() = runTest {
        val control = RecordingSyncControl(null)
        val c = controller(control, paired = false)
        c.setNetwork(NetworkMode.ANY)
        assertFalse(c.state.value.canSave)
        c.save(); advanceUntilIdle()
        assertTrue(control.calls.isEmpty())
    }
}
