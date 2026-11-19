package com.usaindiacfo.uicrecorder.dialer

/**
 * Message template rendering, identical to the server's renderTemplate and the dashboard (shared test vectors):
 * {name} = first word of the contact name, or "there"; {rep} = the rep's first name. Case-sensitive; unknown
 * placeholders stay as they are.
 */
object TemplateRender {
    fun render(body: String, contactName: String?, repName: String?): String {
        val name = firstWord(contactName) ?: "there"
        val rep = firstWord(repName).orEmpty()
        return body.replace("{name}", name).replace("{rep}", rep)
    }

    /** Rep's first name from the profile name, else the email's local part. */
    fun repName(name: String?, email: String?): String? =
        name?.takeIf { it.isNotBlank() } ?: email?.substringBefore('@')?.takeIf { it.isNotBlank() }

    private fun firstWord(s: String?): String? = s?.trim()?.split(Regex("\\s+"))?.firstOrNull()?.takeIf { it.isNotEmpty() }
}
