package cr.marin.memoriahub.core.network.dto

import kotlinx.serialization.Serializable

@Serializable
data class DeviceCodeRequest(
    val clientInfo: ClientInfo? = null,
)

@Serializable
data class ClientInfo(
    val deviceName: String? = null,
    val userAgent: String? = null,
    /** Custom-scheme deep link the web activation page uses to return to this app after approval. */
    val returnUri: String? = null,
)

@Serializable
data class DeviceCodeResponse(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String,
    val expiresIn: Long,
    val interval: Long,
)

@Serializable
data class DeviceTokenRequest(
    val deviceCode: String,
)

@Serializable
data class DeviceTokenResponse(
    val accessToken: String,
    val refreshToken: String? = null,
    val tokenType: String = "Bearer",
    val expiresIn: Long? = null,
)

@Serializable
data class RefreshResponse(
    val accessToken: String,
    val expiresIn: Long? = null,
)

@Serializable
data class CurrentUser(
    val id: String,
    val email: String,
    val displayName: String? = null,
    val profileImageUrl: String? = null,
    val isActive: Boolean = true,
    val roles: List<RoleRef> = emptyList(),
    val permissions: List<String> = emptyList(),
)

@Serializable
data class RoleRef(
    val name: String,
)
