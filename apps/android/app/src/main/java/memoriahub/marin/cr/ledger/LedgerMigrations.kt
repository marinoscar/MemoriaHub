package memoriahub.marin.cr.ledger

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Room migrations of [MediaSyncDatabase]. Never a destructive fallback: the ledger holds in-flight
 * multipart sessions and every count.
 */
object LedgerMigrations {
    /**
     * States whose video rows keep their hash in [MIGRATION_1_2]. `UPLOADED` and `DEDUPLICATED` are
     * done and are never re-uploaded automatically. `REGISTERING` already uploaded every byte under
     * that hash: its object on the server holds the same (redacted) bytes the hash describes, so
     * registration finishes consistently; changing either side now would make them disagree.
     */
    val KEEPS_VIDEO_HASH: Set<SyncFileState> =
        setOf(SyncFileState.UPLOADED, SyncFileState.DEDUPLICATED, SyncFileState.REGISTERING)

    /**
     * Issue #545: before version 2 videos were read through the plain URI, so a stored video
     * `contentHash` describes location-redacted bytes. From version 2 the gateway reads the original
     * (D24), and HASHING skips re-hashing while a hash is stored, so such a row would upload the
     * original bytes under the old hash, or resume a multipart session created for the old bytes.
     *
     * For every video row not in [KEEPS_VIDEO_HASH] this forgets the hash and the session's parts,
     * so the next attempt re-hashes the original and starts a fresh session. `objectId` is kept on
     * purpose: with no `partSize`/`totalParts` the upload engine treats it as an incomplete session,
     * aborts it on the server (best effort) and re-initialises, so no stale session is left open.
     * The state, attempts and backoff are untouched (no transition, no attempt counted). Photos are
     * unaffected: they were already read through the original.
     */
    val STALE_VIDEO_HASH_RESET_SQL: String =
        "UPDATE sync_files SET contentHash = NULL, uploadId = NULL, partSize = NULL, totalParts = NULL, " +
            "completedPartsJson = NULL, partUploadAuth = NULL " +
            "WHERE isVideo = 1 AND state NOT IN (" + KEEPS_VIDEO_HASH.joinToString(", ") { "'${it.name}'" } + ")"

    /** 1 → 2: data only (the schema is unchanged); see [STALE_VIDEO_HASH_RESET_SQL]. */
    val MIGRATION_1_2: Migration = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL(STALE_VIDEO_HASH_RESET_SQL)
        }
    }

    val ALL: Array<Migration> = arrayOf(MIGRATION_1_2)
}
