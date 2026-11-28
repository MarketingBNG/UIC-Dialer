package com.usaindiacfo.uicdialer.ui.dialer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DialerLookupTest {
    @Test fun shortInputIsNotSearched() {
        assertNull(lookupTerm(""))
        assertNull(lookupTerm("98"))
        assertNull(lookupTerm("  ab  "))
    }

    @Test fun termIsTrimmed() {
        assertEquals("ravi", lookupTerm("  ravi "))
        assertEquals("987", lookupTerm("987"))
    }
}
