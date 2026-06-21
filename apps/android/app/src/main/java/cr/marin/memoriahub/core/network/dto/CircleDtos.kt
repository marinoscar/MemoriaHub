package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.Serializable

@Serializable
data class Circle(
    val id: String,
    val name: String,
    val isPersonal: Boolean = false,
    val description: String? = null,
    val role: String? = null,
)
