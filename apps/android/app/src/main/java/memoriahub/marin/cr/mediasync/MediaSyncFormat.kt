package memoriahub.marin.cr.mediasync

import java.text.NumberFormat
import java.util.Locale
import kotlin.math.max

/** Plain-Kotlin text formatting shared by the Media Sync screens (JVM-tested; no Android types). */
object MediaSyncFormat {
    /** `1,234` in the given locale. */
    fun count(n: Int, locale: Locale = Locale.getDefault()): String = NumberFormat.getIntegerInstance(locale).format(n)

    /** `1 photo`, `1,234 photos`. */
    fun plural(n: Int, one: String, many: String = one + "s", locale: Locale = Locale.getDefault()): String =
        "${count(n, locale)} ${if (n == 1) one else many}"

    /** Decimal units (what Android's storage settings show): `0 B`, `512 KB`, `1.2 GB`. */
    fun bytes(bytes: Long, locale: Locale = Locale.getDefault()): String {
        val b = max(bytes, 0L)
        if (b < 1000) return "$b B"
        val units = listOf("KB", "MB", "GB", "TB")
        var value = b / 1000.0
        var unit = 0
        while (value >= 1000 && unit < units.lastIndex) {
            value /= 1000
            unit++
        }
        val pattern = if (value >= 100) "%.0f %s" else "%.1f %s"
        return String.format(locale, pattern, value, units[unit])
    }

    /** `1,234 photos · 56 videos` (a zero side is omitted unless both are zero). */
    fun photosAndVideos(photos: Int, videos: Int, locale: Locale = Locale.getDefault()): String = when {
        photos == 0 && videos == 0 -> "No photos or videos"
        videos == 0 -> plural(photos, "photo", locale = locale)
        photos == 0 -> plural(videos, "video", locale = locale)
        else -> plural(photos, "photo", locale = locale) + " · " + plural(videos, "video", locale = locale)
    }

    /** "in 9 min", "in 2 h", "now" for a time [deltaMs] in the future. */
    fun inDuration(deltaMs: Long): String {
        if (deltaMs <= 30_000) return "now"
        val minutes = (deltaMs + 59_999) / 60_000
        return when {
            minutes < 60 -> "in $minutes min"
            minutes < 48 * 60 -> "in ${(minutes + 59) / 60} h"
            else -> "in ${(minutes + 24 * 60 - 1) / (24 * 60)} days"
        }
    }

    /** "just now", "12 min ago", "3 h ago", "2 days ago" for an instant [deltaMs] in the past. */
    fun ago(deltaMs: Long): String {
        if (deltaMs < 60_000) return "just now"
        val minutes = deltaMs / 60_000
        return when {
            minutes < 60 -> "$minutes min ago"
            minutes < 24 * 60 -> "${minutes / 60} h ago"
            minutes < 48 * 60 -> "yesterday"
            else -> "${minutes / (24 * 60)} days ago"
        }
    }

    /** 0–100 percentage of [done]/[total], or null when the total is unknown. */
    fun percent(done: Long, total: Long): Int? =
        if (total <= 0) null else ((done.coerceIn(0, total) * 100) / total).toInt()
}
