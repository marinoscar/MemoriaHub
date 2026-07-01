package cr.marin.memoriahub.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundPolicyTest {

    @Test
    fun `no pending work stays in the background`() {
        assertFalse(ForegroundPolicy.shouldPromote(pendingWorkCount = 0))
    }

    @Test
    fun `pending work promotes to foreground`() {
        assertTrue(ForegroundPolicy.shouldPromote(pendingWorkCount = 1))
        assertTrue(ForegroundPolicy.shouldPromote(pendingWorkCount = 500))
    }
}
