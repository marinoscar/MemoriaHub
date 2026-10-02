package memoriahub.marin.cr.twa

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.google.androidbrowserhelper.trusted.LauncherActivity
import memoriahub.marin.cr.BuildConfig
import memoriahub.marin.cr.MobileApplication
import memoriahub.marin.cr.config.ServerUrls
import memoriahub.marin.cr.setup.SetupActivity

/**
 * Launcher entry point: opens the MemoriaHub PWA full-screen in a Trusted Web Activity at
 * `${server}/?source=twa&appVersion=…&appVersionCode=…` ([ServerUrls.twaLaunchUrl]).
 * When no server is configured yet it shows [SetupActivity] instead.
 *
 * The manifest's DEFAULT_URL is only a placeholder; the real URL comes from [MobileApplication.serverConfig],
 * so one APK works against any deployment (the server publishes `/.well-known/assetlinks.json`
 * for this app's signing key, which is what removes the URL bar).
 *
 * The launcher icon targets the stable `${applicationId}.TwaLauncherActivity` activity-alias, not
 * this class directly, so moving or renaming this class never orphans a home-screen icon.
 *
 * Why this class lives in the `twa` sub-package: the Kotlin namespace equals the release
 * applicationId (`memoriahub.marin.cr`), so a class at `memoriahub.marin.cr.TwaLauncherActivity`
 * would have the SAME component name as the alias in the release build. Duplicate component
 * names are a malformed manifest; the sub-package keeps the alias name (the part launchers and
 * shortcuts remember) exactly as the spec defines it.
 */
class TwaLauncherActivity : LauncherActivity() {
    private val serverUrl: String? by lazy { MobileApplication.from(this).serverConfig.serverUrl }

    override fun shouldLaunchImmediately(): Boolean = serverUrl != null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // super.onCreate may already have finished (e.g. a duplicate launcher instance).
        if (serverUrl == null && !isFinishing) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        if (savedInstanceState == null) {
            MobileApplication.from(this).onAppOpen()
        }
    }

    override fun getLaunchingUrl(): Uri {
        val server = serverUrl ?: return super.getLaunchingUrl()
        return Uri.parse(ServerUrls.twaLaunchUrl(server, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong()))
    }
}
