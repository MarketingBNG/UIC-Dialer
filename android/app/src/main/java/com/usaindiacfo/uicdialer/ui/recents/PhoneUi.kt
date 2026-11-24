package com.usaindiacfo.uicdialer.ui.recents

import android.content.Context
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicdialer.data.api.ContactDto
import com.usaindiacfo.uicdialer.dialer.Dialer
import com.usaindiacfo.uicdialer.phonebook.PhoneBook
import com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic

/** Inline "this needs a permission" card with an Allow button (asks the system; after a hard deny it opens nothing). */
@Composable
fun PermissionPrompt(text: String, permission: String, onResult: (Boolean) -> Unit) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission(), onResult)
    Card(
        Modifier.fillMaxWidth().padding(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
            Button(onClick = { launcher.launch(permission) }) { Text("Allow") }
        }
    }
}

/** CRM names by number key, from the offline-cached CRM lists. */
fun crmNames(contacts: List<ContactDto>): Map<String, String?> =
    contacts.mapNotNull { c -> PhoneBookLogic.numberKey(c.phoneE164)?.let { it to c.name?.takeIf { n -> n.isNotBlank() } } }.toMap()

/**
 * Overflow actions for any number: copy, CRM detail, save contact, SMS, WhatsApp.
 * [inCrm] labels the CRM item "Open CRM contact" (otherwise "Details and notes").
 */
@Composable
fun NumberMenu(
    expanded: Boolean,
    onDismiss: () -> Unit,
    number: String,
    name: String?,
    inCrm: Boolean,
    savedOnPhone: Boolean,
    onOpenCrm: (String) -> Unit,
    extra: (@Composable (close: () -> Unit) -> Unit)? = null,
) {
    val context = LocalContext.current
    @Suppress("DEPRECATION") val clipboard = LocalClipboardManager.current
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(text = { Text("Copy number") }, onClick = {
            onDismiss(); clipboard.setText(AnnotatedString(number)); toast(context, "Number copied")
        })
        DropdownMenuItem(text = { Text(if (inCrm) "Open CRM contact" else "CRM details and notes") }, onClick = { onDismiss(); onOpenCrm(number) })
        if (!savedOnPhone) {
            DropdownMenuItem(text = { Text("Create new contact") }, onClick = { onDismiss(); PhoneBook.createContact(context, number, name) })
            DropdownMenuItem(text = { Text("Add to existing contact") }, onClick = { onDismiss(); PhoneBook.addToExisting(context, number) })
        }
        DropdownMenuItem(text = { Text("Send SMS") }, onClick = { onDismiss(); Dialer.sms(context, number, "") })
        DropdownMenuItem(text = { Text("WhatsApp") }, onClick = { onDismiss(); Dialer.whatsApp(context, number) })
        extra?.invoke(onDismiss)
    }
}

internal fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()
