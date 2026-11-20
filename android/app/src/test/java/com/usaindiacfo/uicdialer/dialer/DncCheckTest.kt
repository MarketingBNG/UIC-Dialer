package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.sync.PrivacyFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Key and hash vector shared with the server's numberKey / hashKey (server/test/privacy.test.ts). */
class DncCheckTest {
    @Test fun sharedVector() {
        assertEquals("9876543210", PrivacyFilter.key("+91 98765 43210"))
        assertEquals("7619ee8cea49187f309616e30ecf54be072259b43760f1f550a644945d5572f2", DncCheck.hashFor("+91 98765 43210"))
    }

    @Test fun sameHashForEveryWayOfWritingTheNumber() {
        val h = DncCheck.hashFor("+91 98765 43210")
        assertEquals(h, DncCheck.hashFor("098765-43210"))
        assertEquals(h, DncCheck.hashFor("9876543210"))
    }

    @Test fun tooShortOrBlankIsNeverDnc() {
        assertNull(DncCheck.hashFor(null))
        assertNull(DncCheck.hashFor(""))
        assertNull(DncCheck.hashFor("123"))
    }
}
