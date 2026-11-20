package com.usaindiacfo.uicdialer

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.usaindiacfo.uicdialer.data.api.AuthResponse
import com.usaindiacfo.uicdialer.data.api.Role
import com.usaindiacfo.uicdialer.data.api.UserDto

/**
 * Debug builds only (src/debug): signs the app in with tokens from server/scripts/dev-token.ts, so the app can be
 * tried on an emulator against a local server without Google sign-in. Release builds don't contain this class.
 *
 *   adb shell am start -n com.usaindiacfo.uicdialer/.DevSignInActivity \
 *     --es access <token> --es refresh <token> --es uid <id> --es email <email> --es role ADMIN
 */
class DevSignInActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val e = intent.extras
        val access = e?.getString("access")
        val refresh = e?.getString("refresh")
        val uid = e?.getString("uid")
        val email = e?.getString("email")
        if (access != null && refresh != null && uid != null && email != null) {
            val role = runCatching { Role.valueOf(e.getString("role") ?: "AGENT") }.getOrDefault(Role.AGENT)
            (application as UicApp).container.tokenStore.save(
                AuthResponse(access, refresh, 900, UserDto(uid, email, e.getString("name"), role)),
            )
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        }
        finish()
    }
}
