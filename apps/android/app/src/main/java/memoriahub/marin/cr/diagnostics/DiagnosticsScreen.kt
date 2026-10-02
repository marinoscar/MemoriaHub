package memoriahub.marin.cr.diagnostics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

// TEMP(#513) replaced at merge by #514: the real Diagnostics screen (self-test, check rows, recent
// runs, live log, report upload/share, reset) is issue #514's. Only the signature is binding.

@Composable
fun DiagnosticsScreen(onBack: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Diagnostics are not available in this build yet.")
        OutlinedButton(onClick = onBack) { Text("Back to Media sync") }
    }
}
