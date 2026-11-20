package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.data.api.ApiClient
import com.usaindiacfo.uicdialer.data.api.AuthResponse
import com.usaindiacfo.uicdialer.data.api.TokenProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class LiveEventsTest {
    private val server = MockWebServer()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private object Tokens : TokenProvider {
        override var accessToken: String? = "t"
        override var refreshToken: String? = "r"
        override val accessExpiresAtMs = Long.MAX_VALUE
        override fun save(auth: AuthResponse) = Unit
        override fun onRefreshFailed() = Unit
    }

    @Before fun setUp() = server.start()

    @After fun tearDown() {
        scope.cancel()
        server.close()
    }

    private fun sse(body: String) =
        MockResponse.Builder().code(200).addHeader("content-type", "text/event-stream").body(body).build()

    @Test fun emitsTopicsAndRefreshesEverythingAfterReconnect() = runBlocking {
        server.enqueue(sse("retry: 3000\nevent: ready\ndata: {}\n\n: ping\n\nevent: change\ndata: {\"topic\":\"calls\",\"userId\":\"u\"}\n\n"))
        server.enqueue(sse("event: ready\ndata: {}\n\nevent: change\ndata: {\"topic\":\"contacts\",\"userId\":null}\n\n"))
        val live = LiveEvents(ApiClient(server.url("/").toString(), Tokens), scope) { true }
        val got = async(Dispatchers.IO) { withTimeout(15_000) { live.changes.take(3).toList() } }
        Thread.sleep(200) // let the collector subscribe
        live.start()
        assertEquals(listOf("calls", LiveEvents.ALL, "contacts"), got.await())
        val first = server.takeRequest()
        assertEquals("/api/events", first.url.encodedPath)
        assertEquals("Bearer t", first.headers["Authorization"])
        live.stop()
    }
}
