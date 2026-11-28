package com.usaindiacfo.uicdialer.ui.admin

import com.usaindiacfo.uicdialer.data.api.FirefliesUsage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FirefliesAlertsTest {
    private fun usage(pct: Double, sent: Int = 0, approved: Int = 20, blocked: Boolean = false) = FirefliesUsage(
        month = "2026-11", enabled = true, budgetMinutes = 1000, liveReservePct = 10.0, usedMinutes = 0, reservedMinutes = 0,
        pct = pct, approvedBacklogCount = approved, backlogSent = sent, deleteAfterFetch = true, blocked = blocked,
        blockedUntil = if (blocked) "2026-12-01T00:00:00.000Z" else null, lastError = if (blocked) "quota exceeded" else null,
    )

    @Test fun levelsFollowThresholds() {
        assertTrue(firefliesAlerts(usage(49.9)).isEmpty())
        assertEquals(listOf(AlertLevel.INFO), firefliesAlerts(usage(50.0)).map { it.level })
        assertEquals(listOf(AlertLevel.WARNING), firefliesAlerts(usage(80.0)).map { it.level })
        assertEquals(listOf(AlertLevel.ERROR), firefliesAlerts(usage(100.0)).map { it.level })
    }

    @Test fun blockedAndBacklogGate() {
        val a = firefliesAlerts(usage(10.0, sent = 20, approved = 20, blocked = true))
        assertEquals(listOf(AlertLevel.ERROR, AlertLevel.WARNING), a.map { it.level })
        assertTrue(a[0].text.contains("quota exceeded"))
        assertEquals("Old calls paused after 20 - check Fireflies billing, then raise the limit", a[1].text)
    }

    @Test fun managersSeePlainPauseOnly() {
        assertTrue(firefliesAlerts(usage(85.0), isAdmin = false).isEmpty())
        val a = firefliesAlerts(usage(10.0, blocked = true), isAdmin = false)
        assertEquals(listOf(AlertLevel.WARNING), a.map { it.level })
        assertTrue(a[0].text.endsWith("Recordings are safe."))
        assertTrue(!a[0].text.contains("Fireflies") && !a[0].text.contains("quota"))
    }

    @Test fun waitingBudgetLabel() = assertEquals("Paused (monthly limit)", jobStatusLabel("WAITING_BUDGET"))
}
