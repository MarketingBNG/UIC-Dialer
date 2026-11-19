package com.usaindiacfo.uicrecorder.dialer

import android.content.Context
import com.usaindiacfo.uicrecorder.data.api.ApiClient
import com.usaindiacfo.uicrecorder.data.api.OutcomeDto
import com.usaindiacfo.uicrecorder.data.api.OutcomeList
import com.usaindiacfo.uicrecorder.data.api.TemplateDto
import com.usaindiacfo.uicrecorder.data.api.TemplateList
import kotlinx.serialization.json.Json
import java.io.IOException

/**
 * Outcomes and message templates, cached as JSON in prefs like [ContactCache] so the outcome sheet and the
 * template picker work offline. Cleared with the rest of the dialer cache.
 */
class OutcomeCatalog(context: Context, private val api: () -> ApiClient) {
    private val prefs = context.applicationContext.getSharedPreferences("dialer_catalog", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    /** Cached outcomes (active, sorted), or the four built-in defaults. */
    val outcomes: List<OutcomeDto>
        get() = OutcomeLogic.visible(
            prefs.getString(KEY_OUTCOMES, null)?.let { runCatching { json.decodeFromString(OutcomeList.serializer(), it).items }.getOrNull() }.orEmpty(),
        )

    val templates: List<TemplateDto>
        get() = prefs.getString(KEY_TEMPLATES, null)?.let { runCatching { json.decodeFromString(TemplateList.serializer(), it).items }.getOrNull() }
            .orEmpty().filter { it.active }.sortedWith(compareBy({ it.sortOrder }, { it.name }))

    /** Downloads both lists; keeps the cache on any failure (offline, or a server before stage 2). */
    suspend fun refresh() {
        try {
            val o = api().outcomes()
            prefs.edit().putString(KEY_OUTCOMES, json.encodeToString(OutcomeList.serializer(), o)).apply()
        } catch (_: IOException) {
        } catch (_: kotlinx.serialization.SerializationException) {
        }
        try {
            val t = api().templates()
            prefs.edit().putString(KEY_TEMPLATES, json.encodeToString(TemplateList.serializer(), t)).apply()
        } catch (_: IOException) {
        } catch (_: kotlinx.serialization.SerializationException) {
        }
    }

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_OUTCOMES = "outcomes"
        const val KEY_TEMPLATES = "templates"
    }
}
