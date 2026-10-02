package memoriahub.marin.cr.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ledger.CompletedPart
import memoriahub.marin.cr.ledger.LedgerFile
import memoriahub.marin.cr.ledger.SyncFileState
import memoriahub.marin.cr.ledger.UploadLedger
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.ApiError
import memoriahub.marin.cr.net.ApiResult
import memoriahub.marin.cr.net.CompleteUploadPart
import memoriahub.marin.cr.net.CreateMediaRequest
import memoriahub.marin.cr.net.InitUploadRequest
import memoriahub.marin.cr.net.MediaUploadApi
import memoriahub.marin.cr.net.UploadReasons
import memoriahub.marin.cr.net.UploadStatusResponse
import memoriahub.marin.cr.pairing.ApiErrorReaction
import memoriahub.marin.cr.pairing.ApiErrorReactions
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

/**
 * The resumable upload engine (docs/specs/android-media-sync.md §9, issue #511).
 *
 * One [run] drains the ledger: [UploadLedger.nextBatch] (resumable `UPLOADING`/`REGISTERING`
 * first, D9) feeds [parallelism] workers (2 by default, supervised so one file's failure never
 * cancels the other); parts within a file are sequential. Per file:
 *
 * 1. **Hash** — streaming SHA-256 of the same URI form the upload reads (D24); skipped when
 *    the ledger already holds a hash (the ledger clears it when the file changes, T16).
 * 2. **Dedup pre-check** — `GET /api/media?circleId&contentHash&pageSize=1` (no `page`, D15);
 *    a hit makes the row `DEDUPLICATED` without sending a byte (T7).
 * 3. **Resume or init** — an existing session is confirmed with `upload/status` (D16): `404`,
 *    `403` or `failed` → abort best effort and re-init; `processing`/`ready` → straight to
 *    registration; `pending`/`uploading` → resume with the LOCAL part list (authoritative —
 *    S3 records parts only at `complete`). A new session is persisted with
 *    [UploadLedger.startUpload] BEFORE any byte is sent (T6).
 * 4. **Parts** — URLs in batches of [urlBatchSize] (the init batch, then `part-urls`, ≤ 100);
 *    each part streams from [ContentSource] at its offset (constant memory) and is persisted
 *    with [UploadLedger.recordPart] the moment its `ETag` arrives. Before every part the
 *    [NetworkPolicy] and the stop signal are re-checked: a metered network under "Wi-Fi only"
 *    stops the run cleanly with [UploadStopReason.NETWORK_POLICY], no attempt counted (T8).
 * 5. **Complete** — `409 UPLOAD_PARTS_MISSING` drops `details.partNumbers` locally and re-sends
 *    only those; any other `409` (`UPLOAD_SESSION_INVALID`, D18) aborts and re-inits.
 * 6. **Register** — `POST /api/media` (`source: 'android'`): `201` → `UPLOADED`, `200`
 *    `deduplicated` → `DEDUPLICATED`.
 *
 * Every failed API call is routed through [errorReactions] first (401 → pairing expired,
 * `409 DEVICE_REVOKED` → pairing forgotten); when it reacts, the whole run stops and the row is
 * left untouched. Everything else is classified by [UploadErrorPolicy] (§9.5).
 *
 * Logging: file id, sizes, part numbers and HTTP status only — never a URL, a token, a file
 * name or a path (§9.6).
 */
class UploadEngine(
    private val ledger: UploadLedger,
    private val api: MediaUploadApi,
    private val partUploader: PartUploader,
    private val source: ContentSource,
    private val networkPolicy: NetworkPolicy,
    private val errorReactions: ApiErrorReactions,
    private val clock: () -> Long = System::currentTimeMillis,
    private val retryDelay: suspend (Long) -> Unit = { delay(it) },
    private val parallelism: Int = DEFAULT_PARALLELISM,
    private val batchSize: Int = DEFAULT_BATCH_SIZE,
    private val urlBatchSize: Int = DEFAULT_URL_BATCH,
    private val maxPartTries: Int = DEFAULT_PART_TRIES,
    private val logger: (String) -> Unit = { AppLog.i(TAG, it) },
) {
    private val _progress = MutableStateFlow<UploadProgress?>(null)

    /** Latest progress of the current (or last) run; null before the first byte. */
    val progress: StateFlow<UploadProgress?> = _progress.asStateFlow()

    /**
     * Uploads every file the ledger offers until the queue is empty, [maxFiles] files were
     * claimed, [shouldStop] answers true (pause, WorkManager `isStopped`, FGS timeout), or a
     * run-wide failure stops it. Cancelling the calling coroutine also stops it; rows keep their
     * state and parts either way, so the next run resumes where this one left off.
     *
     * [expectedFiles] (e.g. the ledger's pending count) only seeds [UploadProgress.filesTotal].
     */
    suspend fun run(
        target: UploadTarget,
        shouldStop: () -> Boolean = { false },
        maxFiles: Int = Int.MAX_VALUE,
        expectedFiles: Int = 0,
    ): UploadRunResult {
        val run = RunState(target, shouldStop, maxFiles, expectedFiles)
        logger("upload.run.start parallelism=$parallelism")
        supervisorScope {
            repeat(parallelism.coerceAtLeast(1)) {
                launch {
                    while (true) {
                        if (run.stopRequested()) break
                        val file = run.claim() ?: break
                        val outcome = process(file, run)
                        record(file, outcome, run)
                    }
                }
            }
        }
        val result = run.result()
        logger(
            "upload.run.end uploaded=${result.uploaded} dedup=${result.deduplicated} failed=${result.failed} " +
                "blocked=${result.blocked} vanished=${result.vanished} bytes=${result.bytesUploaded} " +
                "stop=${result.stopReason ?: "none"}",
        )
        return result
    }

    // ---------------------------------------------------------------------------------------
    // Run bookkeeping

    private inner class RunState(
        val target: UploadTarget,
        private val shouldStop: () -> Boolean,
        private val maxFiles: Int,
        private val expectedFiles: Int,
    ) {
        private val mutex = Mutex()
        private val queue = ArrayDeque<LedgerFile>()
        private val seen = HashSet<Long>()
        private var exhausted = false
        private var claimed = 0

        @Volatile var stopReason: UploadStopReason? = null
            private set

        var uploaded = 0
        var deduplicated = 0
        var failed = 0
        var blocked = 0
        var bytesUploaded = 0L
        var filesDone = 0
        var consecutiveNetworkFailures = 0
        val bytesSent = java.util.concurrent.atomic.AtomicLong(0)
        val failedSample = ArrayList<FailedFileSample>()
        val vanishedIds = ArrayList<Long>()
        private var lastProgressAt = 0L

        fun stop(reason: UploadStopReason) {
            synchronized(this) { if (stopReason == null) stopReason = reason }
        }

        fun stopRequested(): Boolean {
            if (stopReason != null) return true
            if (shouldStop()) {
                stop(UploadStopReason.STOPPED)
                return true
            }
            return false
        }

        suspend fun claim(): LedgerFile? = mutex.withLock {
            if (stopReason != null || claimed >= maxFiles) return@withLock null
            if (queue.isEmpty() && !exhausted) {
                // nextBatch returns in-flight UPLOADING rows again: over-fetch by what this run
                // has already claimed so they can never crowd out the rest of the queue.
                val limit = batchSize + minOf(seen.size, MAX_SEEN_OVERFETCH)
                val batch = ledger.nextBatch(limit, clock()).filter { it.id !in seen }
                if (batch.isEmpty()) exhausted = true else queue.addAll(batch)
            }
            val next = queue.removeFirstOrNull() ?: return@withLock null
            seen += next.id
            claimed++
            next
        }

        val filesTotal: Int get() = maxOf(expectedFiles, claimed)

        fun progress(file: LedgerFile, sent: Long, force: Boolean = false) {
            val now = clock()
            synchronized(this) {
                if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return
                lastProgressAt = now
            }
            _progress.value = UploadProgress(file.displayName, sent, file.sizeBytes, filesDone, filesTotal)
        }

        fun result(): UploadRunResult = synchronized(this) {
            UploadRunResult(
                uploaded = uploaded,
                deduplicated = deduplicated,
                failed = failed,
                blocked = blocked,
                vanished = vanishedIds.size,
                bytesUploaded = bytesUploaded,
                bytesSent = bytesSent.get(),
                filesProcessed = filesDone,
                failedSample = failedSample.toList(),
                vanishedIds = vanishedIds.toList(),
                stopReason = stopReason,
            )
        }
    }

    private sealed interface Outcome {
        data class Uploaded(val mediaItemId: String?) : Outcome
        data class Deduplicated(val mediaItemId: String?) : Outcome
        data class Failed(val code: String, val message: String, val retryable: Boolean, val network: Boolean = false) : Outcome
        data class Stopped(val reason: UploadStopReason) : Outcome
        data object Vanished : Outcome

        /** The row left the upload path mid-file (excluded, T17, or vanished, T19): nothing to write. */
        data object Abandoned : Outcome
    }

    /** Ends one file's pipeline with [outcome] (internal control flow, no stack trace). */
    private class Halt(val outcome: Outcome) : RuntimeException(null, null, false, false)

    /** The multipart session is gone or unusable: abort, clear and re-init. */
    private class SessionReset(val why: String) : RuntimeException(null, null, false, false)

    private suspend fun record(file: LedgerFile, outcome: Outcome, run: RunState) {
        try {
            when (outcome) {
                is Outcome.Uploaded -> synchronized(run) {
                    run.uploaded++
                    run.bytesUploaded += file.sizeBytes
                    run.consecutiveNetworkFailures = 0
                }
                is Outcome.Deduplicated -> synchronized(run) {
                    run.deduplicated++
                    run.consecutiveNetworkFailures = 0
                }
                is Outcome.Failed -> {
                    ledger.markFailed(file.id, outcome.message.take(UploadRunResult.MAX_LAST_ERROR), outcome.code, outcome.retryable, clock())
                    val attempts = file.attempts + 1
                    val blocked = !outcome.retryable || UploadBackoff.blocks(attempts)
                    logger("upload.file.failed file=${file.id} code=${outcome.code} attempts=$attempts blocked=$blocked")
                    var stopForNetwork = false
                    synchronized(run) {
                        run.failed++
                        if (blocked) run.blocked++
                        if (run.failedSample.size < UploadRunResult.MAX_FAILED_SAMPLE) {
                            run.failedSample += FailedFileSample(
                                name = file.displayName,
                                relativePath = file.relativePath,
                                sizeBytes = file.sizeBytes,
                                attempts = attempts,
                                lastError = "${outcome.code}: ${outcome.message}".take(UploadRunResult.MAX_LAST_ERROR),
                            )
                        }
                        if (outcome.network) {
                            run.consecutiveNetworkFailures++
                            stopForNetwork = run.consecutiveNetworkFailures >= NETWORK_FAILURES_TO_STOP
                        } else {
                            run.consecutiveNetworkFailures = 0
                        }
                    }
                    // A dead server would otherwise burn one attempt on every queued file.
                    if (stopForNetwork) run.stop(UploadStopReason.SERVER_UNREACHABLE)
                }
                is Outcome.Vanished -> {
                    ledger.markFailed(file.id, "The file is no longer on the device", CODE_FILE_NOT_FOUND, false, clock())
                    logger("upload.file.vanished file=${file.id}")
                    synchronized(run) { run.vanishedIds += file.id }
                }
                is Outcome.Abandoned -> logger("upload.file.abandoned file=${file.id}")
                is Outcome.Stopped -> {
                    logger("upload.file.stopped file=${file.id} reason=${outcome.reason}")
                    run.stop(outcome.reason)
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            AppLog.w(TAG, "upload.ledger.error file=${file.id}", e)
        } finally {
            if (outcome !is Outcome.Stopped) {
                synchronized(run) { run.filesDone++ }
                run.progress(file, if (outcome is Outcome.Uploaded) file.sizeBytes else 0, force = true)
            }
        }
    }

    private suspend fun process(file: LedgerFile, run: RunState): Outcome = try {
        FileJob(file, run).execute()
    } catch (h: Halt) {
        h.outcome
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        AppLog.w(TAG, "upload.file.unexpected file=${file.id}", e)
        Outcome.Failed(CODE_UNEXPECTED, e.javaClass.simpleName + (e.message?.let { ": $it" } ?: ""), retryable = true)
    }

    // ---------------------------------------------------------------------------------------
    // One file

    private inner class FileJob(private val file: LedgerFile, private val run: RunState) {
        private var phase: SyncFileState = file.state
        private var contentHash: String? = file.contentHash
        private var objectId: String? = file.objectId
        private var uploadId: String? = file.uploadId
        private var partSize: Long? = file.partSize
        private var totalParts: Int? = file.totalParts
        private val parts = sortedMapOf<Int, String>().apply { file.completedParts.forEach { put(it.partNumber, it.eTag) } }
        private val urls = HashMap<Int, String>()
        private var auth: String? = null
        private var resets = 0
        private var sentForFile = 0L

        suspend fun execute(): Outcome {
            if (!networkPolicy.allowsUpload()) return Outcome.Stopped(UploadStopReason.NETWORK_POLICY)
            checkStop()
            logger("upload.file.start file=${file.id} size=${file.sizeBytes} state=${file.state} parts=${parts.size}")

            if (phase != SyncFileState.UPLOADING && phase != SyncFileState.REGISTERING) {
                // Every claimed QUEUED/FAILED row starts hashing (T4/T5), even with a stored hash.
                if (phase != SyncFileState.HASHING) {
                    ledger.markHashing(file.id)
                    phase = SyncFileState.HASHING
                }
                if (file.sizeBytes <= 0) return Outcome.Failed(CODE_EMPTY_FILE, "The file is empty", retryable = false)
                ensureHash()
                dedupCheck()?.let { mediaItemId ->
                    abandonOpenSession()
                    ledger.markDeduplicated(file.id, mediaItemId)
                    logger("upload.file.dedup file=${file.id} precheck=true")
                    return Outcome.Deduplicated(mediaItemId)
                }
            } else if (contentHash == null) {
                // A resumed row whose file changed under it lost its hash: hash before uploading.
                ensureHash()
            }

            while (true) {
                try {
                    if (phase == SyncFileState.REGISTERING) {
                        if (objectId == null) throw SessionReset("registering without a session")
                        return register()
                    }
                    resumeOrInit()?.let { return it }
                    uploadMissingParts()
                    complete()
                    ledger.markRegistering(file.id)
                    phase = SyncFileState.REGISTERING
                    return register()
                } catch (r: SessionReset) {
                    resetSession(r.why)
                }
            }
        }

        // -- hashing and dedup ----------------------------------------------------------------

        private suspend fun ensureHash() {
            if (contentHash != null) return
            val hash = try {
                withContext(Dispatchers.IO) {
                    ContentHasher.sha256(source, file.uri) { _ ->
                        if (run.stopRequested()) throw Halt(Outcome.Stopped(run.stopReason ?: UploadStopReason.STOPPED))
                        run.progress(file, 0)
                    }
                }
            } catch (h: Halt) {
                throw h
            } catch (e: java.io.FileNotFoundException) {
                throw Halt(Outcome.Vanished)
            } catch (e: SecurityException) {
                throw Halt(Outcome.Stopped(UploadStopReason.MEDIA_PERMISSION_MISSING))
            } catch (e: java.io.IOException) {
                throw Halt(Outcome.Failed(CODE_READ_ERROR, "Could not read the file (${e.javaClass.simpleName})", retryable = true))
            }
            ledger.saveHash(file.id, hash)
            contentHash = hash
            logger("upload.file.hashed file=${file.id}")
        }

        /** Returns the existing item's id when the target circle already has these bytes. */
        private suspend fun dedupCheck(): String? {
            val hash = contentHash ?: return null
            return when (val result = api.findByContentHash(run.target.circleId, hash)) {
                is ApiResult.Success -> result.value.items.firstOrNull()?.id
                is ApiResult.Failure -> fail(result.error, UploadStep.DEDUP_CHECK)
            }
        }

        // -- session ---------------------------------------------------------------------------

        /**
         * Confirms or creates the multipart session. Returns an outcome only when the file
         * finished here (the previous run completed the upload and died before registering).
         */
        private suspend fun resumeOrInit(): Outcome? {
            val existing = objectId
            if (existing == null || partSize == null || totalParts == null) {
                if (existing != null) throw SessionReset("incomplete session")
                init()
                return null
            }
            val status = when (val result = api.uploadStatus(existing)) {
                is ApiResult.Success -> result.value
                is ApiResult.Failure -> fail(result.error, UploadStep.STATUS)
            }
            when (status.status) {
                STATUS_PROCESSING, STATUS_READY -> {
                    logger("upload.file.resume file=${file.id} status=${status.status} -> register")
                    if (phase != SyncFileState.UPLOADING) restoreSessionInLedger()
                    ledger.markRegistering(file.id)
                    phase = SyncFileState.REGISTERING
                    return register()
                }
                STATUS_PENDING, STATUS_UPLOADING -> {
                    if (phase != SyncFileState.UPLOADING) restoreSessionInLedger()
                    logResume(status)
                    return null
                }
                else -> throw SessionReset("status ${status.status}")
            }
        }

        /** A `FAILED` row resuming its session: move it back to `UPLOADING` with its parts (T5 → T6). */
        private suspend fun restoreSessionInLedger() {
            ledger.startUpload(file.id, objectId!!, uploadId, partSize!!, totalParts!!)
            ledger.replaceParts(file.id, parts.map { (n, tag) -> CompletedPart(n, tag) })
            phase = SyncFileState.UPLOADING
        }

        private fun logResume(status: UploadStatusResponse) {
            logger(
                "upload.file.resume file=${file.id} localParts=${parts.size} serverParts=${status.uploadedParts.size} " +
                    "totalParts=$totalParts",
            )
        }

        private suspend fun init() {
            val request = InitUploadRequest(
                name = file.displayName.take(MAX_NAME).ifBlank { "media-${file.id}" },
                size = file.sizeBytes,
                mimeType = file.mimeType.ifBlank { "application/octet-stream" },
            )
            val response = when (val result = api.initUpload(request)) {
                is ApiResult.Success -> result.value
                is ApiResult.Failure -> fail(result.error, UploadStep.INIT)
            }
            if (response.partSize <= 0 || response.totalParts <= 0) {
                throw Halt(Outcome.Failed(CODE_BAD_RESPONSE, "The server returned an invalid upload session", retryable = true))
            }
            // Persist BEFORE any byte is sent (T6): a kill from here on resumes, never re-inits.
            ledger.startUpload(file.id, response.objectId, response.uploadId, response.partSize, response.totalParts)
            phase = SyncFileState.UPLOADING
            objectId = response.objectId
            uploadId = response.uploadId
            partSize = response.partSize
            totalParts = response.totalParts
            parts.clear()
            urls.clear()
            auth = response.partUploadAuth
            ledger.savePartUploadAuth(file.id, response.partUploadAuth ?: PartUploadAuth.NONE)
            response.presignedUrls.forEach { urls[it.partNumber] = it.url }
            logger(
                "upload.file.init file=${file.id} size=${file.sizeBytes} partSize=${response.partSize} " +
                    "totalParts=${response.totalParts} auth=${response.partUploadAuth ?: PartUploadAuth.NONE}",
            )
        }

        private suspend fun resetSession(why: String) {
            resets++
            logger("upload.file.session_reset file=${file.id} reason=$why resets=$resets")
            abandonOpenSession()
            ledger.resetUploadSession(file.id)
            objectId = null
            uploadId = null
            partSize = null
            totalParts = null
            parts.clear()
            urls.clear()
            auth = null
            // REGISTERING may not go back to UPLOADING (§8.2): let the next attempt re-init.
            if (phase == SyncFileState.REGISTERING) {
                throw Halt(Outcome.Failed(CODE_SESSION_LOST, "The uploaded object is gone; it will be uploaded again", retryable = true))
            }
            if (resets > MAX_SESSION_RESETS) {
                throw Halt(Outcome.Failed(CODE_SESSION_LOST, "The upload session kept failing ($why)", retryable = true))
            }
        }

        /** `DELETE …/upload/abort`, best effort — but never for a completed object (abort deletes the row). */
        private suspend fun abandonOpenSession() {
            val id = objectId ?: return
            if (phase == SyncFileState.REGISTERING) return
            val status = (api.uploadStatus(id) as? ApiResult.Success)?.value?.status
            if (status == STATUS_PROCESSING || status == STATUS_READY) return
            val result = api.abortUpload(id)
            if (result is ApiResult.Failure) {
                val reaction = errorReactions.handle(result.error)
                if (reaction != ApiErrorReaction.NONE) throw Halt(Outcome.Stopped(reaction.toStopReason()))
            }
        }

        // -- parts ----------------------------------------------------------------------------

        private suspend fun uploadMissingParts() {
            val total = totalParts ?: throw SessionReset("no session")
            val size = partSize ?: throw SessionReset("no session")
            val missing = (1..total).filter { it !in parts }
            sentForFile = parts.keys.sumOf { partLength(it, size) }
            for (n in missing) {
                checkStop()
                if (!networkPolicy.allowsUpload()) throw Halt(Outcome.Stopped(UploadStopReason.NETWORK_POLICY))
                // Excluded or vanished meanwhile: the ledger ignores our writes, so stop here.
                if (!ledger.isActive(file.id)) throw Halt(Outcome.Abandoned)
                uploadPart(n, size, missing)
            }
        }

        private fun partLength(n: Int, size: Long): Long {
            val offset = (n - 1).toLong() * size
            return minOf(size, file.sizeBytes - offset).coerceAtLeast(0)
        }

        private suspend fun uploadPart(n: Int, size: Long, missing: List<Int>) {
            val offset = (n - 1).toLong() * size
            val length = partLength(n, size)
            if (length <= 0) throw SessionReset("part $n out of range")
            var tries = 0
            var refetched = false
            while (true) {
                tries++
                val url = urlFor(n, missing)
                val bearer = auth == PartUploadAuth.BEARER
                val before = sentForFile
                val result = partUploader.put(url, auth, source, file.uri, offset, length) { chunk ->
                    sentForFile += chunk
                    run.bytesSent.addAndGet(chunk)
                    run.progress(file, sentForFile)
                }
                when (result) {
                    is PartPutResult.Uploaded -> {
                        ledger.recordPart(file.id, CompletedPart(n, result.eTag))
                        parts[n] = result.eTag
                        sentForFile = before + length
                        logger("upload.part.ok file=${file.id} part=$n/${totalParts} bytes=$length")
                        return
                    }
                    is PartPutResult.Source -> {
                        val e = result.error
                        throw Halt(
                            when {
                                e.isMissing -> Outcome.Vanished
                                e.isPermissionDenied -> Outcome.Stopped(UploadStopReason.MEDIA_PERMISSION_MISSING)
                                e.isTruncated -> Outcome.Failed(CODE_FILE_CHANGED, "The file changed while it was uploading", retryable = false)
                                else -> Outcome.Failed(CODE_READ_ERROR, "Could not read the file", retryable = true)
                            },
                        )
                    }
                    PartPutResult.MissingETag -> {
                        sentForFile = before
                        logger("upload.part.no_etag file=${file.id} part=$n")
                        throw Halt(Outcome.Failed(CODE_MISSING_ETAG, "Storage accepted part $n without an ETag", retryable = true))
                    }
                    is PartPutResult.Network -> {
                        sentForFile = before
                        logger("upload.part.network file=${file.id} part=$n try=$tries")
                        if (!networkPolicy.allowsUpload()) throw Halt(Outcome.Stopped(UploadStopReason.NETWORK_POLICY))
                        if (tries < maxPartTries) {
                            retryDelay(partBackoffMs(tries))
                            continue
                        }
                        throw Halt(Outcome.Failed(CODE_NETWORK, "Network error while uploading part $n", retryable = true, network = true))
                    }
                    is PartPutResult.Http -> {
                        sentForFile = before
                        logger("upload.part.http file=${file.id} part=$n status=${result.status} try=$tries")
                        // An expired presigned URL: fetch a fresh one once (§9.1 step 4).
                        if (!bearer && result.status == 403 && !refetched) {
                            refetched = true
                            tries--
                            urls.remove(n)
                            fetchUrls(listOf(n))
                            continue
                        }
                        val transient = result.status == 408 || result.status == 429 || result.status >= 500
                        if (transient && tries < maxPartTries) {
                            val retryAfterMs = result.retryAfterSeconds?.times(1000)
                            if (retryAfterMs == null || retryAfterMs <= MAX_INLINE_RETRY_AFTER_MS) {
                                retryDelay(retryAfterMs ?: partBackoffMs(tries))
                                continue
                            }
                        }
                        if (bearer) {
                            fail(ApiClient.parseError(result.status, result.body), UploadStep.PART_PUT)
                        }
                        when (val decision = UploadErrorPolicy.classifyStoragePut(result.status)) {
                            UploadDecision.ResetSession -> throw SessionReset("storage ${result.status}")
                            is UploadDecision.Retry -> throw Halt(Outcome.Failed(decision.code, "Storage returned HTTP ${result.status} for part $n", retryable = true))
                            is UploadDecision.Block -> throw Halt(Outcome.Failed(decision.code, "Storage returned HTTP ${result.status} for part $n", retryable = false))
                            is UploadDecision.StopRun -> throw Halt(Outcome.Stopped(decision.reason))
                        }
                    }
                }
            }
        }

        private suspend fun urlFor(n: Int, missing: List<Int>): String {
            urls[n]?.let { return it }
            val start = missing.indexOf(n).coerceAtLeast(0)
            val batch = missing.subList(start, minOf(missing.size, start + urlBatchSize.coerceIn(1, MAX_URLS_PER_CALL)))
                .ifEmpty { listOf(n) }
            fetchUrls(batch)
            return urls[n] ?: throw Halt(Outcome.Failed(CODE_BAD_RESPONSE, "The server returned no URL for part $n", retryable = true))
        }

        private suspend fun fetchUrls(partNumbers: List<Int>) {
            val id = objectId ?: throw SessionReset("no session")
            when (val result = api.partUrls(id, partNumbers)) {
                is ApiResult.Success -> {
                    result.value.partUploadAuth?.let { fresh ->
                        if (fresh != auth) ledger.savePartUploadAuth(file.id, fresh)
                        auth = fresh
                    }
                    result.value.presignedUrls.forEach { urls[it.partNumber] = it.url }
                }
                is ApiResult.Failure -> fail(result.error, UploadStep.PART_URLS)
            }
        }

        // -- complete and register ------------------------------------------------------------

        private suspend fun complete() {
            val id = objectId ?: throw SessionReset("no session")
            var rounds = 0
            while (true) {
                checkStop()
                val payload = parts.map { (n, tag) -> CompleteUploadPart(n, tag) }
                when (val result = api.completeUpload(id, payload)) {
                    is ApiResult.Success -> {
                        logger("upload.file.completed file=${file.id} parts=${payload.size}")
                        return
                    }
                    is ApiResult.Failure -> {
                        val error = result.error
                        if (error.httpStatus == 409 && error.reason == UploadReasons.UPLOAD_PARTS_MISSING) {
                            val missing = missingPartNumbers(error)
                            rounds++
                            logger("upload.file.parts_missing file=${file.id} parts=${missing.joinToString(",")} round=$rounds")
                            if (missing.isEmpty()) throw SessionReset("parts missing (unlisted)")
                            if (rounds > MAX_MISSING_PART_ROUNDS) {
                                throw Halt(Outcome.Failed(UploadReasons.UPLOAD_PARTS_MISSING, "The server kept rejecting uploaded parts", retryable = true))
                            }
                            missing.forEach { parts.remove(it); urls.remove(it) }
                            ledger.replaceParts(file.id, parts.map { (n, tag) -> CompletedPart(n, tag) })
                            uploadMissingParts()
                            continue
                        }
                        fail(error, UploadStep.COMPLETE)
                    }
                }
            }
        }

        private fun missingPartNumbers(error: ApiError): List<Int> =
            (error.details?.get("partNumbers") as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.intOrNull }
                ?.filter { it >= 1 }
                ?.distinct()
                .orEmpty()

        private suspend fun register(): Outcome {
            val id = objectId ?: throw SessionReset("no session")
            val request = CreateMediaRequest(
                storageObjectId = id,
                circleId = run.target.circleId,
                type = if (file.isVideo) "video" else "photo",
                originalFilename = file.displayName.take(MAX_ORIGINAL_FILENAME).ifBlank { "media-${file.id}" },
                contentHash = contentHash,
                capturedAt = file.dateTakenMs?.takeIf { it > 0 }?.let { Instant.ofEpochMilli(it).toString() },
                sourceDeviceId = run.target.sourceDeviceId,
                sourceDeviceName = run.target.sourceDeviceName?.take(MAX_DEVICE_NAME),
                sourcePath = sourcePath(file.relativePath, file.displayName),
            )
            return when (val result = api.createMedia(request)) {
                is ApiResult.Success -> {
                    val mediaItemId = result.value.mediaItemId ?: result.value.id
                    if (result.value.deduplicated || result.httpStatus == 200) {
                        ledger.markDeduplicated(file.id, mediaItemId)
                        logger("upload.file.dedup file=${file.id} precheck=false")
                        Outcome.Deduplicated(mediaItemId)
                    } else {
                        ledger.markUploaded(file.id, mediaItemId)
                        logger("upload.file.uploaded file=${file.id} size=${file.sizeBytes}")
                        Outcome.Uploaded(mediaItemId)
                    }
                }
                is ApiResult.Failure -> fail(result.error, UploadStep.REGISTER)
            }
        }

        // -- failure handling -----------------------------------------------------------------

        /**
         * Routes an authenticated API failure through the global reactions, then [UploadErrorPolicy].
         * Never returns: it ends the file ([Halt]) or restarts its session ([SessionReset]).
         */
        private fun fail(error: ApiError, step: UploadStep): Nothing {
            val reaction = errorReactions.handle(error)
            if (reaction != ApiErrorReaction.NONE) throw Halt(Outcome.Stopped(reaction.toStopReason()))
            val message = describe(error, step)
            when (val decision = UploadErrorPolicy.classify(error, step)) {
                is UploadDecision.StopRun -> throw Halt(Outcome.Stopped(decision.reason))
                UploadDecision.ResetSession -> throw SessionReset("${step.name} ${error.httpStatus ?: error.kind}")
                is UploadDecision.Block -> throw Halt(Outcome.Failed(decision.code, message, retryable = false))
                is UploadDecision.Retry -> {
                    // No network at all is the network policy's business, not a failed attempt.
                    if (decision.network && !networkPolicy.allowsUpload()) {
                        throw Halt(Outcome.Stopped(UploadStopReason.NETWORK_POLICY))
                    }
                    throw Halt(Outcome.Failed(decision.code, message, retryable = true, network = decision.network))
                }
            }
        }

        private fun describe(error: ApiError, step: UploadStep): String {
            val where = step.name.lowercase()
            return when (error.kind) {
                ApiError.Kind.HTTP -> "$where: HTTP ${error.httpStatus}${error.reason?.let { " $it" } ?: ""} ${error.message}".trim()
                else -> "$where: ${error.message}"
            }
        }

        private suspend fun checkStop() {
            currentCoroutineContext().ensureActive()
            if (run.stopRequested()) throw Halt(Outcome.Stopped(run.stopReason ?: UploadStopReason.STOPPED))
        }
    }

    private fun ApiErrorReaction.toStopReason(): UploadStopReason = when (this) {
        ApiErrorReaction.DEVICE_REVOKED -> UploadStopReason.DEVICE_REVOKED
        else -> UploadStopReason.PAIRING_EXPIRED
    }

    companion object {
        private const val TAG = "Upload"
        const val DEFAULT_PARALLELISM = 2
        const val DEFAULT_BATCH_SIZE = 10
        const val DEFAULT_URL_BATCH = 10
        const val DEFAULT_PART_TRIES = 3
        const val MAX_URLS_PER_CALL = 100
        private const val MAX_SEEN_OVERFETCH = 1_000
        const val MAX_SESSION_RESETS = 2
        const val MAX_MISSING_PART_ROUNDS = 2
        const val NETWORK_FAILURES_TO_STOP = 2
        const val PROGRESS_INTERVAL_MS = 500L
        const val MAX_INLINE_RETRY_AFTER_MS = 60_000L
        private const val MAX_NAME = 255
        private const val MAX_ORIGINAL_FILENAME = 1024
        private const val MAX_DEVICE_NAME = 256
        private const val MAX_SOURCE_PATH = 2048

        const val STATUS_PENDING = "pending"
        const val STATUS_UPLOADING = "uploading"
        const val STATUS_PROCESSING = "processing"
        const val STATUS_READY = "ready"

        const val CODE_FILE_NOT_FOUND = "FILE_NOT_FOUND"
        const val CODE_FILE_CHANGED = "FILE_CHANGED"
        const val CODE_READ_ERROR = "READ_ERROR"
        const val CODE_EMPTY_FILE = "EMPTY_FILE"
        const val CODE_NETWORK = "NETWORK_ERROR"
        const val CODE_MISSING_ETAG = "MISSING_ETAG"
        const val CODE_BAD_RESPONSE = "BAD_RESPONSE"
        const val CODE_SESSION_LOST = "UPLOAD_SESSION_LOST"
        const val CODE_UNEXPECTED = "UNEXPECTED"

        /** In-file retry delay for a part: 1 s, 2 s, 4 s… (the ledger backoff covers the rest). */
        fun partBackoffMs(tries: Int): Long = 1_000L shl (tries - 1).coerceIn(0, 4)

        /** `relativePath + displayName` (MediaStore's RELATIVE_PATH ends with a slash), ≤ 2048. */
        fun sourcePath(relativePath: String?, displayName: String): String {
            val dir = relativePath?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
            return (if (dir == null) displayName else "$dir/$displayName").take(MAX_SOURCE_PATH)
        }
    }
}
