package com.usaindiacfo.uicdialer.data.api

import kotlinx.serialization.Serializable

/** POST /v1/ringing: an incoming call on this phone, shown on the rep's own desktop (caller card). */
@Serializable
data class RingRequest(val state: String, val phone: String? = null)

@Serializable
data class RingResponse(val ok: Boolean = true)
