package memoriahub.marin.cr.deeplink

import memoriahub.marin.cr.util.Brand

/**
 * The native Media Sync screens a deep link can open (docs/specs/android-media-sync.md §12.2 and
 * decision D13): `memoriahub://media-sync[/<segment>]`. The same set is the web's
 * `mediaSyncDeepLink(path?, action?)` input (apps/web/src/utils/androidIdentity.ts).
 */
enum class MediaSyncPath(val segment: String) {
    HUB(""),
    CONNECT("connect"),

    /** Hub after pairing; the device-flow `returnUri` (issue #509). */
    PAIRED("paired"),
    FOLDERS("folders"),
    NETWORK("network"),
    FILES("files"),
    DIAGNOSTICS("diagnostics"),
}

/** The optional `?action=` run after the screen opens (§12.2). */
enum class MediaSyncAction(val value: String) {
    APPLY("apply"),
    SYNC("sync"),
    RETRY("retry"),
    PAUSE("pause"),
    RESUME("resume"),
}

/** Where an incoming Media Sync intent should land: a screen plus an optional action. */
data class MediaSyncRoute(val path: MediaSyncPath, val action: MediaSyncAction? = null) {
    /** The device-flow return (`/paired`): poll the pending code immediately (`pokeNow()`). */
    val isPairingReturn: Boolean get() = path == MediaSyncPath.PAIRED
}

/**
 * Builds and parses Media Sync deep links. Pure (JVM-tested; `java.net.URI`, no `android.net.Uri`).
 * `MediaSyncActivity` (#509 minimal host, extended in #513) registers the intent filter
 * `scheme=memoriahub host=media-sync` and routes through [route].
 */
object MediaSyncLinks {
    const val HOST = "media-sync"

    fun uri(
        path: MediaSyncPath = MediaSyncPath.HUB,
        action: MediaSyncAction? = null,
        scheme: String = Brand.deepLinkScheme,
    ): String = buildString {
        append(scheme).append("://").append(HOST)
        if (path.segment.isNotEmpty()) append('/').append(path.segment)
        if (action != null) append("?action=").append(action.value)
    }

    /** `memoriahub://media-sync/paired`: where the activation page sends the user back after approval. */
    val pairedReturnUri: String get() = uri(MediaSyncPath.PAIRED)

    /** Intent extra opening a screen (notification content intents): `hub|connect|folders|network|files|diagnostics`. */
    const val EXTRA_OPEN = "open"

    /**
     * Parses `memoriahub://media-sync[/<segment>][?action=<action>]`. Returns null for any other
     * scheme or host. An unknown segment opens the hub; an unknown action is ignored.
     */
    fun parse(uri: String?, scheme: String = Brand.deepLinkScheme): MediaSyncRoute? {
        if (uri.isNullOrBlank()) return null
        val parsed = runCatching { java.net.URI(uri.trim()) }.getOrNull() ?: return null
        if (!parsed.scheme.equals(scheme, ignoreCase = true)) return null
        if (!parsed.host.equals(HOST, ignoreCase = true)) return null
        val segment = parsed.path.orEmpty().trim('/').substringBefore('/').lowercase()
        val path = pathFor(segment) ?: MediaSyncPath.HUB
        val action = parsed.rawQuery.orEmpty().split('&')
            .mapNotNull { pair -> pair.split('=', limit = 2).takeIf { it.size == 2 && it[0] == "action" }?.get(1) }
            .firstNotNullOfOrNull { value -> MediaSyncAction.entries.firstOrNull { it.value == value.lowercase() } }
        return MediaSyncRoute(path, action)
    }

    /**
     * Where an intent lands: [extraOpen] (`EXTRA_OPEN`) wins over the data URI's path, so a
     * notification can carry the generic hub URI and still open Connect; the action always comes
     * from the URI. With neither, the hub.
     */
    fun route(dataUri: String?, extraOpen: String?, scheme: String = Brand.deepLinkScheme): MediaSyncRoute {
        val fromUri = parse(dataUri, scheme)
        val fromExtra = extraOpen?.trim()?.lowercase()?.let(::pathFor)?.takeIf { it != MediaSyncPath.PAIRED }
        return MediaSyncRoute(fromExtra ?: fromUri?.path ?: MediaSyncPath.HUB, fromUri?.action)
    }

    private fun pathFor(segment: String): MediaSyncPath? = when (segment) {
        "", "hub" -> MediaSyncPath.HUB
        else -> MediaSyncPath.entries.firstOrNull { it.segment == segment }
    }
}
