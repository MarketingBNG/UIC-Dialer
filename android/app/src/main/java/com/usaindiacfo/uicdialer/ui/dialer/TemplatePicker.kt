package com.usaindiacfo.uicdialer.ui.dialer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ActivityType
import com.usaindiacfo.uicdialer.data.api.TemplateDto
import com.usaindiacfo.uicdialer.dialer.Dialer
import com.usaindiacfo.uicdialer.dialer.TemplateRender
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import kotlinx.coroutines.launch

/**
 * "Message templates · Send to <name>": WhatsApp / SMS, a template or "Write my own", an editable preview.
 * Send opens WhatsApp (wa.me) or the SMS app with the text filled in (never sent silently), then queues a
 * WHATSAPP activity with the channel, template and text.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TemplatePickerSheet(phone: String, contactName: String?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val c = appContainer()
    val scope = rememberCoroutineScope()
    val user by c.authRepository.currentUser.collectAsStateWithLifecycle()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var templates by remember { mutableStateOf(c.outcomeCatalog.templates) }
    LaunchedEffect(Unit) {
        c.outcomeCatalog.refresh()
        templates = c.outcomeCatalog.templates
    }
    var sms by remember { mutableStateOf(false) }
    var chosen by remember { mutableStateOf<TemplateDto?>(null) }
    var text by remember { mutableStateOf("") }
    val shown = templates.filter { if (sms) it.sms else it.whatsapp }
    val repName = TemplateRender.repName(user?.name, user?.email)

    fun choose(t: TemplateDto?) {
        chosen = t
        text = t?.let { TemplateRender.render(it.body, contactName, repName) }.orEmpty()
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Message templates", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(
                "Send to ${contactName?.takeIf { it.isNotBlank() } ?: phone}",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf(false to "WhatsApp", true to "SMS").forEachIndexed { i, (isSms, label) ->
                    SegmentedButton(
                        selected = sms == isSms,
                        onClick = { if (sms != isSms) { sms = isSms; if (chosen != null && !(if (isSms) chosen!!.sms else chosen!!.whatsapp)) choose(null) } },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
            shown.forEach { t ->
                TemplateRow(t.name, TemplateRender.render(t.body, contactName, repName), chosen?.id == t.id) { choose(t) }
            }
            if (shown.isEmpty()) {
                Text("No ${if (sms) "SMS" else "WhatsApp"} templates yet; write your own below.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            TemplateRow("Write my own", null, chosen == null && text.isEmpty()) { choose(null) }
            OutlinedTextField(
                value = text, onValueChange = { text = it.take(2000) },
                label = { Text("Message") }, modifier = Modifier.fillMaxWidth(), minLines = 3,
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, androidx.compose.ui.Alignment.End)) {
                TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
                Button(
                    enabled = text.isNotBlank(),
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = UicColors.callGreen, contentColor = Color.White),
                    onClick = {
                        val opened = if (sms) Dialer.sms(context, phone, text) else Dialer.whatsApp(context, phone, text)
                        if (!opened) return@Button
                        val sent = text
                        val templateId = chosen?.id
                        scope.launch {
                            c.activityRepository.log(
                                phone, ActivityType.WHATSAPP, note = sent,
                                channel = if (sms) "SMS" else "WHATSAPP", templateId = templateId,
                            )
                        }
                        onDismiss()
                    },
                ) { Text(if (sms) "Open SMS" else "Open WhatsApp") }
            }
        }
    }
}

@Composable
private fun TemplateRow(title: String, preview: String?, selected: Boolean, onClick: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(Modifier.padding(12.dp).heightIn(min = 24.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            preview?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}
