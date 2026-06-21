package cr.marin.memoriahub.data.db

/** Per-file sync state machine, mirroring the CLI's `files.status`. */
enum class SyncStatus {
    /** Discovered or changed; awaiting processing. */
    QUEUED,

    /** Computing SHA-256. */
    HASHING,

    /** Bytes are being uploaded / the item is being registered. */
    UPLOADING,

    /** Successfully registered as a MediaItem in the circle. */
    UPLOADED,

    /** Server already had this content (dedup hit) — nothing to do. */
    SKIPPED,

    /** Failed but still retryable (attemptCount < cap). */
    FAILED,

    /** Failed and exhausted the retry cap; needs a manual/forced retry. */
    BLOCKED,
}

enum class MediaType {
    PHOTO,
    VIDEO,
}
