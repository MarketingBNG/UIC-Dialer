package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.data.db.DncHashDao
import com.usaindiacfo.uicdialer.sync.PrivacyFilter

/** Local do-not-call check against the hashed list (same key and hash as the client list and the server). */
class DncCheck(private val dao: DncHashDao) {
    suspend fun isDnc(number: String?): Boolean {
        val h = hashFor(number) ?: return false
        return runCatching { dao.contains(h) }.getOrDefault(false)
    }

    companion object {
        /** sha256 hex of PrivacyFilter.key(number); null for numbers too short to be a phone number. */
        fun hashFor(number: String?): String? {
            if (number.isNullOrBlank()) return null
            val k = PrivacyFilter.key(number)
            if (k.length < 6) return null
            return PrivacyFilter.hashKey(k)
        }
    }
}
