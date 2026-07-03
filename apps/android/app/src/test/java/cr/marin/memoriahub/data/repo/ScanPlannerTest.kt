package cr.marin.memoriahub.data.repo

import org.junit.Assert.assertEquals
import org.junit.Test

class ScanPlannerTest {

    private val now = 1_750_000_000_000L
    private val recentFull = now - 1_000L

    private fun plan(
        requestedFull: Boolean = false,
        generationSupported: Boolean = true,
        storedGeneration: Long = 42L,
        storedDateAddedSec: Long = 1_700L,
        storedVersion: String? = "v1",
        currentVersion: String? = "v1",
        lastFullReconcileAtMs: Long = recentFull,
        nowMs: Long = now,
    ): ScanPlan = ScanPlanner.plan(
        requestedFull = requestedFull,
        generationSupported = generationSupported,
        storedGeneration = storedGeneration,
        storedDateAddedSec = storedDateAddedSec,
        storedVersion = storedVersion,
        currentVersion = currentVersion,
        lastFullReconcileAtMs = lastFullReconcileAtMs,
        nowMs = nowMs,
    )

    @Test
    fun `explicit request forces full`() {
        assertEquals(ScanPlan.Full, plan(requestedFull = true))
    }

    @Test
    fun `media store version change forces full`() {
        assertEquals(ScanPlan.Full, plan(currentVersion = "v2"))
    }

    @Test
    fun `version change beats a valid generation mark`() {
        assertEquals(ScanPlan.Full, plan(currentVersion = "v2", storedGeneration = 42L))
    }

    @Test
    fun `unset generation mark forces full in generation mode`() {
        assertEquals(ScanPlan.Full, plan(storedGeneration = 0L))
    }

    @Test
    fun `unset date mark forces full in date mode`() {
        assertEquals(
            ScanPlan.Full,
            plan(generationSupported = false, storedDateAddedSec = 0L),
        )
    }

    @Test
    fun `daily interval due forces full even with valid marks`() {
        val staleFull = now - ScanPlanner.FULL_RECONCILE_INTERVAL_MS
        assertEquals(ScanPlan.Full, plan(lastFullReconcileAtMs = staleFull))
    }

    @Test
    fun `generation mode with fresh marks is incremental with both bounds`() {
        assertEquals(
            ScanPlan.Incremental(sinceGeneration = 42L, sinceDateAddedSec = 1_700L),
            plan(),
        )
    }

    @Test
    fun `date mode with fresh marks is incremental without generation`() {
        assertEquals(
            ScanPlan.Incremental(sinceGeneration = null, sinceDateAddedSec = 1_700L),
            plan(generationSupported = false),
        )
    }

    @Test
    fun `missing stored version does not force full`() {
        // First gen-mode run stores the version; gen mark 0 already covers baselining.
        assertEquals(
            ScanPlan.Incremental(sinceGeneration = 42L, sinceDateAddedSec = 1_700L),
            plan(storedVersion = null),
        )
    }

    @Test
    fun `unreadable current version skips the version check`() {
        assertEquals(
            ScanPlan.Incremental(sinceGeneration = 42L, sinceDateAddedSec = 1_700L),
            plan(currentVersion = null),
        )
    }
}
