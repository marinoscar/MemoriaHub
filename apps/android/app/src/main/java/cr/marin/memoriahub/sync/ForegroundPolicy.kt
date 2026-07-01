package cr.marin.memoriahub.sync

/**
 * Whether a sync run should promote to a foreground service. Promotion exists to
 * keep the long upload phase alive and visible — a run with nothing to upload
 * (the common periodic case) must stay plain background work: no FGS start, no
 * notification flash. Pure logic, extracted for unit testing and as the seam for
 * future conditions (e.g. size thresholds).
 */
object ForegroundPolicy {
    fun shouldPromote(pendingWorkCount: Int): Boolean = pendingWorkCount > 0
}
