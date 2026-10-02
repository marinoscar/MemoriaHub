// file: contract/HealthSummary.kt   (implemented by #514 as diagnostics/DiagnosticsHealth)
package memoriahub.marin.cr.contract

import kotlinx.coroutines.flow.StateFlow

data class HealthLine(val passCount: Int, val warnCount: Int, val failCount: Int, val ranAtMs: Long?) {
    val problems: Int get() = warnCount + failCount
}

interface HealthSummary {
    val line: StateFlow<HealthLine?>
    suspend fun refresh()          // run the self-test quietly
}
