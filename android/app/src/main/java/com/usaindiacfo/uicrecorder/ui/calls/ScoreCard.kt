package com.usaindiacfo.uicrecorder.ui.calls

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicrecorder.data.api.CallScore
import com.usaindiacfo.uicrecorder.ui.theme.UicColors

/** "AI score" card: overall /100, script adherence, sentiment, objections, next step, strengths, improvements. */
@Composable
internal fun ScoreCard(score: CallScore?, pending: Boolean) {
    if (score == null) {
        if (pending) Text("Scoring…", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
        return
    }
    Card(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("AI score", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Text("Customer: ${score.sentiment}", style = MaterialTheme.typography.labelMedium)
            }
            Row(verticalAlignment = Alignment.Bottom) {
                Text("${score.overall}", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold, color = scoreColor(score.overall))
                Text(" /100", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
            }
            score.scriptAdherence?.let { pct ->
                Text("Script adherence $pct%", style = MaterialTheme.typography.labelLarge)
                LinearProgressIndicator(progress = { (pct / 100f).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
            }
            if (score.objections.isNotEmpty()) {
                Text("Objections", style = MaterialTheme.typography.labelLarge)
                score.objections.forEach { o ->
                    Text(
                        (if (o.handled) "✓ " else "✗ ") + o.objection,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (o.handled) UicColors.callGreen else UicColors.overdue,
                    )
                }
            }
            score.nextStep?.takeIf { it.isNotBlank() }?.let {
                Text("Next step", style = MaterialTheme.typography.labelLarge)
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
            if (score.strengths.isNotEmpty()) {
                Text("Strengths", style = MaterialTheme.typography.labelLarge)
                score.strengths.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
            }
            if (score.improvements.isNotEmpty()) {
                Text("Improvements", style = MaterialTheme.typography.labelLarge)
                score.improvements.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium) }
            }
            Text("Scored by AI from the transcript; use it for coaching, not as a verdict.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun scoreColor(n: Int) = when {
    n >= 75 -> UicColors.callGreen
    n >= 50 -> UicColors.amber
    else -> UicColors.overdue
}
