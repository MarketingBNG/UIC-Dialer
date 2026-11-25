package com.usaindiacfo.uicdialer.ui.dialer

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.usaindiacfo.uicdialer.data.api.ContactStatus
import com.usaindiacfo.uicdialer.ui.theme.UicColors

/** Initials circle. With [onClick] the hit area is at least 48 dp. */
@Composable
fun Avatar(name: String?, size: Dp = 40.dp, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, sharedKey: String? = null) {
    val inner = @Composable {
        Box(
            Modifier.sharedAvatar(sharedKey).size(size).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                initials(name), color = MaterialTheme.colorScheme.onPrimaryContainer,
                fontWeight = FontWeight.SemiBold, fontSize = (size.value * 0.36f).sp,
            )
        }
    }
    if (onClick == null) Box(modifier) { inner() }
    else Box(modifier.size(maxOf(size, 48.dp)).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) { inner() }
}

/** Shared-element scopes, provided by AppNavigation around the NavHost and each screen. */
@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = staticCompositionLocalOf<SharedTransitionScope?> { null }
val LocalScreenScope = staticCompositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * The same person's avatar on two screens morphs from one to the other when navigating (WhatsApp's chat-photo
 * animation). [key] is the phone number; avatars without a key, or outside a navigated screen, are unchanged.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedAvatar(key: String?): Modifier {
    val shared = LocalSharedScope.current ?: return this
    val screen = LocalScreenScope.current ?: return this
    val k = com.usaindiacfo.uicdialer.dialer.DialLogic.last10(key) ?: return this
    return with(shared) { this@sharedAvatar.sharedElement(rememberSharedContentState("avatar-$k"), screen, boundsTransform = { _, _ -> com.usaindiacfo.uicdialer.ui.theme.Motion.spec() }) }
}

/** Small rounded label. */
@Composable
fun Chip(text: String, bg: Color, fg: Color, modifier: Modifier = Modifier) {
    Surface(color = bg, contentColor = fg, shape = RoundedCornerShape(8.dp), modifier = modifier) {
        Text(text, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
    }
}

@Composable
fun StatusChip(status: ContactStatus) {
    val (bg, fg) = when (status) {
        ContactStatus.INTERESTED -> Color(0xFFDDF3E4) to Color(0xFF166534)
        ContactStatus.CALL_BACK -> Color(0xFFFEF3C7) to UicColors.amber
        ContactStatus.NOT_INTERESTED -> Color(0xFFF1F5F9) to Color(0xFF475569)
        ContactStatus.NO_ANSWER -> Color(0xFFFCE7D6) to Color(0xFF9A3412)
        ContactStatus.NEW -> Color(0xFFDCE7F7) to UicColors.primary
    }
    Chip(status.label, bg, fg)
}

/** "via laptop" etc.; renders nothing for null. */
@Composable
fun ViaChip(via: String?) {
    val text = viaLabel(via) ?: return
    Chip(text, MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Round green call button (48 dp). */
@Composable
fun GreenCallButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, size: Dp = 48.dp) {
    FilledIconButton(
        onClick = onClick, enabled = enabled, modifier = modifier.size(size),
        colors = IconButtonDefaults.filledIconButtonColors(containerColor = UicColors.callGreen, contentColor = Color.White),
    ) { Icon(Icons.Filled.Call, contentDescription = "Call") }
}
