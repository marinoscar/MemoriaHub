package cr.marin.memoriahub.core.storage

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppConfigStoreDefaultsTest {

    @Test
    fun `existing install with target circle stays enabled`() {
        assertTrue(resolveInitialBackupEnabled(hasTargetCircle = true, lastScanDateAddedSec = 0L))
    }

    @Test
    fun `existing install that has scanned stays enabled`() {
        assertTrue(
            resolveInitialBackupEnabled(hasTargetCircle = false, lastScanDateAddedSec = 1_700_000_000L),
        )
    }

    @Test
    fun `existing install with both signals stays enabled`() {
        assertTrue(
            resolveInitialBackupEnabled(hasTargetCircle = true, lastScanDateAddedSec = 1_700_000_000L),
        )
    }

    @Test
    fun `fresh install defaults to off`() {
        assertFalse(resolveInitialBackupEnabled(hasTargetCircle = false, lastScanDateAddedSec = 0L))
    }
}
