package com.usaindiacfo.uicrecorder.ui.dialer

import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.dialer.Dialer
import com.usaindiacfo.uicrecorder.ui.theme.UicColors

private val KEYS = listOf(
    "1" to "", "2" to "ABC", "3" to "DEF",
    "4" to "GHI", "5" to "JKL", "6" to "MNO",
    "7" to "PQRS", "8" to "TUV", "9" to "WXYZ",
    "*" to "", "0" to "+", "#" to "",
)

@Composable
fun DialerScreen(onOpenContact: (phone: String) -> Unit) {
    val container = appContainer()
    val vm: DialerViewModel = viewModel(factory = viewModelFactory { initializer { DialerViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val call = rememberCaller()
    @Suppress("DEPRECATION") val clipboard = LocalClipboardManager.current

    val number = DialLogic.cleanNumber(state.number)
    val canDial = DialLogic.last10(number) != null
    fun type(k: String) = vm.setNumber((state.number + k).take(40))

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        BasicTextField(
            value = state.number,
            onValueChange = { vm.setNumber(it.take(40)) },
            singleLine = true,
            textStyle = TextStyle(fontSize = 32.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onBackground),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            decorationBox = { inner ->
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    if (state.number.isEmpty()) Text("Enter a number", fontSize = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    inner()
                }
            },
        )
        val match = state.matches.firstOrNull()
        if (match != null) MatchCard(match) { onOpenContact(match.phoneE164) }
        else if (state.number.isEmpty()) {
            TextButton(onClick = { clipboard.getText()?.text?.let { vm.setNumber(DialLogic.cleanNumber(it).take(40)) } }) { Text("Paste number") }
        } else if (canDial) {
            TextButton(onClick = { onOpenContact(number) }) { Text("Details and notes for this number") }
        }

        KEYS.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                row.forEach { (digit, letters) ->
                    Key(digit, letters, onClick = { type(digit) }, onLongClick = if (digit == "0") ({ type("+") }) else null)
                }
            }
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(
                onClick = { if (Dialer.whatsApp(context, number)) vm.logWhatsApp(number) },
                enabled = canDial,
                modifier = Modifier.size(76.dp),
                shape = CircleShape,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            ) { Text("WA", fontWeight = FontWeight.SemiBold, color = if (canDial) Color(0xFF128C7E) else Color.Unspecified) }
            FilledIconButton(
                onClick = { call(number) },
                enabled = canDial,
                modifier = Modifier.size(76.dp),
                colors = IconButtonDefaults.filledIconButtonColors(containerColor = UicColors.callGreen, contentColor = Color.White),
            ) { Icon(Icons.Filled.Call, contentDescription = "Call", modifier = Modifier.size(32.dp)) }
            Box(
                Modifier.size(76.dp).clip(CircleShape).combinedClickableCompat(
                    enabled = state.number.isNotEmpty(),
                    onClick = { vm.setNumber(state.number.dropLast(1)) },
                    onLongClick = { vm.setNumber("") },
                ),
                contentAlignment = Alignment.Center,
            ) {
                if (state.number.isNotEmpty()) Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Delete", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.size(8.dp))
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
private fun Key(digit: String, letters: String, onClick: () -> Unit, onLongClick: (() -> Unit)?) {
    Column(
        Modifier.size(76.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
            .combinedClickableCompat(onClick = onClick, onLongClick = onLongClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(digit, fontSize = 28.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSurface)
        Text(letters, fontSize = 10.sp, letterSpacing = 1.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableCompat(enabled: Boolean = true, onClick: () -> Unit, onLongClick: (() -> Unit)?) =
    combinedClickable(enabled = enabled, onClick = onClick, onLongClick = onLongClick)
