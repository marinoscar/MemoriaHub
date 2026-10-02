package memoriahub.marin.cr.util

import memoriahub.marin.cr.BuildConfig

/**
 * The product identity, as generated into [BuildConfig] from `apps/android/identity.properties`
 * (see app/build.gradle.kts). User-facing text names the product through this object, never
 * through a literal.
 */
object Brand {
    /** Display name, e.g. in "Pair with <name>". */
    val name: String = BuildConfig.PRODUCT_NAME

    /** [name] without spaces or punctuation (user agent, log tags), e.g. `Some Name` → `SomeName`. */
    val compactName: String = compact(BuildConfig.PRODUCT_NAME)

    /** Custom scheme of the app's deep links (`memoriahub://media-sync`; see deeplink/MediaSyncLinks). */
    val deepLinkScheme: String = BuildConfig.DEEP_LINK_SCHEME

    fun compact(productName: String): String = productName.filter { it.isLetterOrDigit() && it.code < 128 }.ifEmpty { "App" }
}
