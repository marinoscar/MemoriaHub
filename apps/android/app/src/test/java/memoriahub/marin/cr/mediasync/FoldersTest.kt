package memoriahub.marin.cr.mediasync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import memoriahub.marin.cr.contract.ConfigPatch
import memoriahub.marin.cr.ledger.BucketStats
import memoriahub.marin.cr.ledger.SyncStats
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.permissions.MediaPermissionState
import memoriahub.marin.cr.testing.RecordingSyncControl
import memoriahub.marin.cr.testing.syncConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Locale

class FolderSelectionTest {
    private val inventory = listOf(
        Bucket("camera", "Camera", "DCIM/Camera/", photoCount = 1234, videoCount = 56, bytes = 1),
        Bucket("wa", "WhatsApp Images", "Pictures/WhatsApp/", photoCount = 10, videoCount = 0, bytes = 1),
        Bucket("screens", "Screenshots", "Pictures/Screenshots/", photoCount = 0, videoCount = 0, bytes = 0),
    )
    private val stats = SyncStats(perBucket = mapOf("camera" to BucketStats(uploaded = 1000, deduplicated = 10)))

    @Test fun `rows carry counts and per-folder synced over total`() {
        val rows = FolderSelection.rows(inventory, stats, selected = setOf("camera"))
        assertEquals(listOf("camera", "wa", "screens"), rows.map { it.bucketId })
        val camera = rows[0]
        assertEquals(1010, camera.synced)
        assertEquals(1290, camera.total)
        assertEquals("1,234 photos · 56 videos", MediaSyncFormat.photosAndVideos(1234, 56, Locale.US))
        assertEquals("10 photos", MediaSyncFormat.photosAndVideos(10, 0, Locale.US))
        assertEquals(0, rows[1].synced)
    }

    @Test fun `selected folders no longer on the phone stay listed so they can be deselected`() {
        val rows = FolderSelection.rows(inventory, stats, selected = setOf("camera", "gone"))
        val gone = rows.last()
        assertEquals("gone", gone.bucketId)
        assertTrue(gone.missingOnPhone)
        assertEquals("Not found on this phone", gone.syncedText)
    }

    @Test fun `search matches name or relative path, case-insensitively`() {
        val rows = FolderSelection.rows(inventory, stats, emptySet())
        assertEquals(listOf("wa"), FolderSelection.filter(rows, "whats").map { it.bucketId })
        assertEquals(listOf("wa", "screens"), FolderSelection.filter(rows, "PICTURES").map { it.bucketId })
        assertEquals(3, FolderSelection.filter(rows, "  ").size)
    }

    @Test fun `select all and none only touch visible rows`() {
        val rows = FolderSelection.rows(inventory, stats, emptySet())
        val visible = FolderSelection.filter(rows, "pictures")
        assertEquals(setOf("camera", "wa", "screens"), FolderSelection.selectAll(setOf("camera"), visible))
        assertEquals(setOf("camera"), FolderSelection.selectNone(setOf("camera", "wa", "screens"), visible))
    }

    @Test fun `diff lists added and removed folders`() {
        val diff = FolderSelection.diff(saved = setOf("camera", "wa"), current = setOf("camera", "screens"))
        assertEquals(setOf("screens"), diff.added)
        assertEquals(setOf("wa"), diff.removed)
        assertTrue(FolderSelection.diff(setOf("a"), setOf("a")).isEmpty)
    }

    @Test fun `patch sends only changed fields, folders in checklist order`() {
        val rows = FolderSelection.rows(inventory, stats, emptySet())
        val base = FoldersUiState(
            loading = false, paired = true, rows = rows, selected = setOf("camera"), savedSelection = setOf("camera"),
        )
        assertNull(base.patch())
        assertFalse(base.canSave)
        assertEquals(ConfigPatch(folderIds = listOf("camera", "screens")), base.copy(selected = setOf("screens", "camera")).patch())
        assertEquals(ConfigPatch(includeVideos = false), base.copy(includeVideos = false).patch())
        assertTrue(base.copy(includeVideos = false).canSave)
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class FoldersControllerTest {
    private val inventory = listOf(
        Bucket("camera", "Camera", "DCIM/Camera/", 5, 1, 1),
        Bucket("wa", "WhatsApp Images", "Pictures/WhatsApp/", 3, 0, 1),
    )

    private fun TestScope.controller(control: RecordingSyncControl, paired: Boolean = true): FoldersController {
        val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        return FoldersController(
            control = control,
            paired = { paired },
            permission = { MediaPermissionState.FULL },
            inventory = { inventory },
            stats = { SyncStats() },
            scope = scope,
        )
    }

    @Test fun `loads the saved selection and types`() = runTest {
        val control = RecordingSyncControl(syncConfig(folderIds = listOf("camera"), includeVideos = false))
        val c = controller(control)
        c.load()
        advanceUntilIdle()
        val s = c.state.value
        assertFalse(s.loading)
        assertEquals(setOf("camera"), s.selected)
        assertFalse(s.includeVideos)
        assertEquals(2, s.rows.size)
        assertFalse(s.dirty)
    }

    @Test fun `saving online patches the config then syncs`() = runTest {
        val control = RecordingSyncControl(syncConfig(folderIds = listOf("camera")))
        val c = controller(control)
        c.load(); advanceUntilIdle()
        c.toggle("wa")
        c.save(); advanceUntilIdle()
        assertEquals(listOf("updateConfig", "syncNow"), control.calls)
        assertEquals(ConfigPatch(folderIds = listOf("camera", "wa")), control.patches.single())
        val s = c.state.value
        assertFalse(s.dirty)
        assertEquals("Saved. Syncing 2 folders.", s.message)
    }

    @Test fun `saving offline keeps the edit as saved for the outbox and does not sync`() = runTest {
        val control = RecordingSyncControl(syncConfig(folderIds = listOf("camera"))).apply {
            result = Result.failure(IOException("no network"))
        }
        val c = controller(control)
        c.load(); advanceUntilIdle()
        c.selectNone()
        c.save(); advanceUntilIdle()
        assertEquals(listOf("updateConfig"), control.calls)
        assertEquals(ConfigPatch(folderIds = emptyList()), control.patches.single())
        val s = c.state.value
        assertFalse(s.dirty)
        assertTrue(s.message!!.startsWith("Saved on this phone"))
        assertNull(s.error)
    }

    @Test fun `a server rejection shows the error and keeps the edit`() = runTest {
        val control = RecordingSyncControl(syncConfig(folderIds = listOf("camera"))).apply {
            result = Result.failure(IllegalArgumentException("UNKNOWN_FOLDER"))
        }
        val c = controller(control)
        c.load(); advanceUntilIdle()
        c.toggle("wa")
        c.save(); advanceUntilIdle()
        val s = c.state.value
        assertTrue(s.dirty)
        assertEquals("Could not save: UNKNOWN_FOLDER", s.error)
    }

    @Test fun `unpaired phones cannot save`() = runTest {
        val control = RecordingSyncControl(null)
        val c = controller(control, paired = false)
        c.load(); advanceUntilIdle()
        c.toggle("wa")
        assertFalse(c.state.value.canSave)
        c.save(); advanceUntilIdle()
        assertTrue(control.calls.isEmpty())
        assertEquals("Pair this phone first.", c.state.value.error)
    }

    @Test fun `reload keeps unsaved edits`() = runTest {
        val control = RecordingSyncControl(syncConfig(folderIds = listOf("camera")))
        val c = controller(control)
        c.load(); advanceUntilIdle()
        c.toggle("wa")
        c.load(keepEdits = true); advanceUntilIdle()
        assertEquals(setOf("camera", "wa"), c.state.value.selected)
        c.load(keepEdits = false); advanceUntilIdle()
        assertEquals(setOf("camera"), c.state.value.selected)
    }
}
