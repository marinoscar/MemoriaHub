package memoriahub.marin.cr.testing

import memoriahub.marin.cr.ledger.LedgerTransactions
import memoriahub.marin.cr.ledger.StateBucketCount
import memoriahub.marin.cr.ledger.SyncFileDao
import memoriahub.marin.cr.ledger.SyncFileEntity
import memoriahub.marin.cr.ledger.SyncFileScopeRow
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.SyncRunDao
import memoriahub.marin.cr.ledger.SyncRunEntity
import memoriahub.marin.cr.media.Bucket
import memoriahub.marin.cr.media.MediaGateway
import memoriahub.marin.cr.media.MediaRow
import memoriahub.marin.cr.media.ScanCursor
import memoriahub.marin.cr.media.ScanCursorStore
import memoriahub.marin.cr.media.ScannedScope
import memoriahub.marin.cr.media.VolumeCursor
import memoriahub.marin.cr.permissions.MediaPermissionState
import java.io.ByteArrayInputStream
import java.io.InputStream

/** Same ordering as the DAO's SQL: dateTaken DESC with nulls last, then id ASC. */
private val ledgerOrder = compareBy<SyncFileEntity>({ if (it.dateTaken == null) 1 else 0 }, { -(it.dateTaken ?: 0L) }, { it.id })

/** In-memory [SyncFileDao] mirroring the SQL semantics (unique (mediaStoreId, volume), auto ids). */
class FakeSyncFileDao : SyncFileDao {
    val rows = linkedMapOf<Long, SyncFileEntity>()
    private var nextId = 1L

    fun all(): List<SyncFileEntity> = rows.values.toList()
    fun byMediaStoreId(id: Long, volume: String = "external_primary") = rows.values.single { it.mediaStoreId == id && it.volume == volume }

    /** Inserts a row directly (test setup), returning it with its id. */
    fun seed(row: SyncFileEntity): SyncFileEntity {
        val withId = row.copy(id = nextId++)
        rows[withId.id] = withId
        return withId
    }

    override suspend fun get(id: Long) = rows[id]
    override suspend fun findByMediaStoreIds(volume: String, mediaStoreIds: List<Long>) =
        rows.values.filter { it.volume == volume && it.mediaStoreId in mediaStoreIds }

    override suspend fun insertAll(rows: List<SyncFileEntity>): List<Long> = rows.map { row ->
        check(this.rows.values.none { it.mediaStoreId == row.mediaStoreId && it.volume == row.volume }) { "UNIQUE constraint failed" }
        seed(row).id
    }

    override suspend fun update(row: SyncFileEntity) {
        if (rows.containsKey(row.id)) rows[row.id] = row
    }

    override suspend fun updateAll(rows: List<SyncFileEntity>) = rows.forEach { update(it) }
    override suspend fun deleteByIds(ids: List<Long>) = ids.forEach { rows.remove(it) }
    override suspend fun deleteAll() = rows.clear()

    override suspend fun inStates(states: List<String>, limit: Int) =
        rows.values.filter { it.state.name in states }.sortedWith(ledgerOrder).take(limit)

    override suspend fun dueInState(state: String, nowMs: Long, limit: Int) =
        rows.values.filter { it.state.name == state && (it.nextAttemptAt == null || it.nextAttemptAt!! <= nowMs) }
            .sortedWith(ledgerOrder).take(limit)

    override suspend fun scopePage(afterId: Long, limit: Int) =
        rows.values.filter { it.id > afterId }.sortedBy { it.id }.take(limit).map { it.scopeRow() }

    override suspend fun getAll(ids: List<Long>) = ids.mapNotNull { rows[it] }

    override suspend fun inVolumeAndStates(volume: String, states: List<String>) =
        rows.values.filter { it.volume == volume && it.state.name in states }.map { it.scopeRow() }

    override suspend fun requeueAllInState(from: String, nowMs: Long): Int {
        val hits = rows.values.filter { it.state.name == from }
        hits.forEach { rows[it.id] = it.copy(state = SyncFileState.QUEUED, attempts = 0, nextAttemptAt = null, updatedAt = nowMs) }
        return hits.size
    }

    override suspend fun requeueHashing(nowMs: Long) = requeueAllInStateKeepAttempts(SyncFileState.HASHING, nowMs)

    private fun requeueAllInStateKeepAttempts(from: SyncFileState, nowMs: Long): Int {
        val hits = rows.values.filter { it.state == from }
        hits.forEach { rows[it.id] = it.copy(state = SyncFileState.QUEUED, updatedAt = nowMs) }
        return hits.size
    }

    override suspend fun stateBucketCounts() = rows.values.groupBy { it.state to it.bucketId }.map { (key, group) ->
        StateBucketCount(key.first, key.second, group.size.toLong(), group.sumOf { it.sizeBytes })
    }

    override suspend fun recentInStates(states: List<String>, limit: Int) =
        rows.values.filter { it.state.name in states }.sortedWith(compareByDescending<SyncFileEntity> { it.updatedAt }.thenByDescending { it.id }).take(limit)

    override suspend fun count() = rows.size

    private fun SyncFileEntity.scopeRow() = SyncFileScopeRow(id, mediaStoreId, volume, bucketId, isVideo, dateTaken, dateModified, state)
}

class FakeSyncRunDao : SyncRunDao {
    val runs = mutableListOf<SyncRunEntity>()
    private var nextId = 1L
    override suspend fun insert(run: SyncRunEntity): Long = (nextId++).also { runs += run.copy(id = it) }
    override suspend fun trim(keep: Int) {
        val kept = recent(keep).map { it.id }.toSet()
        runs.retainAll { it.id in kept }
    }
    override suspend fun recent(limit: Int) =
        runs.sortedWith(compareByDescending<SyncRunEntity> { it.startedAt }.thenByDescending { it.id }).take(limit)
    override suspend fun deleteAll() = runs.clear()
}

object DirectTransactions : LedgerTransactions {
    override suspend fun <T> run(block: suspend () -> T): T = block()
}

class FakeScanCursorStore : ScanCursorStore {
    val cursors = mutableMapOf<String, VolumeCursor>()
    override fun cursor(volume: String) = cursors[volume]
    override fun setCursor(volume: String, cursor: VolumeCursor) {
        cursors[volume] = cursor
    }
    override var lastFullScanAtMs: Long? = null
    override var scannedScope: ScannedScope? = null
    override fun clear() {
        cursors.clear()
        lastFullScanAtMs = null
        scannedScope = null
    }
}

/**
 * [MediaGateway] over an in-memory "MediaStore": [rows] per volume with a generation counter.
 * [scan] honours the cursor the way the real queries do (generation, else date modified/added).
 */
class FakeMediaGateway(var permission: MediaPermissionState = MediaPermissionState.FULL) : MediaGateway {
    val rows = mutableListOf<MediaRow>()
    val generations = mutableMapOf<String, Long>()
    val versions = mutableMapOf<String, String>()
    val volumeNames = linkedSetOf(VOLUME)
    var useGenerations = true
    var throwOnScan: Exception? = null
    val scans = mutableListOf<ScanCursor>()
    /** generation_added per row id (the generation at insert). */
    private val addedAt = mutableMapOf<Pair<String, Long>, Long>()

    fun put(row: MediaRow) {
        val gen = (generations[row.volume] ?: 0L) + 1
        generations[row.volume] = gen
        val stored = if (useGenerations) row.copy(generationModified = gen) else row.copy(generationModified = null)
        val key = row.volume to row.mediaStoreId
        rows.removeAll { it.volume == row.volume && it.mediaStoreId == row.mediaStoreId }
        if (key !in addedAt) addedAt[key] = gen
        rows += stored
    }

    fun delete(mediaStoreId: Long, volume: String = VOLUME) {
        rows.removeAll { it.mediaStoreId == mediaStoreId && it.volume == volume }
    }

    override fun volumes(): Set<String> = volumeNames
    override fun currentGeneration(volume: String): Long? = if (useGenerations) generations[volume] ?: 0L else null
    override fun mediaStoreVersion(volume: String): String? = versions[volume]

    override fun inventory(): List<Bucket> {
        val agg = memoriahub.marin.cr.media.InventoryAggregator()
        rows.forEach { agg.add(it.bucketId, it.bucketName, it.relativePath, it.isVideo, it.sizeBytes) }
        return agg.result()
    }

    override fun scan(since: ScanCursor, buckets: Set<String>, includePhotos: Boolean, includeVideos: Boolean): Sequence<MediaRow> {
        throwOnScan?.let { throw it }
        scans += since
        return rows.filter { row ->
            row.volume == since.volume && row.bucketId in buckets &&
                (if (row.isVideo) includeVideos else includePhotos) &&
                when {
                    since.sinceGeneration != null ->
                        (addedAt[row.volume to row.mediaStoreId] ?: 0L) > since.sinceGeneration!! ||
                            (row.generationModified ?: 0L) > since.sinceGeneration!!
                    since.sinceDateModifiedSec != null -> row.dateModifiedSec >= since.sinceDateModifiedSec!! - ScanCursor.DATE_SLACK_SEC
                    else -> true
                }
        }.toList().asSequence()
    }

    override fun openRange(uri: String, offset: Long, length: Long): InputStream = ByteArrayInputStream(ByteArray(0))
    override fun openStream(uri: String): InputStream = ByteArrayInputStream(ByteArray(0))
    override fun permissionState(): MediaPermissionState = permission

    companion object {
        const val VOLUME = "external_primary"
    }
}

fun mediaRow(
    id: Long,
    bucket: String? = "camera",
    isVideo: Boolean = false,
    size: Long = 1_000,
    dateModifiedSec: Long = 1_700_000_000,
    dateTakenMs: Long? = 1_700_000_000_000,
    volume: String = FakeMediaGateway.VOLUME,
    name: String = "IMG_$id.jpg",
    relativePath: String? = "DCIM/Camera/",
) = MediaRow(
    mediaStoreId = id,
    volume = volume,
    uri = "content://media/$volume/${if (isVideo) "video" else "images"}/media/$id",
    displayName = name,
    relativePath = relativePath,
    bucketId = bucket,
    bucketName = bucket?.replaceFirstChar { it.uppercase() },
    mimeType = if (isVideo) "video/mp4" else "image/jpeg",
    isVideo = isVideo,
    sizeBytes = size,
    dateTakenMs = dateTakenMs,
    dateModifiedSec = dateModifiedSec,
    generationModified = null,
    durationMs = if (isVideo) 1_000 else null,
)

fun ledgerRow(
    state: SyncFileState,
    mediaStoreId: Long,
    bucket: String? = "camera",
    isVideo: Boolean = false,
    size: Long = 1_000,
    dateTakenMs: Long? = 1_700_000_000_000,
    dateModifiedSec: Long = 1_700_000_000,
    attempts: Int = 0,
    nextAttemptAt: Long? = null,
    objectId: String? = null,
    updatedAt: Long = 0,
) = SyncFileEntity(
    mediaStoreId = mediaStoreId,
    volume = FakeMediaGateway.VOLUME,
    uri = "content://media/external_primary/images/media/$mediaStoreId",
    bucketId = bucket,
    bucketName = bucket,
    relativePath = "DCIM/Camera/",
    displayName = "IMG_$mediaStoreId.jpg",
    mimeType = if (isVideo) "video/mp4" else "image/jpeg",
    isVideo = isVideo,
    sizeBytes = size,
    dateModified = dateModifiedSec,
    dateTaken = dateTakenMs,
    generationModified = null,
    state = state,
    attempts = attempts,
    nextAttemptAt = nextAttemptAt,
    objectId = objectId,
    uploadId = objectId?.let { "upload-$it" },
    createdAt = 0,
    updatedAt = updatedAt,
)
