package memoriahub.marin.cr.ledger

import memoriahub.marin.cr.BuildConfig
import memoriahub.marin.cr.diagnostics.AppLog
import memoriahub.marin.cr.ledger.SyncFileState.BLOCKED
import memoriahub.marin.cr.ledger.SyncFileState.DEDUPLICATED
import memoriahub.marin.cr.ledger.SyncFileState.DISCOVERED
import memoriahub.marin.cr.ledger.SyncFileState.EXCLUDED
import memoriahub.marin.cr.ledger.SyncFileState.FAILED
import memoriahub.marin.cr.ledger.SyncFileState.HASHING
import memoriahub.marin.cr.ledger.SyncFileState.QUEUED
import memoriahub.marin.cr.ledger.SyncFileState.REGISTERING
import memoriahub.marin.cr.ledger.SyncFileState.UPLOADED
import memoriahub.marin.cr.ledger.SyncFileState.UPLOADING

/** Thrown (debug builds) for a status write the state machine does not allow. */
class IllegalLedgerTransition(val from: SyncFileState?, val to: SyncFileState?) :
    IllegalStateException("illegal ledger transition ${from ?: "(new)"} -> ${to ?: "(deleted)"}")

/**
 * The ledger state machine of docs/specs/android-media-sync.md §8.2 (T1–T19), as data. Every status
 * write in [LedgerRepository] and [RoomUploadLedger] goes through [enforce]; anything not in the
 * table is illegal: it throws in debug builds (and unit tests) and is logged in release builds,
 * where the write still happens so a bug never wedges a user's sync.
 */
object LedgerTransitions {
    /** `from` → `to` pairs, labelled with the spec's transition number. */
    val legal: Map<Pair<SyncFileState, SyncFileState>, String> = buildMap {
        put(DISCOVERED to QUEUED, "T2")
        put(DISCOVERED to EXCLUDED, "T3")
        put(QUEUED to HASHING, "T4")
        put(FAILED to HASHING, "T5")
        put(HASHING to UPLOADING, "T6")
        put(HASHING to DEDUPLICATED, "T7")
        put(UPLOADING to UPLOADING, "T8")
        put(UPLOADING to REGISTERING, "T9")
        put(REGISTERING to UPLOADED, "T10")
        put(REGISTERING to DEDUPLICATED, "T11")
        for (from in listOf(HASHING, UPLOADING, REGISTERING)) {
            put(from to FAILED, "T12")
            put(from to BLOCKED, "T13")
        }
        put(HASHING to QUEUED, "T14")
        put(FAILED to QUEUED, "T15")
        put(BLOCKED to QUEUED, "T15")
        put(UPLOADED to QUEUED, "T16")
        put(DEDUPLICATED to QUEUED, "T16")
        for (from in listOf(QUEUED, FAILED, BLOCKED, HASHING, UPLOADING)) put(from to EXCLUDED, "T17")
        put(EXCLUDED to QUEUED, "T18")
    }

    /** T19: a vanished file may be removed only in these states (never once its bytes are complete). */
    val deletable: Set<SyncFileState> = setOf(DISCOVERED, QUEUED, FAILED, BLOCKED, EXCLUDED, HASHING, UPLOADING)

    /** Terminal for upload: they leave only through T16. */
    val terminal: Set<SyncFileState> = setOf(UPLOADED, DEDUPLICATED)

    /** States [LedgerPolicy.reevaluate] may move to `EXCLUDED` (T17). */
    val excludable: Set<SyncFileState> = setOf(QUEUED, FAILED, BLOCKED, HASHING, UPLOADING)

    /** T1: a new row is born `DISCOVERED`. */
    fun isLegalInsert(state: SyncFileState): Boolean = state == DISCOVERED

    fun isLegal(from: SyncFileState, to: SyncFileState): Boolean = (from to to) in legal

    fun isLegalDelete(state: SyncFileState): Boolean = state in deletable

    /** Validates `from` → `to`; returns whether it was legal. */
    fun enforce(from: SyncFileState, to: SyncFileState, strict: Boolean = BuildConfig.DEBUG): Boolean =
        check(isLegal(from, to), from, to, strict)

    fun enforceDelete(state: SyncFileState, strict: Boolean = BuildConfig.DEBUG): Boolean =
        check(isLegalDelete(state), state, null, strict)

    private fun check(ok: Boolean, from: SyncFileState?, to: SyncFileState?, strict: Boolean): Boolean {
        if (ok) return true
        val error = IllegalLedgerTransition(from, to)
        if (strict) throw error
        AppLog.e("Ledger", "ledger.transition.illegal from=${from ?: "new"} to=${to ?: "deleted"}")
        return false
    }
}
