package com.usaindiacfo.uicrecorder.dialer

import org.junit.Assert.assertEquals
import org.junit.Test

/** Same three vectors as the server's renderTemplate and the dashboard. */
class TemplateRenderTest {
    @Test fun sharedVectors() {
        assertEquals("Hi Priya, Kirti here", TemplateRender.render("Hi {name}, {rep} here", "Priya Shah", "Kirti Arora"))
        assertEquals("Hi there", TemplateRender.render("Hi {name}", null, "Kirti"))
        assertEquals("{x} A", TemplateRender.render("{x} {name}", "A", "B"))
    }

    @Test fun caseSensitiveAndBlankName() {
        assertEquals("Hi {Name} there", TemplateRender.render("Hi {Name} {name}", "   ", "K"))
    }

    @Test fun repNameFallsBackToEmailLocalPart() {
        assertEquals("Kirti Arora", TemplateRender.repName("Kirti Arora", "x@y.com"))
        assertEquals("kirti", TemplateRender.repName(null, "kirti@usaindiacfo.com"))
        assertEquals("Hi kirti", TemplateRender.render("Hi {rep}", null, TemplateRender.repName("", "kirti@usaindiacfo.com")))
    }

    @Test fun whatsAppLinkCarriesEncodedText() {
        assertEquals("https://wa.me/919876543210?text=Hi%20Priya%2C%20call%20me%20%26%20pay", DialLogic.whatsAppUrl("9876543210", "Hi Priya, call me & pay"))
        assertEquals("https://wa.me/919876543210", DialLogic.whatsAppUrl("9876543210", ""))
    }
}
