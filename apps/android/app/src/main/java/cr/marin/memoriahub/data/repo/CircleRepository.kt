package cr.marin.memoriahub.data.repo

import cr.marin.memoriahub.core.network.api.CircleApi
import cr.marin.memoriahub.core.network.dto.Circle
import cr.marin.memoriahub.core.storage.AppConfigStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class CircleRepository @Inject constructor(
    private val circleApi: CircleApi,
    private val appConfigStore: AppConfigStore,
) {
    suspend fun getCircles(): List<Circle> = withContext(Dispatchers.IO) {
        circleApi.getCircles().data.items
    }

    /**
     * Returns the configured target circle id, defaulting to the user's personal
     * circle the first time (and persisting that choice).
     */
    suspend fun resolveTargetCircleId(): String? = withContext(Dispatchers.IO) {
        appConfigStore.targetCircleId?.let { return@withContext it }
        val circles = runCatching { getCircles() }.getOrNull().orEmpty()
        val personal = circles.firstOrNull { it.isPersonal } ?: circles.firstOrNull()
        personal?.id?.also { appConfigStore.setTargetCircleId(it) }
    }
}
