package cr.marin.memoriahub.ui.auth

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cr.marin.memoriahub.R

@Composable
fun DeviceAuthScreen(
    modifier: Modifier = Modifier,
    viewModel: DeviceAuthViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    fun openBrowser(url: String) {
        CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url))
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            painter = painterResource(R.drawable.app_logo),
            contentDescription = "MemoriaHub",
            modifier = Modifier
                .height(96.dp)
                .padding(bottom = 24.dp),
        )

        Text("Sign in", style = MaterialTheme.typography.headlineMedium)

        when (state.status) {
            DeviceAuthStatus.Requesting -> {
                Spinner("Requesting a sign-in code…")
            }

            DeviceAuthStatus.AwaitingApproval -> {
                Text(
                    "Open the authorization page and confirm this code to link this device:",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 16.dp, bottom = 16.dp),
                )
                Card(modifier = Modifier.padding(vertical = 8.dp)) {
                    Text(
                        text = state.userCode.orEmpty(),
                        fontSize = 36.sp,
                        letterSpacing = 6.sp,
                        style = MaterialTheme.typography.headlineLarge,
                        modifier = Modifier.padding(horizontal = 32.dp, vertical = 20.dp),
                    )
                }
                Button(
                    onClick = {
                        state.verificationUriComplete?.let { openBrowser(it) }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 24.dp),
                ) {
                    Text("Open browser to authorize")
                }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = 24.dp),
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(18.dp)
                            .padding(end = 8.dp),
                        strokeWidth = 2.dp,
                    )
                    Text(
                        "Waiting for approval…",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            DeviceAuthStatus.Authorizing -> {
                Spinner("Signing you in…")
            }

            DeviceAuthStatus.Failed -> {
                Text(
                    state.error ?: "Sign-in failed",
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
                OutlinedButton(onClick = viewModel::retry) {
                    Text("Try again")
                }
            }
        }
    }
}

@Composable
private fun Spinner(label: String) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.padding(top = 32.dp),
    ) {
        CircularProgressIndicator()
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 16.dp),
        )
    }
}
