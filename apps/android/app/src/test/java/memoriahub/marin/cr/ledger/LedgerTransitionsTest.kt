package memoriahub.marin.cr.ledger

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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LedgerTransitionsTest {
    /** docs/specs/android-media-sync.md §8.2, transcribed independently of the implementation. */
    private val spec: Map<String, List<Pair<SyncFileState, SyncFileState>>> = mapOf(
        "T2" to listOf(DISCOVERED to QUEUED),
        "T3" to listOf(DISCOVERED to EXCLUDED),
        "T4" to listOf(QUEUED to HASHING),
        "T5" to listOf(FAILED to HASHING),
        "T6" to listOf(HASHING to UPLOADING),
        "T7" to listOf(HASHING to DEDUPLICATED),
        "T8" to listOf(UPLOADING to UPLOADING),
        "T9" to listOf(UPLOADING to REGISTERING),
        "T10" to listOf(REGISTERING to UPLOADED),
        "T11" to listOf(REGISTERING to DEDUPLICATED),
        "T12" to listOf(HASHING to FAILED, UPLOADING to FAILED, REGISTERING to FAILED),
        "T13" to listOf(HASHING to BLOCKED, UPLOADING to BLOCKED, REGISTERING to BLOCKED),
        "T14" to listOf(HASHING to QUEUED),
        "T15" to listOf(FAILED to QUEUED, BLOCKED to QUEUED),
        "T16" to listOf(UPLOADED to QUEUED, DEDUPLICATED to QUEUED),
        "T17" to listOf(QUEUED to EXCLUDED, FAILED to EXCLUDED, BLOCKED to EXCLUDED, HASHING to EXCLUDED, UPLOADING to EXCLUDED),
        "T18" to listOf(EXCLUDED to QUEUED),
    )

    @Test fun `every legal transition of the spec table is allowed and labelled`() {
        for ((label, pairs) in spec) {
            for ((from, to) in pairs) {
                assertTrue("$label $from -> $to", LedgerTransitions.isLegal(from, to))
                assertEquals("$from -> $to", label, LedgerTransitions.legal[from to to])
                assertTrue(LedgerTransitions.enforce(from, to, strict = true))
            }
        }
    }

    @Test fun `every other transition is illegal - throws when strict, logs and reports false otherwise`() {
        val legal = spec.values.flatten().toSet()
        assertEquals(legal, LedgerTransitions.legal.keys)
        var illegal = 0
        for (from in SyncFileState.entries) for (to in SyncFileState.entries) {
            if ((from to to) in legal) continue
            illegal++
            assertFalse("$from -> $to", LedgerTransitions.isLegal(from, to))
            assertFalse(LedgerTransitions.enforce(from, to, strict = false))
            try {
                LedgerTransitions.enforce(from, to, strict = true)
                fail("$from -> $to should throw")
            } catch (e: IllegalLedgerTransition) {
                assertEquals(from, e.from)
                assertEquals(to, e.to)
            }
        }
        assertEquals(100 - legal.size, illegal)
    }

    @Test fun `T1 inserts only as DISCOVERED`() {
        assertTrue(LedgerTransitions.isLegalInsert(DISCOVERED))
        SyncFileState.entries.filter { it != DISCOVERED }.forEach { assertFalse(LedgerTransitions.isLegalInsert(it)) }
    }

    @Test fun `T19 deletes only rows whose bytes are not complete`() {
        val deletable = setOf(DISCOVERED, QUEUED, FAILED, BLOCKED, EXCLUDED, HASHING, UPLOADING)
        for (state in SyncFileState.entries) {
            assertEquals(state.name, state in deletable, LedgerTransitions.isLegalDelete(state))
        }
        for (state in listOf(REGISTERING, UPLOADED, DEDUPLICATED)) {
            assertFalse(LedgerTransitions.enforceDelete(state, strict = false))
            try {
                LedgerTransitions.enforceDelete(state, strict = true)
                fail("delete from $state should throw")
            } catch (_: IllegalLedgerTransition) {
            }
        }
    }

    @Test fun `debug unit tests enforce strictly by default`() {
        try {
            LedgerTransitions.enforce(UPLOADED, UPLOADING)
            fail("default strictness is BuildConfig.DEBUG (true in debug unit tests)")
        } catch (_: IllegalLedgerTransition) {
        }
    }

    @Test fun `terminal states leave only through T16`() {
        for (state in LedgerTransitions.terminal) {
            val exits = LedgerTransitions.legal.keys.filter { it.first == state }.map { it.second }
            assertEquals(listOf(QUEUED), exits)
        }
    }
}
