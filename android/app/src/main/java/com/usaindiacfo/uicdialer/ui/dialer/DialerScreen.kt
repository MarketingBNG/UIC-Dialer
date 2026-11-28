package com.usaindiacfo.uicdialer.ui.dialer

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.height
import androidx.compose.material3.ripple
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ContactDto
import com.usaindiacfo.uicdialer.dialer.DialLogic
import com.usaindiacfo.uicdialer.dialer.Dialer
import com.usaindiacfo.uicdialer.ui.theme.UicColors

private val KEYS = listOf(
    "1" to "", "2" to "ABC", "3" to "DEF",
    "4" to "GHI", "5" to "JKL", "6" to "MNO",
    "7" to "PQRS", "8" to "TUV", "9" to "WXYZ",
    "*" to "", "0" to "+", "#" to "",
)

@Composable
fun DialerScreen(onOpenContact: (phone: String) -> Unit) {
    val container = appContainer()
    val context = LocalContext.current
    val vm: DialerViewModel = viewModel(factory = viewModelFactory { initializer { DialerViewModel(container, context.applicationContext) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val call = rememberCaller()
    @Suppress("DEPRECATION") val clipboard = LocalClipboardManager.current
    val view = LocalView.current

    val number = DialLogic.cleanNumber(state.number)
    val canDial = DialLogic.last10(number) != null
    fun tap() { view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }
    fun type(k: String) { tap(); vm.setNumber((state.number + k).take(40)) }

    // Fixed layout like a phone's own keypad: suggestions fill the top; the number and keys stay put at the bottom.
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp)) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.Bottom),
        ) {
            val match = state.matches.firstOrNull()
            if (match != null) MatchCard(match) { onOpenContact(match.phoneE164) }
            state.suggestions.filter { s -> match == null || !DialLogic.sameNumber(s.number, match.phoneE164) }.take(4).forEach { s ->
                // Keyed by number so a row that stays in the list keeps its place and state while typing.
                key(s.number) { SuggestionRow(s, onPick = { vm.setNumber(DialLogic.cleanNumber(s.number).take(40)) }, onCall = { call(s.number) }) }
            }
            if (match == null && canDial) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { onOpenContact(number) }) { Text("Notes") }
                if (!state.savedOnPhone) {
                    TextButton(onClick = { com.usaindiacfo.uicdialer.phonebook.PhoneBook.createContact(context, number) }) { Text("New contact") }
                    TextButton(onClick = { com.usaindiacfo.uicdialer.phonebook.PhoneBook.addToExisting(context, number) }) { Text("Add to contact") }
                }
            }
        }

        // Number + delete. Fixed height, so nothing jumps while typing.
        Row(Modifier.fillMaxWidth().height(64.dp), verticalAlignment = Alignment.CenterVertically) {
            Spacer(Modifier.size(48.dp))
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                if (state.number.isEmpty()) {
                    TextButton(onClick = { clipboard.getText()?.text?.let { vm.setNumber(DialLogic.cleanNumber(it).take(40)) } }) {
                        Text("Paste number", fontSize = 16.sp)
                    }
                } else {
                    BasicTextField(
                        value = state.number,
                        onValueChange = {},
                        // The on-screen keypad is the only input (T9 finds names). Tapping here used to pop
                        // the system keyboard, which pushed the keypad up and out of place mid-typing.
                        readOnly = true,
                        singleLine = true,
                        textStyle = TextStyle(
                            fontSize = if (state.number.length > 13) 26.sp else 34.sp, fontWeight = FontWeight.Medium,
                            textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onBackground,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            Box(
                Modifier.size(48.dp).clip(CircleShape).combinedClickableCompat(
                    enabled = state.number.isNotEmpty(),
                    onClick = { tap(); vm.setNumber(state.number.dropLast(1)) },
                    onLongClick = { tap(); vm.setNumber("") },
                ),
                contentAlignment = Alignment.Center,
            ) {
                if (state.number.isNotEmpty()) Icon(BackspaceIcon, contentDescription = "Delete (hold to clear)", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        KEYS.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                row.forEach { (digit, letters) ->
                    Key(digit, letters, onClick = { type(digit) }, onLongClick = if (digit == "0") ({ type("+") }) else null)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 16.dp),
            horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                Modifier.size(76.dp).clip(CircleShape).combinedClickableCompat(
                    enabled = canDial, onClick = { if (Dialer.whatsApp(context, number)) vm.logWhatsApp(number) }, onLongClick = null,
                ),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                val tint = if (canDial) Color(0xFF128C7E) else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
                Icon(ChatIcon, contentDescription = null, tint = tint)
                Text("WhatsApp", fontSize = 11.sp, color = tint)
            }
            // Always green. With nothing typed it fills in the last number dialled (like a phone's own keypad).
            val lastDialed = vm.lastDialed()
            val callEnabled = canDial || (state.number.isEmpty() && lastDialed != null)
            FilledIconButton(
                onClick = {
                    tap()
                    if (canDial) call(number) else lastDialed?.let { vm.setNumber(DialLogic.cleanNumber(it).take(40)) }
                },
                enabled = callEnabled,
                modifier = Modifier.size(76.dp),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = UicColors.callGreen, contentColor = Color.White,
                    disabledContainerColor = UicColors.callGreen.copy(alpha = 0.45f), disabledContentColor = Color.White,
                ),
            ) { Icon(Icons.Filled.Call, contentDescription = "Call", modifier = Modifier.size(32.dp)) }
            Spacer(Modifier.size(76.dp))
        }
    }
}

@Composable
private fun MatchCard(contact: ContactDto, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Avatar(contact.name)
            Column(Modifier.weight(1f)) {
                Text(contact.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(contact.company?.takeIf { it.isNotBlank() }, contact.status.label).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun SuggestionRow(s: com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.Suggestion, onPick: () -> Unit, onCall: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(onClick = onPick).padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(s.name, size = 32.dp)
        Column(Modifier.weight(1f)) {
            Text(s.name ?: s.number, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val src = when (s.source) {
                com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.Source.PHONE -> "Phone contact"
                com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.Source.CRM -> "CRM"
                com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.Source.RECENT -> "Recent"
            }
            Text(
                listOfNotNull(s.number.takeIf { s.name != null }, src).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
            )
        }
        GreenCallButton(onClick = onCall, size = 40.dp)
    }
}

@Composable
private fun Key(digit: String, letters: String, onClick: () -> Unit, onLongClick: (() -> Unit)?) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, if (pressed) com.usaindiacfo.uicdialer.ui.theme.Motion.fast() else com.usaindiacfo.uicdialer.ui.theme.Motion.spec(), label = "key")
    Column(
        Modifier.size(72.dp).graphicsLayer { scaleX = scale; scaleY = scale }.clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .combinedClickableWith(source, onClick, onLongClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(digit, fontSize = 28.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface)
        if (letters.isNotEmpty()) Text(letters, fontSize = 10.sp, letterSpacing = 1.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Modifier.combinedClickableWith(source: MutableInteractionSource, onClick: () -> Unit, onLongClick: (() -> Unit)?) =
    combinedClickable(interactionSource = source, indication = ripple(), onClick = onClick, onLongClick = onLongClick)

/** Material "backspace" (outlined) and "chat" icons; the app ships only the core icon set. */
private val BackspaceIcon: ImageVector = ImageVector.Builder("Backspace", 24.dp, 24.dp, 24f, 24f).apply {
    path(fill = SolidColor(Color.Black)) {
        moveTo(22f, 3f); horizontalLineTo(7f); curveToRelative(-0.69f, 0f, -1.23f, 0.35f, -1.59f, 0.88f)
        lineTo(0f, 12f); lineToRelative(5.41f, 8.11f); curveToRelative(0.36f, 0.53f, 0.9f, 0.89f, 1.59f, 0.89f)
        horizontalLineToRelative(15f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f); verticalLineTo(5f)
        curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f); close()
        moveTo(22f, 19f); horizontalLineTo(7.07f); lineTo(2.4f, 12f); lineToRelative(4.66f, -7f); horizontalLineTo(22f); verticalLineToRelative(14f); close()
        moveTo(10.41f, 17f); lineTo(14f, 13.41f); lineTo(17.59f, 17f); lineTo(19f, 15.59f); lineTo(15.41f, 12f)
        lineTo(19f, 8.41f); lineTo(17.59f, 7f); lineTo(14f, 10.59f); lineTo(10.41f, 7f); lineTo(9f, 8.41f)
        lineTo(12.59f, 12f); lineTo(9f, 15.59f); close()
    }
}.build()

private val ChatIcon: ImageVector = ImageVector.Builder("Chat", 24.dp, 24.dp, 24f, 24f).apply {
    path(fill = SolidColor(Color.Black)) {
        moveTo(20f, 2f); horizontalLineTo(4f); curveToRelative(-1.1f, 0f, -2f, 0.9f, -2f, 2f); verticalLineToRelative(18f)
        lineToRelative(4f, -4f); horizontalLineToRelative(14f); curveToRelative(1.1f, 0f, 2f, -0.9f, 2f, -2f); verticalLineTo(4f)
        curveToRelative(0f, -1.1f, -0.9f, -2f, -2f, -2f); close()
        moveTo(20f, 16f); horizontalLineTo(5.17f); lineTo(4f, 17.17f); verticalLineTo(4f); horizontalLineToRelative(16f); verticalLineToRelative(12f); close()
    }
}.build()

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableCompat(enabled: Boolean = true, onClick: () -> Unit, onLongClick: (() -> Unit)?) =
    combinedClickable(enabled = enabled, onClick = onClick, onLongClick = onLongClick)
