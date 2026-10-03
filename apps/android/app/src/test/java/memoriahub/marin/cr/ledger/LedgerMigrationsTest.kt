package memoriahub.marin.cr.ledger

import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.DriverManager

/**
 * Runs [LedgerMigrations.MIGRATION_1_2] against a real SQLite (sqlite-jdbc) holding the exported
 * version-1 `sync_files` table, through the actual [androidx.room.migration.Migration] object.
 */
class LedgerMigrationsTest {
    private lateinit var conn: Connection

    @Before fun setUp() {
        conn = DriverManager.getConnection("jdbc:sqlite::memory:")
        conn.createStatement().use { it.execute(syncFilesCreateSql(schema(1))) }
    }

    @After fun tearDown() = conn.close()

    @Test fun `stale video hashes and sessions are cleared, everything else is kept`() {
        // One video and one photo in every state, each with a hash and a full session.
        val ids = HashMap<Pair<SyncFileState, Boolean>, Long>()
        var mediaStoreId = 1L
        for (state in SyncFileState.entries) {
            for (isVideo in listOf(true, false)) ids[state to isVideo] = insert(mediaStoreId++, state, isVideo)
        }

        migrate()

        for ((key, id) in ids) {
            val (state, isVideo) = key
            val row = read(id)
            assertEquals("state is never changed ($state video=$isVideo)", state.name, row.state)
            assertEquals("attempts untouched", 2, row.attempts)
            assertEquals("backoff untouched", 9_000L, row.nextAttemptAt)
            assertEquals("objectId is kept so the engine aborts the old session", "obj-$id", row.objectId)
            if (isVideo && state !in LedgerMigrations.KEEPS_VIDEO_HASH) {
                assertNull("$state video: hash cleared", row.contentHash)
                assertNull("$state video: uploadId cleared", row.uploadId)
                assertNull("$state video: partSize cleared", row.partSize)
                assertNull("$state video: totalParts cleared", row.totalParts)
                assertNull("$state video: parts cleared", row.completedPartsJson)
                assertNull("$state video: partUploadAuth cleared", row.partUploadAuth)
            } else {
                assertEquals("$state video=$isVideo: hash kept", "hash-$id", row.contentHash)
                assertEquals("up-$id", row.uploadId)
                assertEquals(10L, row.partSize)
                assertEquals(3, row.totalParts)
                assertNotNull(row.completedPartsJson)
                assertEquals("none", row.partUploadAuth)
            }
        }
    }

    @Test fun `already uploaded and deduplicated videos are not touched (no re-upload)`() {
        val uploaded = insert(1, SyncFileState.UPLOADED, isVideo = true)
        val deduped = insert(2, SyncFileState.DEDUPLICATED, isVideo = true)
        val registering = insert(3, SyncFileState.REGISTERING, isVideo = true)
        migrate()
        for (id in listOf(uploaded, deduped, registering)) assertEquals("hash-$id", read(id).contentHash)
    }

    @Test fun `the migration is data only and leaves the version-2 schema identical`() {
        assertEquals(1, LedgerMigrations.MIGRATION_1_2.startVersion)
        assertEquals(2, LedgerMigrations.MIGRATION_1_2.endVersion)
        assertEquals(listOf(LedgerMigrations.MIGRATION_1_2), LedgerMigrations.ALL.toList())
        val v1 = schema(1)
        val v2 = schema(2)
        assertEquals(2, v2.getValue("database").jsonObject.getValue("version").jsonPrimitive.content.toInt())
        assertEquals(identityHash(v1), identityHash(v2))
        assertEquals(syncFilesCreateSql(v1), syncFilesCreateSql(v2))
    }

    @Test fun `an empty ledger migrates cleanly`() {
        migrate()
        conn.createStatement().use { s ->
            s.executeQuery("SELECT COUNT(*) FROM sync_files").use { rs -> rs.next(); assertEquals(0, rs.getInt(1)) }
        }
    }

    // -----------------------------------------------------------------------------------------

    /** Runs the real Migration with a [SupportSQLiteDatabase] whose `execSQL` goes to [conn]. */
    private fun migrate() {
        val db = Proxy.newProxyInstance(
            SupportSQLiteDatabase::class.java.classLoader,
            arrayOf(SupportSQLiteDatabase::class.java),
        ) { _, method, args ->
            when (method.name) {
                "execSQL" -> conn.createStatement().use { it.execute(args!![0] as String) }.let { null }
                else -> throw UnsupportedOperationException("migration called ${method.name}")
            }
        } as SupportSQLiteDatabase
        LedgerMigrations.MIGRATION_1_2.migrate(db)
    }

    private fun insert(mediaStoreId: Long, state: SyncFileState, isVideo: Boolean): Long {
        conn.prepareStatement(
            "INSERT INTO sync_files (mediaStoreId, volume, uri, bucketId, bucketName, relativePath, displayName, " +
                "mimeType, isVideo, sizeBytes, dateModified, dateTaken, generationModified, state, attempts, nextAttemptAt, " +
                "createdAt, updatedAt) VALUES (?, 'external_primary', ?, 'b', 'Camera', 'DCIM/Camera/', ?, ?, ?, 25, 100, 1000, 7, ?, 2, 9000, 1, 1)",
        ).use { ps ->
            val collection = if (isVideo) "video" else "images"
            ps.setLong(1, mediaStoreId)
            ps.setString(2, "content://media/external_primary/$collection/media/$mediaStoreId")
            ps.setString(3, "file-$mediaStoreId")
            ps.setString(4, if (isVideo) "video/mp4" else "image/jpeg")
            ps.setInt(5, if (isVideo) 1 else 0)
            ps.setString(6, state.name)
            ps.executeUpdate()
        }
        val id = conn.createStatement().use { s -> s.executeQuery("SELECT last_insert_rowid()").use { it.next(); it.getLong(1) } }
        conn.prepareStatement(
            "UPDATE sync_files SET contentHash = ?, objectId = ?, uploadId = ?, partSize = 10, totalParts = 3, " +
                "completedPartsJson = '[{\"partNumber\":1,\"eTag\":\"e1\"}]', partUploadAuth = 'none' WHERE id = ?",
        ).use { ps ->
            ps.setString(1, "hash-$id")
            ps.setString(2, "obj-$id")
            ps.setString(3, "up-$id")
            ps.setLong(4, id)
            ps.executeUpdate()
        }
        return id
    }

    private data class Row(
        val state: String, val contentHash: String?, val objectId: String?, val uploadId: String?, val partSize: Long?,
        val totalParts: Int?, val completedPartsJson: String?, val partUploadAuth: String?, val attempts: Int, val nextAttemptAt: Long?,
    )

    private fun read(id: Long): Row = conn.prepareStatement(
        "SELECT state, contentHash, objectId, uploadId, partSize, totalParts, completedPartsJson, partUploadAuth, attempts, nextAttemptAt " +
            "FROM sync_files WHERE id = ?",
    ).use { ps ->
        ps.setLong(1, id)
        ps.executeQuery().use { rs ->
            check(rs.next()) { "row $id is gone" }
            Row(
                state = rs.getString(1),
                contentHash = rs.getString(2),
                objectId = rs.getString(3),
                uploadId = rs.getString(4),
                partSize = rs.getObject(5)?.let { (it as Number).toLong() },
                totalParts = rs.getObject(6)?.let { (it as Number).toInt() },
                completedPartsJson = rs.getString(7),
                partUploadAuth = rs.getString(8),
                attempts = rs.getInt(9),
                nextAttemptAt = rs.getObject(10)?.let { (it as Number).toLong() },
            )
        }
    }

    private fun schema(version: Int): JsonObject {
        val name = "memoriahub.marin.cr.ledger.MediaSyncDatabase/$version.json"
        val file = listOf(File("schemas/$name"), File("app/schemas/$name")).firstOrNull { it.isFile }
            ?: error("exported Room schema $name not found (working dir ${File(".").absolutePath})")
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun identityHash(schema: JsonObject): String =
        schema.getValue("database").jsonObject.getValue("identityHash").jsonPrimitive.content

    private fun syncFilesCreateSql(schema: JsonObject): String {
        val entity = schema.getValue("database").jsonObject.getValue("entities").jsonArray
            .map { it.jsonObject }
            .single { it.getValue("tableName").jsonPrimitive.content == "sync_files" }
        return entity.getValue("createSql").jsonPrimitive.content.replace("\${TABLE_NAME}", "sync_files")
    }
}
