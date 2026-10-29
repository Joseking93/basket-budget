package com.basketbudget.app

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Checks GitHub Releases for a newer build and fetches its APK.
 *
 * This is the only part of the app that touches the network, and it only runs
 * when the update row is tapped. Scanning a receipt stays entirely on the
 * device.
 */
object Updater {

    private const val LATEST =
        "https://api.github.com/repos/Joseking93/basket-budget/releases/latest"

    data class Release(val version: String, val apkUrl: String, val notes: String)

    /** The newest release, or null when there is none to be had. */
    fun latest(): Release? {
        val body = read(LATEST) ?: return null
        return try {
            val json = JSONObject(body)
            val tag = json.optString("tag_name").trimStart('v', 'V')
            val assets = json.optJSONArray("assets") ?: return null
            var apk: String? = null
            for (i in 0 until assets.length()) {
                val asset = assets.getJSONObject(i)
                if (asset.optString("name").endsWith(".apk", true)) {
                    apk = asset.optString("browser_download_url")
                    break
                }
            }
            if (tag.isEmpty() || apk.isNullOrEmpty()) null
            else Release(tag, apk, json.optString("body").take(400))
        } catch (e: Exception) {
            null
        }
    }

    /**
     * True when [theirs] is a later version than [ours]. Compared part by part
     * as numbers, so 3.10 beats 3.9 - which string comparison gets wrong.
     */
    fun isNewer(theirs: String, ours: String): Boolean {
        val a = theirs.split('.', '-').mapNotNull { it.toIntOrNull() }
        val b = ours.split('.', '-').mapNotNull { it.toIntOrNull() }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** Downloads the APK into the cache, returning the file or null. */
    fun download(url: String, into: File): File? {
        return try {
            val target = File(into, "update.apk")
            if (target.exists()) target.delete()
            openConnection(url).use { stream ->
                target.outputStream().use { out -> stream.copyTo(out) }
            }
            if (target.length() > 0) target else null
        } catch (e: Exception) {
            null
        }
    }

    private fun read(url: String): String? = try {
        openConnection(url).use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (e: Exception) {
        null
    }

    private fun openConnection(url: String) =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 30000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "BasketBudget")
        }.inputStream
}
