import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// -----------------------------------------------------------------------------
// Product identity: apps/android/identity.properties is the single source of truth for the
// app's name, applicationId, deep-link scheme, storage prefix and brand colours. Nothing in the
// Kotlin sources spells them; they reach the code through BuildConfig / resources generated here.
// -----------------------------------------------------------------------------

fun loadProperties(name: String): Properties = Properties().apply {
    val file = rootProject.file(name)
    if (file.isFile) file.inputStream().use { load(it) }
}

val identity = loadProperties("identity.properties")

fun identityValue(key: String): String =
    identity.getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }
        ?: throw GradleException("apps/android/identity.properties: \"$key\" is missing or empty.")

fun stringProp(name: String): String? = (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }

/** `#rrggbb` (identity.properties) → `#FFRRGGBB` (Android colour resource). */
fun argb(key: String, hex: String): String {
    if (!Regex("^#[0-9a-fA-F]{6}$").matches(hex)) {
        throw GradleException("identity.properties: $key \"$hex\" is not #rrggbb.")
    }
    return "#FF" + hex.substring(1).uppercase()
}

val productName = identityValue("productName")
val baseApplicationId = identityValue("applicationId")
val deepLinkScheme = identityValue("deepLinkScheme")
val storagePrefix = identityValue("storagePrefix")
val themeColorHex = identityValue("themeColor")
val backgroundColorHex = identityValue("backgroundColor")
val themeColor = argb("themeColor", themeColorHex)
val backgroundColor = argb("backgroundColor", backgroundColorHex)

if (!Regex("^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$").matches(baseApplicationId)) {
    throw GradleException("identity.properties: applicationId \"$baseApplicationId\" must be lowercase dotted segments.")
}
if (!Regex("^[a-z][a-z0-9+.-]*$").matches(deepLinkScheme)) {
    throw GradleException("identity.properties: deepLinkScheme \"$deepLinkScheme\" is not a valid lowercase URI scheme.")
}
if (!Regex("^[a-z0-9_]+$").matches(storagePrefix)) {
    throw GradleException("identity.properties: storagePrefix \"$storagePrefix\" must be lowercase letters, digits or _.")
}

// The TWA's status bar, navigation bar and splash must match the installed PWA. The PWA's
// colours live in apps/web/pwa/manifest.ts; fail the build when the two drift apart. Skipped
// (with a warning) only when the web app is not checked out next to this project.
val webManifest: File = rootProject.file("../web/pwa/manifest.ts")
if (webManifest.isFile) {
    val manifestText = webManifest.readText()
    fun manifestColor(name: String): String? =
        Regex("""export const $name\s*=\s*'(#[0-9a-fA-F]{6})'""").find(manifestText)?.groupValues?.get(1)
    for ((key, value, constant) in listOf(
        Triple("themeColor", themeColorHex, "THEME_COLOR"),
        Triple("backgroundColor", backgroundColorHex, "BACKGROUND_COLOR"),
    )) {
        val web = manifestColor(constant)
            ?: throw GradleException("apps/web/pwa/manifest.ts: could not read $constant.")
        if (!web.equals(value, ignoreCase = true)) {
            throw GradleException(
                "identity.properties $key ($value) differs from $constant ($web) in apps/web/pwa/manifest.ts; keep them equal.",
            )
        }
    }
} else {
    logger.warn("${project.path}: apps/web/pwa/manifest.ts not found; brand colours not cross-checked.")
}

/** Kotlin package and namespace of the sources (identity-neutral of build type; never suffixed). */
val codeNamespace = "memoriahub.marin.cr"

// -----------------------------------------------------------------------------
// Version: apps/android/version.properties (committed; the CLI bumps it), overridable per build
// with -Papp.versionName / -Papp.versionCode (or the storage-prefixed -Pmemoriahub.versionName …).
// -----------------------------------------------------------------------------

/** A build property under the neutral `app.` prefix, or under the storage prefix (`memoriahub.`). */
fun appProp(key: String): String? = stringProp("app.$key") ?: stringProp("$storagePrefix.$key")

val versionProps = loadProperties("version.properties")
fun versionProp(key: String): String? = versionProps.getProperty(key)?.trim()?.ifEmpty { null }

val appVersionName: String = appProp("versionName") ?: versionProp("versionName")
    ?: throw GradleException("versionName is missing (version.properties or -Papp.versionName).")
val appVersionCode: Int = (appProp("versionCode") ?: versionProp("versionCode") ?: "")
    .toIntOrNull()
    ?.takeIf { code -> code in 1..2_100_000_000 }
    ?: throw GradleException("versionCode must be a whole number from 1 to 2100000000 (version.properties or -Papp.versionCode).")

// Not blank-filtered: an empty value is meaningful (first-run setup screen).
val defaultServerUrl = ((project.findProperty("app.serverUrl") ?: project.findProperty("$storagePrefix.serverUrl")) as String?)
    ?.trim().orEmpty()

fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// -----------------------------------------------------------------------------
// Release signing comes only from the environment (`memoriahub android build`, issue #517, or CI,
// issue #518). When any variable is missing the release APK is built unsigned, with a warning.
// -----------------------------------------------------------------------------
val signingStoreFile: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
val signingStorePassword: String? = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotEmpty() }
val signingKeyAlias: String? = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val signingKeyPassword: String? = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotEmpty() }
val hasReleaseSigning = signingStoreFile != null && file(signingStoreFile).exists() &&
    signingStorePassword != null && signingKeyAlias != null && signingKeyPassword != null

android {
    namespace = codeNamespace
    compileSdk = 36

    defaultConfig {
        applicationId = baseApplicationId
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName

        buildConfigField("String", "DEFAULT_SERVER_URL", quoted(defaultServerUrl))
        buildConfigField("String", "PRODUCT_NAME", quoted(productName))
        buildConfigField("String", "DEEP_LINK_SCHEME", quoted(deepLinkScheme))
        buildConfigField("String", "STORAGE_PREFIX", quoted(storagePrefix))
        buildConfigField("int", "THEME_COLOR", "0x" + themeColor.substring(1))
        buildConfigField("int", "BACKGROUND_COLOR", "0x" + backgroundColor.substring(1))

        resValue("string", "app_name", productName)
        resValue("color", "brand_primary", themeColor)
        resValue("color", "brand_background", backgroundColor)
        // The logo is multi-coloured on white (like the PWA's maskable icon), so the adaptive
        // icon's background layer is the brand background, not the primary colour.
        resValue("color", "ic_launcher_background", backgroundColor)
        manifestPlaceholders["deepLinkScheme"] = deepLinkScheme
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                // Outer vals have distinct names: inside this block `keyAlias` would mean this.keyAlias.
                storeFile = file(signingStoreFile!!)
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            // memoriahub.marin.cr.debug: installs beside a release build.
            applicationIdSuffix = ".debug"
        }
        release {
            // R8 is on: kotlinx.serialization, androidbrowserhelper and WorkManager rules live in proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// Room (the Media Sync file ledger, issue #510) exports its schema next to the sources so
// migrations can be reviewed and tested.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.generateKotlin", "true")
}

if (!hasReleaseSigning) {
    gradle.taskGraph.whenReady {
        if (allTasks.any { it.name.contains("Release") && (it.name.startsWith("assemble") || it.name.startsWith("package")) }) {
            logger.warn(
                "WARNING: ${project.path}: ANDROID_KEYSTORE_FILE/ANDROID_KEYSTORE_PASSWORD/ANDROID_KEY_ALIAS/ANDROID_KEY_PASSWORD " +
                    "not all set (or the keystore file is missing); the release APK will be UNSIGNED " +
                    "(app/build/outputs/apk/release/app-release-unsigned.apk).",
            )
        }
    }
}

/**
 * res/xml/shortcuts.xml, generated: a static shortcut must name its target package and class
 * literally, and the package depends on the build type (`.debug`). The launcher alias in the
 * manifest always points at this file.
 *
 * [shortcuts] maps a shortcut id to the deep-link path it opens (`<scheme>://<path>`); its
 * labels are the string resources `shortcut_<id>_short`, `shortcut_<id>_long` and
 * `shortcut_<id>_disabled`. The scaffold (issue #508) ships none; issue #513 adds, with their
 * screen (docs/specs/android-media-sync.md §12.1):
 *   "media_sync" to "media-sync", "diagnostics" to "media-sync/diagnostics",
 * targeting `memoriahub.marin.cr.mediasync.MediaSyncActivity`.
 */
abstract class GenerateShortcutsTask : DefaultTask() {
    @get:Input abstract val targetPackage: Property<String>
    @get:Input abstract val targetClass: Property<String>
    @get:Input abstract val scheme: Property<String>
    @get:Input abstract val shortcuts: MapProperty<String, String>

    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun write() {
        val file = outputDir.file("xml/shortcuts.xml").get().asFile
        file.parentFile.mkdirs()
        val entries = shortcuts.get().entries.joinToString("") { (id, path) ->
            """
            |    <shortcut
            |        android:shortcutId="$id"
            |        android:enabled="true"
            |        android:icon="@mipmap/ic_launcher"
            |        android:shortcutShortLabel="@string/shortcut_${id}_short"
            |        android:shortcutLongLabel="@string/shortcut_${id}_long"
            |        android:shortcutDisabledMessage="@string/shortcut_${id}_disabled">
            |        <intent
            |            android:action="android.intent.action.VIEW"
            |            android:data="${scheme.get()}://$path"
            |            android:targetPackage="${targetPackage.get()}"
            |            android:targetClass="${targetClass.get()}" />
            |    </shortcut>
            |""".trimMargin() + "\n"
        }
        file.writeText(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
                "<!-- Generated by app/build.gradle.kts (GenerateShortcutsTask); do not edit. -->\n" +
                "<shortcuts xmlns:android=\"http://schemas.android.com/apk/res/android\">\n" +
                entries +
                "</shortcuts>\n",
        )
    }
}

androidComponents {
    onVariants { variant ->
        val task = tasks.register<GenerateShortcutsTask>(
            "generate${variant.name.replaceFirstChar { it.uppercase() }}Shortcuts",
        ) {
            targetPackage.set(variant.applicationId)
            // Issue #513 points this at "$codeNamespace.mediasync.MediaSyncActivity" and fills `shortcuts`.
            targetClass.set("$codeNamespace.twa.TwaLauncherActivity")
            scheme.set(deepLinkScheme)
            shortcuts.set(emptyMap<String, String>())
            outputDir.set(layout.buildDirectory.dir("generated/identity/${variant.name}/res"))
        }
        variant.sources.res?.addGeneratedSourceDirectory(task, GenerateShortcutsTask::outputDir)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidbrowserhelper)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)

    // The file ledger (issue #510). Wired here so adding entities needs no build change.
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
