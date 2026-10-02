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

/**
 * Builds Media Sync deep links. Pure (JVM-tested). Parsing an incoming intent into a screen and
 * action, and the `MediaSyncActivity` intent filter (`scheme=memoriahub host=media-sync`), arrive
 * with the screens in issue #513.
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
}
