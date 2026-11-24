package com.usaindiacfo.uicdialer.detect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SimInfoTest {
    private val jio = Sim(key = "3", subId = 3, iccId = "8991860012345678901", slot = 0, carrier = "Jio", number = null)
    private val airtel = Sim(key = "4", subId = 4, iccId = "8991100098765432109", slot = 1, carrier = "Airtel", number = null)
    private val sims = listOf(jio, airtel)

    @Test fun matchesSubscriptionId() = assertEquals(airtel, SimInfo.match("4", sims))
    @Test fun matchesIccIdWithTrailingF() = assertEquals(jio, SimInfo.match("8991860012345678901F", sims))
    @Test fun usesAndroidsAccountMapFirst() =
        assertEquals(jio, SimInfo.match("89918600999", sims, mapOf("89918600999" to 3)))

    @Test fun noMatchForBlankOrUnknown() {
        assertNull(SimInfo.match(null, sims))
        assertNull(SimInfo.match(" ", sims))
        assertNull(SimInfo.match("E", sims))
    }
}
