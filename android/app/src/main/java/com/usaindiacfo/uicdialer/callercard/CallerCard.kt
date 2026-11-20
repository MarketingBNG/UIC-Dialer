package com.usaindiacfo.uicdialer.callercard

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import com.usaindiacfo.uicdialer.R
import com.usaindiacfo.uicdialer.reminders.Notifications

/**
 * The card itself: a small window over the ringing screen when "display over other apps" is allowed, else a
 * heads-up notification. Plain Views (no Compose) because it lives outside any Activity. Main thread only.
 */
object CallerCard {
    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    @Volatile private var current: String? = null
    /** The current call was answered: a lookup finishing late must not put the card over the call. */
    @Volatile private var answered = false

    /** True if [number] isn't already being shown; marks it as the current caller. */
    @Synchronized
    fun claim(number: String): Boolean {
        if (current == number) return false
        current = number
        answered = false
        return true
    }

    fun canOverlay(context: Context) = Settings.canDrawOverlays(context)

    fun show(context: Context, info: CallerInfo) {
        if (current != info.number || answered) return // the call already ended or was answered
        main.removeCallbacksAndMessages(null)
        if (canOverlay(context) && runCatching { showOverlay(context, info) }.isSuccess) return
        showNotification(context, info)
    }

    /** Call answered: hide the card after [delayMs] and don't show one that is still being looked up. */
    fun hideAfter(context: Context, delayMs: Long) {
        answered = true
        main.removeCallbacksAndMessages(null)
        main.postDelayed({ hide(context) }, delayMs)
    }

    fun hide(context: Context) {
        current = null
        main.post {
            removeView(context)
            Notifications.cancel(context, Notifications.CALLER_ID)
        }
    }

    private fun removeView(context: Context) {
        view?.let { v -> runCatching { context.getSystemService(WindowManager::class.java).removeView(v) } }
        view = null
    }

    private fun showOverlay(context: Context, info: CallerInfo) {
        removeView(context)
        val wm = context.getSystemService(WindowManager::class.java)
        val v = build(context, info)
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // Not focusable and not touch-modal, so the dialer's answer/decline buttons keep working.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP
            y = dp(context, 64)
        }
        wm.addView(v, lp)
        view = v
    }

    private fun build(context: Context, info: CallerInfo): View {
        val pad = dp(context, 16)
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(context, 16).toFloat()
                setStroke(dp(context, 1), Color.parseColor("#E2E6EE"))
            }
            elevation = dp(context, 8).toFloat()
        }
        val header = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(
            text(context, "UIC Dialer · ${if (info.known) "Client calling" else "Incoming call"}", 12f, "#1F4E8C", bold = true),
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        val close = text(context, "✕", 18f, "#5B6475").apply {
            gravity = Gravity.CENTER
            contentDescription = "Close"
            minWidth = dp(context, 48); minHeight = dp(context, 48)
            setOnClickListener { hide(context.applicationContext) }
        }
        header.addView(close)
        card.addView(header)
        card.addView(text(context, info.title, 20f, "#0F2A4D", bold = true))
        info.subtitle?.let { card.addView(text(context, it, 14f, if (info.known) "#334155" else "#B45309")) }
        info.note?.let { card.addView(text(context, it, 14f, "#475569").apply { maxLines = 3; setPadding(0, dp(context, 6), 0, 0) }) }
        return LinearLayout(context).apply {
            setPadding(dp(context, 12), 0, dp(context, 12), 0)
            addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun text(context: Context, s: String, sp: Float, color: String, bold: Boolean = false) = TextView(context).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(Color.parseColor(color))
        if (bold) typeface = Typeface.DEFAULT_BOLD
        ellipsize = android.text.TextUtils.TruncateAt.END
    }

    private fun showNotification(context: Context, info: CallerInfo) {
        val body = listOfNotNull(info.subtitle, info.note).joinToString("\n")
        val n = NotificationCompat.Builder(context, Notifications.CH_CALLER)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(info.title)
            .setContentText(info.subtitle)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setTimeoutAfter(60_000)
            .setAutoCancel(true)
            .build()
        Notifications.notify(context, Notifications.CALLER_ID, n)
    }

    private fun dp(context: Context, v: Int) =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()
}
