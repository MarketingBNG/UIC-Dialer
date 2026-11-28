package com.usaindiacfo.uicdialer.data.api

import kotlinx.serialization.Serializable

/** POST /v1/client-errors: a problem on this phone, shown to admins on the Health page. Message is cut to 300 chars. */
@Serializable
data class ClientErrorRequest(val kind: String, val message: String)

@Serializable
data class ClientErrorResponse(val ok: Boolean = true)
