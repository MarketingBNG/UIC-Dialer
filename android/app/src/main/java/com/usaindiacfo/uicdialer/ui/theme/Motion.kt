package com.usaindiacfo.uicdialer.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween

/**
 * One timing for every animation in the app, so everything moves at the same pace (WhatsApp-like: quick, calm).
 * Change it here, not in the screens.
 */
object Motion {
    /** Screens, cards, list rows, shared avatar: anything that moves or resizes. */
    const val MS = 220

    /** Small things: key press, fading out. */
    const val FAST_MS = 120

    /** Starts quick, settles gently. */
    val Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)

    fun <T> spec(): FiniteAnimationSpec<T> = tween(MS, easing = Easing)
    fun <T> fast(): FiniteAnimationSpec<T> = tween(FAST_MS, easing = Easing)
}
