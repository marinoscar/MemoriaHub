package memoriahub.marin.cr.media

/**
 * D24: which content URIs are read through `MediaStore.setRequireOriginal`.
 *
 * Since Android 10 MediaProvider redacts location metadata from media read through the plain URI
 * (EXIF GPS in photos, the location atom in videos) unless the app holds `ACCESS_MEDIA_LOCATION`
 * and asks for the original. The ledger stores the plain URI the scan built
 * (`content://media/<volume>/images/media/<id>` or `content://media/<volume>/video/media/<id>`), so
 * the decision keys on the collection segment after the volume. Photos and videos both want the
 * original; any other URI is read as is.
 *
 * Pure (no `android.net.Uri`) so it is JVM-tested; [AndroidMediaGateway] passes the parsed parts.
 */
object OriginalReads {
    /** `MediaStore.AUTHORITY`. */
    const val MEDIA_AUTHORITY = "media"

    /** The collection path segments of `MediaStore.Images.Media` and `MediaStore.Video.Media`. */
    val ORIGINAL_COLLECTIONS: Set<String> = setOf("images", "video")

    /** `setRequireOriginal` exists from API 29; below it nothing is redacted. */
    const val MIN_SDK = 29

    fun wantsOriginal(sdkInt: Int, authority: String?, pathSegments: List<String>, locationGranted: Boolean): Boolean =
        sdkInt >= MIN_SDK &&
            locationGranted &&
            authority == MEDIA_AUTHORITY &&
            pathSegments.getOrNull(1) in ORIGINAL_COLLECTIONS
}
