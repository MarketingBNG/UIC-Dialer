package com.usaindiacfo.uicdialer

import android.app.Application
import com.usaindiacfo.uicdialer.sync.SyncScheduler

class UicApp : Application() {
    val container by lazy { AppContainer(this) }

    override fun onCreate() {
        super.onCreate()
        SyncScheduler.init(this)
        // Before anything can notify (a ringing call may be what started the process).
        com.usaindiacfo.uicdialer.reminders.Notifications.createChannels(this)
        container.watchSession()
        container.liveEvents.attach(this)
    }
}
