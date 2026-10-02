package memoriahub.marin.cr.ledger

import androidx.room.TypeConverter

/** [SyncFileState] is stored by name, so raw SQL (`state = 'FAILED'`) reads naturally. */
class LedgerConverters {
    @TypeConverter
    fun stateToString(state: SyncFileState): String = state.name

    @TypeConverter
    fun stringToState(value: String): SyncFileState = SyncFileState.valueOf(value)
}
