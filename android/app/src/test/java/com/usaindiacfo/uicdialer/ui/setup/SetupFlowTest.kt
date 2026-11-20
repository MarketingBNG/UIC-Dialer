package com.usaindiacfo.uicdialer.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SetupFlowTest {
    @Test fun android10HasNoNotificationOrExactAlarmStep() {
        assertEquals(
            listOf(GuideStep.PHONE, GuideStep.CONTACTS, GuideStep.RECORDINGS, GuideStep.BATTERY, GuideStep.OVERLAY),
            SetupFlow.stepsFor(29),
        )
    }

    @Test fun android12AddsExactAlarmsOnly() {
        val s = SetupFlow.stepsFor(31)
        assertTrue(GuideStep.EXACT_ALARMS in s)
        assertFalse(GuideStep.NOTIFICATIONS in s)
    }

    @Test fun android13PlusHasAllStepsInOrder() {
        assertEquals(GuideStep.entries.toList(), SetupFlow.stepsFor(33))
        assertEquals(GuideStep.entries.toList(), SetupFlow.stepsFor(37))
    }

    @Test fun requiredVsOptional() {
        assertTrue(SetupFlow.isRequired(GuideStep.PHONE, false))
        assertTrue(SetupFlow.isRequired(GuideStep.RECORDINGS, false))
        assertTrue(SetupFlow.isRequired(GuideStep.BATTERY, false))
        assertFalse(SetupFlow.isRequired(GuideStep.CONTACTS, false))
        assertTrue(SetupFlow.isRequired(GuideStep.CONTACTS, true))
        assertFalse(SetupFlow.isRequired(GuideStep.OVERLAY, true))
        assertFalse(SetupFlow.isRequired(GuideStep.EXACT_ALARMS, true))
        assertFalse(SetupFlow.isRequired(GuideStep.NOTIFICATIONS, true))
    }

    @Test fun brands() {
        assertEquals(Brand.XIAOMI, Brand.from("Redmi"))
        assertEquals(Brand.XIAOMI, Brand.from("POCO"))
        assertEquals(Brand.OPPO, Brand.from("OnePlus"))
        assertEquals(Brand.OPPO, Brand.from("realme"))
        assertEquals(Brand.VIVO, Brand.from("iQOO"))
        assertEquals(Brand.SAMSUNG, Brand.from("samsung"))
        assertEquals(Brand.MOTOROLA_GOOGLE, Brand.from("motorola"))
        assertEquals(Brand.OTHER, Brand.from("nokia"))
        assertTrue(SetupFlow.needsAutostart(Brand.XIAOMI))
        assertTrue(SetupFlow.needsAutostart(Brand.VIVO))
        assertFalse(SetupFlow.needsAutostart(Brand.SAMSUNG))
        assertFalse(SetupFlow.needsAutostart(Brand.MOTOROLA_GOOGLE))
        Brand.entries.forEach { assertTrue(SetupFlow.recordingInstructions(it).isNotBlank()) }
    }

    @Test fun firstPendingSkipsDoneAndSkipped() {
        val steps = SetupFlow.stepsFor(33)
        assertEquals(0, SetupFlow.firstPending(steps, emptySet()))
        assertEquals(2, SetupFlow.firstPending(steps, setOf(GuideStep.PHONE), setOf(GuideStep.CONTACTS)))
        assertEquals(steps.size, SetupFlow.firstPending(steps, steps.toSet()))
    }

    @Test fun reShowWhenRequiredRevoked() {
        val steps = SetupFlow.stepsFor(29)
        val done = steps.toSet() - GuideStep.PHONE
        assertEquals(listOf(GuideStep.PHONE), SetupFlow.missingRequired(steps, done, false))
        assertTrue(SetupFlow.shouldShowGuide(completed = true, requiredPermissionsMissing = true))
        assertFalse(SetupFlow.shouldShowGuide(completed = true, requiredPermissionsMissing = false))
        assertTrue(SetupFlow.shouldShowGuide(completed = false, requiredPermissionsMissing = false))
    }

    @Test fun progressLabel() = assertEquals("Step 3 of 6", SetupFlow.progressLabel(2, 6))
}
