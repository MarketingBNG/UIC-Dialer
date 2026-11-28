package com.usaindiacfo.uicdialer.ui.setup

import androidx.compose.runtime.Composable

/**
 * Kept so the "setupGuide" route (sign-in, revoked-permission check) still works: the step-by-step guide
 * and the checklist are now one Phone setup screen. [onOpenChecks] is no longer needed.
 */
@Composable
fun SetupGuideScreen(onFinished: () -> Unit, @Suppress("UNUSED_PARAMETER") onOpenChecks: () -> Unit) {
    SetupScreen(onDone = onFinished)
}
