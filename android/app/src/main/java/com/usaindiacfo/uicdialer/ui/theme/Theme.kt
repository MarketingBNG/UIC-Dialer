package com.usaindiacfo.uicdialer.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Brand colours from the approved mockup; used where Material roles don't fit (call button, overdue, sidebar). */
object UicColors {
    val primary = Color(0xFF1F4E8C)
    val navy = Color(0xFF0F2A4D)
    val callGreen = Color(0xFF15803D)
    val overdue = Color(0xFFB91C1C)
    val amber = Color(0xFFB45309)
    val background = Color(0xFFF6F7FB)
    val keyBg = Color(0xFFEEF1F7)
}

private val Light = lightColorScheme(
    primary = UicColors.primary,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE7F7),
    onPrimaryContainer = Color(0xFF0F2A4D),
    secondary = UicColors.navy,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE6ECF5),
    onSecondaryContainer = Color(0xFF0F2A4D),
    tertiary = UicColors.callGreen,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFDDF3E4),
    onTertiaryContainer = Color(0xFF14532D),
    error = UicColors.overdue,
    errorContainer = Color(0xFFFDE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
    background = UicColors.background,
    onBackground = Color(0xFF0F1B2D),
    surface = Color.White,
    onSurface = Color(0xFF0F1B2D),
    surfaceVariant = UicColors.keyBg,
    onSurfaceVariant = Color(0xFF5B6577),
    surfaceContainer = Color.White,
    surfaceContainerLow = Color.White,
    surfaceContainerHigh = Color.White,
    surfaceContainerHighest = UicColors.keyBg,
    outline = Color(0xFFCBD2DE),
    outlineVariant = Color(0xFFE3E7EF),
)

private val UicShapes = Shapes(
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(16.dp),
)

/** Material 3 with the brand palette, always light (no dark mode, no dynamic colour), so every phone looks like the mockup. */
@Composable
fun UicTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Light, shapes = UicShapes, content = content)
}
