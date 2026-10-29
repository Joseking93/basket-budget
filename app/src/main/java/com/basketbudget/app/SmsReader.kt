package com.basketbudget.app

import android.content.Context
import android.provider.Telephony

/**
 * Reads M-PESA's own messages out of the phone's inbox.
 *
 * The page already knows how to turn those messages into transactions — that
 * is what the paste box has always done. This only fetches them, so nothing
 * has to be copied by hand and a statement PDF stops being the way in.
 *
 * Nothing is sent anywhere. The text goes straight to the page running in this
 * app and is stored on the device, like everything else here.
 */
object SmsReader {

    /** Safaricom sends from MPESA; some handsets record it with a hyphen. */
    private const val SENDERS = "address LIKE 'MPESA' OR address LIKE 'M-PESA'"

    /** A confirmed transaction always opens with its receipt code. */
    private val LOOKS_LIKE_TRANSACTION = Regex("""^[A-Z0-9]{10}\s+Confirmed""")

    data class Batch(
        val messages: List<String>,
        val newest: Long,
        /** True when [limit] stopped the read before the inbox ran out. */
        val truncated: Boolean = false,
    )

    /**
     * Every M-PESA message newer than [since], oldest first so the page reads
     * them in the order they happened.
     *
     * @param since epoch millis; 0 reads the whole inbox.
     */
    fun read(context: Context, since: Long = 0L, limit: Int = 50_000): Batch {
        val where = StringBuilder("($SENDERS)")
        if (since > 0) where.append(" AND date > ").append(since)

        val bodies = ArrayList<String>()
        var newest = since

        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.BODY, Telephony.Sms.DATE),
            where.toString(),
            null,
            "${Telephony.Sms.DATE} ASC",
        )?.use { cursor ->
            val body = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val date = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
            while (cursor.moveToNext() && bodies.size < limit) {
                val text = cursor.getString(body)?.trim().orEmpty()
                // Balance enquiries and adverts come from the same sender and
                // would only land in the page's "could not read" pile.
                if (text.isNotEmpty() && LOOKS_LIKE_TRANSACTION.containsMatchIn(text)) {
                    val at = cursor.getLong(date)
                    // Several M-PESA messages carry no date of their own - a Fuliza
                    // repayment is the common one, and there are hundreds of those.
                    // The page cannot place a transaction it cannot date, so each
                    // body goes over with the moment the message arrived, which is
                    // within seconds of when it happened. The parser reads the
                    // stamp, uses it only where the text gives no date, and strips
                    // it before storing anything.
                    bodies.add("#at " + at + "\n" + text)
                    if (at > newest) newest = at
                }
            }
        }

        return Batch(bodies, newest, truncated = bodies.size >= limit)
    }
}
