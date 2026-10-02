# Release (R8) rules.

# --- kotlinx.serialization ---------------------------------------------------
# The library ships consumer rules for the runtime; keep generated serializers of
# our own @Serializable classes (named companions / $serializer) explicitly.
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class memoriahub.marin.cr.** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class memoriahub.marin.cr.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class memoriahub.marin.cr.**$$serializer { *; }

# --- OkHttp ------------------------------------------------------------------
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- androidbrowserhelper ----------------------------------------------------
# Activities/services are referenced from the manifest (kept by AAPT); the
# library uses no reflection beyond that.
-dontwarn com.google.androidbrowserhelper.**

# --- security-crypto (Tink) --------------------------------------------------
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**

# --- WorkManager -------------------------------------------------------------
# WorkManager stores a worker's class name in its database and instantiates it by
# reflection. Keep every CoroutineWorker/ListenableWorker of ours with its
# (Context, WorkerParameters) constructor under its original name, so an R8 rename
# can never orphan scheduled work across an update (workers arrive in #511/#512).
-keep class memoriahub.marin.cr.** extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# --- Room --------------------------------------------------------------------
# room-runtime ships consumer rules for generated *_Impl classes (ledger, #510).
