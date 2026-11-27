package com.usaindiacfo.uicdialer.data.api

import kotlinx.serialization.Serializable

/** POST /v1/ringing: an incoming call on this phone, shown on the rep's own desktop (caller card). */
@Serializable
data class RingRequest(val state: String, val phone: String? = null)

@Serializable
data class RingResponse(val ok: Boolean = true)

/** POST /v1/remote-dial/ack: this phone placed (or couldn't place) the call the rep's laptop asked for. */
@Serializable
data class DialAckRequest(val id: String, val ok: Boolean, val error: String? = null)
