package cr.marin.memoriahub.core.util

import javax.inject.Inject
import javax.inject.Singleton

/** Indirection over the system clock so time-dependent logic is unit-testable. */
interface TimeProvider {
    fun nowMillis(): Long
}

@Singleton
class SystemTimeProvider @Inject constructor() : TimeProvider {
    override fun nowMillis(): Long = System.currentTimeMillis()
}
