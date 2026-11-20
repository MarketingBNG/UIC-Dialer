package com.usaindiacfo.uicdialer.ui.dialer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DialerCommonTest {
    @Test fun viaLabels() {
        assertEquals("via laptop", viaLabel("LAPTOP"))
        assertEquals("via app", viaLabel("APP"))
        assertEquals("via phone dialer", viaLabel("PHONE_DIALER"))
        assertNull(viaLabel(null))
        assertNull(viaLabel("SOMETHING_NEW"))
    }

    @Test fun initialsFromNames() {
        assertEquals("RM", initials("Rahul Mehta"))
        assertEquals("RK", initials("  rahul  kumar mehta k "))
        assertEquals("P", initials("Priya"))
        assertEquals("#", initials("+91 98765 43210"))
        assertEquals("#", initials(null))
        assertEquals("#", initials(""))
    }
}
