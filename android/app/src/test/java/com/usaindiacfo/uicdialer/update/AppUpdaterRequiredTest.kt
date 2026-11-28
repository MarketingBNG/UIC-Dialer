package com.usaindiacfo.uicdialer.update

import com.usaindiacfo.uicdialer.data.api.LatestApp
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdaterRequiredTest {
    private val sha = "a".repeat(64)
    private fun app(code: Int, required: Boolean = false) = LatestApp(available = true, versionCode = code, sha256 = sha, required = required)

    @Test fun newerOnlyWhenHigherAndVerifiable() {
        assertTrue(AppUpdater.isNewer(app(11), 10))
        assertFalse(AppUpdater.isNewer(app(10), 10))
        assertFalse(AppUpdater.isNewer(LatestApp(available = true, versionCode = 11), 10)) // no checksum
        assertFalse(AppUpdater.isNewer(LatestApp(available = false), 10))
    }

    @Test fun requiredOnlyWithANewerBuild() {
        assertTrue(AppUpdater.isRequired(app(11, required = true), 10))
        assertFalse(AppUpdater.isRequired(app(11), 10))
        assertFalse(AppUpdater.isRequired(app(10, required = true), 10))
        assertFalse(AppUpdater.isRequired(null, 10))
    }

    @Test fun olderServerWithoutTheFieldMeansNotRequired() {
        val json = Json { ignoreUnknownKeys = true }
        val l = json.decodeFromString<LatestApp>("""{"available":true,"versionCode":11,"sha256":"$sha"}""")
        assertFalse(l.required)
        assertEquals(true, json.decodeFromString<LatestApp>("""{"available":true,"required":true}""").required)
    }
}
