package com.usaindiacfo.uicdialer.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Shared design tokens; same values as the web dashboard (server/dashboard/src/index.css :root).
 * Used where Material roles don't fit (call button, overdue, status pills).
 */
object UicColors {
    val primary = Color(0xFF1D4ED8)
    val primarySoft = Color(0xFFEFF6FF)
    val navy = Color(0xFF0F172A)
    val callGreen = Color(0xFF16A34A)
    val success = Color(0xFF16A34A)
    val successSoft = Color(0xFFF0FDF4)
    val warning = Color(0xFFD97706)
    val warningSoft = Color(0xFFFFFBEB)
    val danger = Color(0xFFDC2626)
    val dangerSoft = Color(0xFFFEF2F2)
    val info = Color(0xFF0284C7)
    val infoSoft = Color(0xFFF0F9FF)
    val slate = Color(0xFF64748B)
    /** Kept names: red for act-now (overdue), amber for "needs a look". */
    val overdue = danger
    val amber = warning
    val background = Color(0xFFF8FAFC)
    val keyBg = Color(0xFFE9EDF4)
    val text = Color(0xFF0F172A)
    val mutedText = Color(0xFF6B7280)
    val border = Color(0xFFE5E7EB)
}

/** Status pill colours (soft background + strong text), switched for dark mode by UicTheme. */
@Immutable
data class Tone(val bg: Color, val fg: Color)

@Immutable
data class UicTones(val success: Tone, val warning: Tone, val danger: Tone, val info: Tone, val neutral: Tone, val slate: Tone)

private val LightTones = UicTones(
    success = Tone(UicColors.successSoft, Color(0xFF15803D)),
    warning = Tone(UicColors.warningSoft, Color(0xFFB45309)),
    danger = Tone(UicColors.dangerSoft, Color(0xFFB91C1C)),
    info = Tone(UicColors.primarySoft, UicColors.primary),
    neutral = Tone(Color(0xFFF3F4F6), Color(0xFF4B5563)),
    slate = Tone(Color(0xFFF1F5F9), Color(0xFF475569)),
)

private val DarkTones = UicTones(
    success = Tone(Color(0xFF14532D), Color(0xFF86EFAC)),
    warning = Tone(Color(0xFF78350F), Color(0xFFFCD34D)),
    danger = Tone(Color(0xFF7F1D1D), Color(0xFFFCA5A5)),
    info = Tone(Color(0xFF1E3A8A), Color(0xFFBFDBFE)),
    neutral = Tone(Color(0xFF374151), Color(0xFFD1D5DB)),
    slate = Tone(Color(0xFF334155), Color(0xFFCBD5E1)),
)

val LocalUicTones = staticCompositionLocalOf { LightTones }

private val Light = lightColorScheme(
    primary = UicColors.primary,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDBEAFE),
    onPrimaryContainer = Color(0xFF1E3A8A),
    secondary = Color(0xFF334155),
    onSecondary = Color.White,
    secondaryContainer = UicColors.primarySoft,
    onSecondaryContainer = Color(0xFF1E3A8A),
    tertiary = UicColors.callGreen,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFDCFCE7),
    onTertiaryContainer = Color(0xFF14532D),
    error = UicColors.danger,
    onError = Color.White,
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
    background = UicColors.background,
    onBackground = UicColors.text,
    surface = Color.White,
    onSurface = UicColors.text,
    surfaceVariant = Color(0xFFF1F4F9),
    onSurfaceVariant = UicColors.mutedText,
    // Tonal steps so cards, sheets and inputs separate from the page without shadows.
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF9FAFD),
    surfaceContainer = Color(0xFFF1F4F9),
    surfaceContainerHigh = Color(0xFFE9EDF4),
    surfaceContainerHighest = Color(0xFFE2E7F0),
    outline = Color(0xFFD1D5DB),
    outlineVariant = UicColors.border,
)

private val Dark = darkColorScheme(
    primary = Color(0xFF93C5FD),
    onPrimary = Color(0xFF0B1F4D),
    primaryContainer = Color(0xFF1E3A8A),
    onPrimaryContainer = Color(0xFFDBEAFE),
    secondary = Color(0xFFCBD5E1),
    onSecondary = Color(0xFF1E293B),
    secondaryContainer = Color(0xFF1E293B),
    onSecondaryContainer = Color(0xFFDBEAFE),
    tertiary = Color(0xFF4ADE80),
    onTertiary = Color(0xFF052E16),
    tertiaryContainer = Color(0xFF14532D),
    onTertiaryContainer = Color(0xFFDCFCE7),
    error = Color(0xFFF87171),
    onError = Color(0xFF450A0A),
    errorContainer = Color(0xFF7F1D1D),
    onErrorContainer = Color(0xFFFEE2E2),
    background = Color(0xFF0B1120),
    onBackground = Color(0xFFE5E7EB),
    surface = Color(0xFF111827),
    onSurface = Color(0xFFE5E7EB),
    surfaceVariant = Color(0xFF1F2937),
    onSurfaceVariant = Color(0xFF9CA3AF),
    surfaceContainerLowest = Color(0xFF0B1120),
    surfaceContainerLow = Color(0xFF111827),
    surfaceContainer = Color(0xFF161E2E),
    surfaceContainerHigh = Color(0xFF1F2937),
    surfaceContainerHighest = Color(0xFF273244),
    outline = Color(0xFF4B5563),
    outlineVariant = Color(0xFF374151),
)

private val UicShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(8.dp),     // inputs, buttons, chips
    medium = RoundedCornerShape(12.dp),   // cards
    large = RoundedCornerShape(16.dp),    // dialogs, sheets
    extraLarge = RoundedCornerShape(16.dp),
)

// System font: bundling Inter needs font files in res/font; the scale below matches the web either way.
private fun style(size: Int, line: Int, weight: FontWeight = FontWeight.Normal) =
    TextStyle(fontFamily = FontFamily.Default, fontSize = size.sp, lineHeight = line.sp, fontWeight = weight)

/** Web scale: display 30/36, h1 24/32, h2 18/28, body 14/20, small 13/18, caption 12/16. */
private val UicTypography = Typography(
    displayLarge = style(36, 44, FontWeight.SemiBold),
    displayMedium = style(32, 40, FontWeight.SemiBold),
    displaySmall = style(30, 36, FontWeight.SemiBold),
    headlineLarge = style(28, 36, FontWeight.SemiBold),
    headlineMedium = style(24, 32, FontWeight.SemiBold),
    headlineSmall = style(20, 28, FontWeight.SemiBold),
    titleLarge = style(20, 28, FontWeight.SemiBold),
    titleMedium = style(18, 28, FontWeight.SemiBold),
    titleSmall = style(14, 20, FontWeight.SemiBold),
    bodyLarge = style(16, 24),
    bodyMedium = style(14, 20),
    bodySmall = style(13, 18),
    labelLarge = style(14, 20, FontWeight.Medium),
    labelMedium = style(13, 18, FontWeight.Medium),
    labelSmall = style(12, 16, FontWeight.Medium),
)

/** Material 3 with the shared palette; follows the phone's dark mode, no dynamic colour so every phone matches the web. */
@Composable
// Light only for now: many screens still use fixed light colours. Switch to isSystemInDarkTheme() once they use theme colours.
fun UicTheme(dark: Boolean = false, content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(LocalUicTones provides if (dark) DarkTones else LightTones) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, shapes = UicShapes, typography = UicTypography, content = content)
    }
}

/** Shortcut: `UicThemeTones.current.success` inside composables. */
object UicThemeTones {
    val current: UicTones @Composable get() = LocalUicTones.current
}
