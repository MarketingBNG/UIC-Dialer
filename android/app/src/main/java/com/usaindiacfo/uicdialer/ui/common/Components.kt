package com.usaindiacfo.uicdialer.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.TopAppBarScrollBehavior
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicdialer.ui.calls.StatusText
import com.usaindiacfo.uicdialer.ui.calls.StatusTone
import com.usaindiacfo.uicdialer.ui.theme.Tone
import com.usaindiacfo.uicdialer.ui.theme.UicThemeTones

/** The five pill colours shared with the web Pill, plus slate (contact "No answer"). */
enum class PillTone { SUCCESS, WARNING, DANGER, INFO, NEUTRAL, SLATE }

@Composable
fun PillTone.colors(): Tone = UicThemeTones.current.let {
    when (this) {
        PillTone.SUCCESS -> it.success
        PillTone.WARNING -> it.warning
        PillTone.DANGER -> it.danger
        PillTone.INFO -> it.info
        PillTone.NEUTRAL -> it.neutral
        PillTone.SLATE -> it.slate
    }
}

/** Call/recording status tone to pill colour (BUSY is amber: needs a look, not urgent). */
fun StatusTone.pill(): PillTone = when (this) {
    StatusTone.GOOD -> PillTone.SUCCESS
    StatusTone.BUSY -> PillTone.WARNING
    StatusTone.BAD -> PillTone.DANGER
    StatusTone.INFO -> PillTone.INFO
    StatusTone.NEUTRAL -> PillTone.NEUTRAL
}

/**
 * The one status pill: soft background, strong text, leading icon (a dot when [icon] is null) so the
 * state doesn't rely on colour alone.
 */
@Composable
fun Pill(text: String, tone: PillTone, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val c = tone.colors()
    Surface(color = c.bg, contentColor = c.fg, shape = RoundedCornerShape(50), modifier = modifier) {
        Row(
            Modifier.padding(start = 8.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(14.dp))
            else Box(Modifier.size(6.dp).background(c.fg, CircleShape))
            Text(text, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A call/recording status from CallStatusText as a pill. */
@Composable
fun StatusPill(status: StatusText, modifier: Modifier = Modifier, icon: ImageVector? = null) =
    Pill(status.label, status.tone.pill(), modifier, icon)

/**
 * Shared top bar. [onBack] shows a back arrow; [subtitle] is a small grey line under the title
 * (e.g. the greeting on Today). Pass [scrollBehavior] to tint on scroll.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UicTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    centered: Boolean = false,
    scrollBehavior: TopAppBarScrollBehavior? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val titleContent = @Composable {
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(
                subtitle, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
    val nav = @Composable {
        if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
    }
    val colors = TopAppBarDefaults.topAppBarColors(
        containerColor = MaterialTheme.colorScheme.background,
        scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    )
    if (centered) CenterAlignedTopAppBar(title = titleContent, modifier = modifier, navigationIcon = nav, actions = actions, colors = colors, scrollBehavior = scrollBehavior)
    else TopAppBar(title = titleContent, modifier = modifier, navigationIcon = nav, actions = actions, colors = colors, scrollBehavior = scrollBehavior)
}

/** Empty state: icon in a soft circle, a title, one line of text, and at most one button. */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    text: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(56.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp)) }
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 16.dp))
        if (text != null) Text(
            text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp),
        )
        if (actionLabel != null && onAction != null) Button(onClick = onAction, modifier = Modifier.padding(top = 16.dp).height(40.dp)) { Text(actionLabel) }
    }
}

/** Section title in sentence case (no UPPERCASE labels), with an optional action on the right. */
@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(top = 24.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}
