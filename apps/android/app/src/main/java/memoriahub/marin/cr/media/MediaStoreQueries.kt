package memoriahub.marin.cr.media

/** A `ContentResolver.query` selection with its arguments. */
data class Selection(val sql: String, val args: List<String>)

/**
 * The MediaStore queries, as pure functions of the SDK level so every Android version's form is
 * JVM-tested. Raw column names are used (they work on API 26+ without API-gated constants); the
 * generation columns exist only on API 30+, `RELATIVE_PATH`/`IS_PENDING` only on API 29+.
 */
object MediaStoreQueries {
    const val ID = "_id"
    const val DISPLAY_NAME = "_display_name"
    const val MIME_TYPE = "mime_type"
    const val SIZE = "_size"
    const val DATE_TAKEN = "datetaken"
    const val DATE_MODIFIED = "date_modified"
    const val DATE_ADDED = "date_added"
    const val BUCKET_ID = "bucket_id"
    const val BUCKET_DISPLAY_NAME = "bucket_display_name"
    const val RELATIVE_PATH = "relative_path"
    const val DATA = "_data"
    const val GENERATION_ADDED = "generation_added"
    const val GENERATION_MODIFIED = "generation_modified"
    const val DURATION = "duration"
    const val IS_PENDING = "is_pending"
    const val IS_TRASHED = "is_trashed"

    /** SQLite's default bound-parameter limit is 999; stay well under it. */
    const val MAX_BUCKET_ARGS = 500

    fun scanProjection(sdkInt: Int, isVideo: Boolean): Array<String> = buildList {
        addAll(listOf(ID, DISPLAY_NAME, MIME_TYPE, SIZE, DATE_TAKEN, DATE_MODIFIED, BUCKET_ID, BUCKET_DISPLAY_NAME))
        add(if (sdkInt >= 29) RELATIVE_PATH else DATA)
        if (sdkInt >= 30) add(GENERATION_MODIFIED)
        if (isVideo) add(DURATION)
    }.toTypedArray()

    fun inventoryProjection(sdkInt: Int): Array<String> =
        arrayOf(BUCKET_ID, BUCKET_DISPLAY_NAME, if (sdkInt >= 29) RELATIVE_PATH else DATA, SIZE)

    /** Filters every query shares: no pending (API 29+) and no trashed (API 30+) rows. */
    fun visibleOnly(sdkInt: Int): List<String> = buildList {
        if (sdkInt >= 29) add("$IS_PENDING = 0")
        if (sdkInt >= 30) add("$IS_TRASHED = 0")
    }

    fun inventorySelection(sdkInt: Int): Selection? =
        visibleOnly(sdkInt).takeIf { it.isNotEmpty() }?.let { Selection(it.joinToString(" AND "), emptyList()) }

    /**
     * The scan selection for [cursor] over [buckets] (at most [MAX_BUCKET_ARGS]; callers chunk), or
     * null when nothing can match (no bucket). Incremental on the generation columns (API 30+) or,
     * below that, on `DATE_MODIFIED`/`DATE_ADDED` minus the slack (a copied file keeps an old mtime
     * but gets a fresh `DATE_ADDED`).
     */
    fun scanSelection(sdkInt: Int, cursor: ScanCursor, buckets: Collection<String>): Selection? {
        if (buckets.isEmpty()) return null
        require(buckets.size <= MAX_BUCKET_ARGS) { "chunk buckets to at most $MAX_BUCKET_ARGS" }
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        clauses += "$BUCKET_ID IN (${buckets.joinToString(",") { "?" }})"
        args += buckets
        clauses += visibleOnly(sdkInt)
        val generation = cursor.sinceGeneration
        val dateModified = cursor.sinceDateModifiedSec
        when {
            sdkInt >= 30 && generation != null -> {
                clauses += "($GENERATION_ADDED > ? OR $GENERATION_MODIFIED > ?)"
                args += listOf(generation.toString(), generation.toString())
            }
            dateModified != null -> {
                val since = (dateModified - ScanCursor.DATE_SLACK_SEC).coerceAtLeast(0)
                clauses += "($DATE_MODIFIED >= ? OR $DATE_ADDED >= ?)"
                args += listOf(since.toString(), since.toString())
            }
        }
        return Selection(clauses.joinToString(" AND "), args)
    }

    /** Stable order so a partially consumed scan is still deterministic. */
    const val SCAN_ORDER = "$ID ASC"
}

/** `RELATIVE_PATH` for rows that only have `DATA` (API 26–28). */
object RelativePaths {
    private val storageRoot = Regex("^/storage/(emulated/\\d+|[^/]+)/")
    private val sdcardRoot = Regex("^/(sdcard|mnt/sdcard)/")

    /** `/storage/emulated/0/DCIM/Camera/a.jpg` → `DCIM/Camera/`; null when the path is not under a storage root. */
    fun fromData(data: String?): String? {
        if (data.isNullOrBlank()) return null
        val rest = storageRoot.find(data)?.let { data.substring(it.range.last + 1) }
            ?: sdcardRoot.find(data)?.let { data.substring(it.range.last + 1) }
            ?: return null
        val slash = rest.lastIndexOf('/')
        return if (slash < 0) "" else rest.substring(0, slash + 1)
    }
}

/** Aggregates inventory rows into [Bucket]s (one per `BUCKET_ID`, across volumes). */
class InventoryAggregator {
    private class Acc(var name: String, var relativePath: String, var photos: Int = 0, var videos: Int = 0, var bytes: Long = 0)

    private val buckets = LinkedHashMap<String, Acc>()

    fun add(bucketId: String?, name: String?, relativePath: String?, isVideo: Boolean, sizeBytes: Long) {
        if (bucketId.isNullOrEmpty()) return
        val acc = buckets.getOrPut(bucketId) {
            Acc(name = name.orEmpty(), relativePath = relativePath.orEmpty())
        }
        if (acc.name.isEmpty() && !name.isNullOrEmpty()) acc.name = name
        if (acc.relativePath.isEmpty() && !relativePath.isNullOrEmpty()) acc.relativePath = relativePath
        if (isVideo) acc.videos++ else acc.photos++
        acc.bytes += sizeBytes.coerceAtLeast(0)
    }

    /** Buckets with the most media first, then by name. */
    fun result(): List<Bucket> = buckets.map { (id, acc) ->
        Bucket(
            bucketId = id,
            name = acc.name.ifEmpty { acc.relativePath.trimEnd('/').substringAfterLast('/').ifEmpty { id } },
            relativePath = acc.relativePath,
            photoCount = acc.photos,
            videoCount = acc.videos,
            bytes = acc.bytes,
        )
    }.sortedWith(compareByDescending<Bucket> { it.photoCount + it.videoCount }.thenBy { it.name.lowercase() }.thenBy { it.bucketId })
}
