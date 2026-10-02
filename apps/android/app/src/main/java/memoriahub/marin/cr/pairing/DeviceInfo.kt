package memoriahub.marin.cr.pairing

import android.content.Context
import android.os.Build
import memoriahub.marin.cr.deeplink.MediaSyncLinks
import memoriahub.marin.cr.net.ApiClient
import memoriahub.marin.cr.net.RegisterDeviceRequest
import memoriahub.marin.cr.util.AppInfo
import memoriahub.marin.cr.util.Brand
import java.time.ZoneId
import java.util.Locale

/**
 * What the phone tells the server about itself: the device-flow `clientInfo` and the device
 * registration body (docs/specs/android-media-sync.md §6.3, §6.7). The pure builders take every
 * input as a parameter so they are JVM-tested; the `Context` overloads read [Build] and [AppInfo].
 */
object DeviceInfo {
    /** `name`, `manufacturer`, `model`, `androidVersion` (server limit). */
    const val MAX = 100

    /** `appVersion` (server limit). */
    const val MAX_APP_VERSION = 50

    private val SHA256 = Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$")
    private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")

    /** IANA-looking zone id (`Area/Location[/Sub]`, or `UTC`); anything else is omitted rather than 400ing the request. */
    private val IANA = Regex("^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$")

    /** `"Samsung SM-S918B"`: the manufacturer is not repeated when the model already starts with it. */
    fun makerModel(manufacturer: String?, model: String?): String {
        val maker = manufacturer?.trim().orEmpty().replaceFirstChar { it.titlecase(Locale.ROOT) }
        val mdl = model?.trim().orEmpty()
        return when {
            mdl.isEmpty() -> maker
            maker.isEmpty() || mdl.lowercase(Locale.ROOT).startsWith(maker.lowercase(Locale.ROOT)) -> mdl
            else -> "$maker $mdl"
        }.ifEmpty { "Android phone" }
    }

    /** Activation page / device row name: `"Samsung SM-S918B · Media sync"`. */
    fun deviceName(manufacturer: String?, model: String?): String =
        "${makerModel(manufacturer, model)} · Media sync".take(MAX)

    /** Name of the minted PAT in the Access Tokens list: `"MemoriaHub Android · SM-S918B"`. */
    fun tokenName(model: String?, productName: String = Brand.name): String {
        val mdl = model?.trim().orEmpty().ifEmpty { "phone" }
        return "$productName Android · $mdl".take(MAX)
    }

    fun clientInfo(
        manufacturer: String?,
        model: String?,
        versionName: String,
        returnUri: String = MediaSyncLinks.pairedReturnUri,
    ): DeviceClientInfo = DeviceClientInfo(
        deviceName = deviceName(manufacturer, model),
        userAgent = ApiClient.userAgent(versionName),
        tokenType = DeviceClientInfo.TOKEN_TYPE_PAT,
        name = tokenName(model),
        platform = "android",
        returnUri = returnUri,
    )

    fun clientInfo(context: Context): DeviceClientInfo =
        clientInfo(Build.MANUFACTURER, Build.MODEL, AppInfo.read(context).versionName)

    /** The registration body; fields the server would reject are omitted, never sent malformed. */
    fun registration(
        installationId: String,
        manufacturer: String?,
        model: String?,
        androidVersion: String?,
        sdkInt: Int?,
        app: AppInfo,
        zoneId: String?,
    ): RegisterDeviceRequest = RegisterDeviceRequest(
        installationId = installationId,
        name = deviceName(manufacturer, model),
        manufacturer = manufacturer?.trim()?.take(MAX)?.ifEmpty { null },
        model = model?.trim()?.take(MAX)?.ifEmpty { null },
        androidVersion = androidVersion?.trim()?.take(MAX)?.ifEmpty { null },
        sdkInt = sdkInt?.takeIf { it in 0..10_000 },
        appVersion = app.versionName.trim().take(MAX_APP_VERSION).ifEmpty { null },
        appVersionCode = app.versionCode.takeIf { it in 1..2_100_000_000 }?.toInt(),
        packageName = app.packageName.takeIf { it.length <= MAX && PACKAGE.matches(it) },
        signingSha256 = app.signingSha256?.uppercase(Locale.ROOT)?.takeIf { SHA256.matches(it) },
        timezone = zoneId?.takeIf { IANA.matches(it) },
    )

    fun registration(context: Context, installationId: String): RegisterDeviceRequest = registration(
        installationId = installationId,
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        androidVersion = Build.VERSION.RELEASE,
        sdkInt = Build.VERSION.SDK_INT,
        app = AppInfo.read(context),
        zoneId = runCatching { ZoneId.systemDefault().id }.getOrNull(),
    )
}
