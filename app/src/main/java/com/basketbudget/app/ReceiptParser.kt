package com.basketbudget.app

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** One line of recognised text with the box ML Kit found it in. */
data class OcrLine(
    val text: String,
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
)

data class ReceiptItem(
    val name: String,
    val qty: Int,
    val price: Double,
    val total: Double,
)

data class ReceiptScan(
    val items: List<ReceiptItem>,
    val receiptTotal: Double?,
    /** What the slip says it has, from its own "TOTAL LINES" row. */
    val lineCount: Int? = null,
)

/**
 * Turns the text off a Naivas till slip into basket items.
 *
 * The slip prints each item as a block of two or three rows, not one:
 *
 *     12500522      (2pcs)          2 x 105.00
 *     CUSSONS MILD & GENTLE BABY      210.00   A
 *     SOAP 100G
 *     DISCOUNT                            50
 *
 * The first row is a stock code, the quantity and the unit price; the second
 * carries the name and the line total followed by a VAT class; the name can run
 * on; a DISCOUNT row belongs to the item above it. Line totals are printed
 * BEFORE discount, which is why the slip's own "TOTAL BEFORE DISCOUNT" is what
 * they add up to.
 *
 * Deliberately free of Android imports so the whole thing runs in a plain JVM
 * unit test - see ReceiptParserTest.
 */
object ReceiptParser {

    private const val MAX_ITEMS = 120

    /** A number as a till prints it: 60, 129.00, 1,290.50. */
    private val NUMBER = Regex("""\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?""")

    /**
     * A line total always carries cents: 210.00, 1,149.00. OCR turns the point
     * into a comma ("170,00") and a trailing zero into a letter ("3,650.0o"),
     * so both are allowed - but only in the cents, never in the shillings.
     */
    private const val MONEY_PAT = """\d{1,3}(?:,\d{3})*[.,][0-9oO]{2}"""
    private val MONEY = Regex(MONEY_PAT)

    /**
     * The quantity in the stock-code row: (2pcs), (1pcs), (0.605351kg). OCR
     * reads a leading zero as a letter, so "(0.225301pcs)" arrives as
     * "(o.225301pcs)" - and an unrecognised marker loses the whole item.
     */
    private val PACK_QTY = Regex(
        """\(\s*([0-9oO]+(?:\.[0-9oO]+)?)\s*(?:pcs?|kgs?|gms?|g|ltrs?|l|ml)\s*\)""",
        RegexOption.IGNORE_CASE,
    )

    /** "2 x 105.00", "0.605351 x 299.00", "3 @ 55.50". */
    private val QTY_PRICE = Regex(
        """([0-9oO]+(?:\.[0-9oO]+)?)\s*[xX*@]\s*($MONEY_PAT|\d+)"""
    )

    /** Dates, times and serial numbers: 28/10/2026, 17:25:03, 2026-10-28. */
    private val DATEISH = Regex("""\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}|\d{1,2}:\d{2}""")

    /**
     * Words that mean the row is not an item. Matched on whole words only, so
     * CASHEW NUTS survives the CASH rule and PINEAPPLE survives the PIN rule.
     */
    private val NOISE_WORDS = listOf(
        "VAT", "TAX", "TAXABLE", "CHANGE", "CASH", "TENDERED",
        "MPESA", "M-PESA", "PESA", "TILL", "PIN", "TEL", "PHONE", "MOBILE",
        "RECEIPT", "INVOICE", "CU", "KRA", "SERIAL", "REF", "TRANS", "TRN",
        "CASHIER", "SERVED", "OPERATOR", "TERMINAL", "STORE", "BRANCH", "LTD", "LIMITED",
        "NAIVAS", "WELCOME", "THANK", "THANKS", "CUSTOMER", "LOYALTY", "POINTS", "PTS",
        "BALANCE", "SAVINGS", "SAVED", "QTY", "QUANTITY",
        "DESCRIPTION", "DESC", "PRICE", "AMOUNT", "AMT", "NET", "GROSS",
        "PAYMENT", "PAID", "CARD", "VISA", "MASTERCARD", "DEBIT", "CREDIT",
        "EXCLUSIVE", "INCLUSIVE", "EXEMPT", "RATED", "COPY", "DUPLICATE",
    )

    private val NOISE = Regex(
        "\\b(" + NOISE_WORDS.joinToString("|") { Regex.escape(it) } + ")\\b",
        RegexOption.IGNORE_CASE,
    )

    /** Spelt loosely, because OCR produced DISCOUWNT on a real slip. */
    private const val DISCOUNT_PAT = """\bDISCOU[A-Za-z]{0,2}NT\b"""
    private val DISCOUNT_AWARDED =
        Regex("""$DISCOUNT_PAT\s+AWARDED""", RegexOption.IGNORE_CASE)
    private val DISCOUNT_ROW = Regex(DISCOUNT_PAT, RegexOption.IGNORE_CASE)
    private val TOTAL_BEFORE = Regex("""\bTOTAL\s+BEFORE\s+DISCOUNT\b""", RegexOption.IGNORE_CASE)
    private val SUBTOTAL_ROW = Regex("""\bSUB\s*TOTAL\b""", RegexOption.IGNORE_CASE)
    private val TOTAL_ROW = Regex("""\bTOTAL\b""", RegexOption.IGNORE_CASE)
    /** "TOTAL LINES: 57" is the slip's own count of the items on it. */
    private val TOTAL_LINES = Regex("""\bTOTAL\s+LINES?\b""", RegexOption.IGNORE_CASE)

    /** Rows whose number is a count or a tax, never the bill. */
    private val NOT_THE_TOTAL = Regex(
        """\b(LINES?|ITEMS?|QTY|QUANTITY|PIECES|PCS|VAT|TAX|SAVINGS)\b""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * A leading stock code: "12500522", "N056754", "2036085000000". OCR reads
     * the zero in "N015722" as a letter, giving "No15722", so up to three
     * letters are allowed in front of the digits.
     */
    private val LEADING_CODE = Regex("""^\s*[A-Za-z]{0,3}\d{4,}\b\s*""")

    /** The code that opens an item block, used to spot a line read twice. */
    private val STOCK_CODE = Regex("""^\s*([A-Za-z]{0,3}\d{4,})\b""")

    /** A stock code anywhere in a row, not just at the start. */
    private val ANY_CODE = Regex("""\b[A-Za-z]{0,3}\d{5,}\b""")

    /** A row that is nothing but a stock code carries no name. */
    private val CODE_ONLY = Regex("""^[A-Za-z]{0,3}\d{4,}$""")

    private val JUNK_CHARS = Regex("""[|\\_#]+""")
    private val SPACES = Regex("""\s+""")
    /** A lone figure in the money column, set off by a column gap. */
    private val TRAILING_FIGURE = Regex("""\s{2,}(\d{1,4})\s*$""")

    /** At least one run of two letters, so a name is a name and not debris. */
    private val WORDISH = Regex("""[A-Za-z]{2}""")

    private val MONEY_TAIL = Regex("""\s\d{1,3}(?:,\d{3})*\.\d{1,2}\s*$""")
    /** The VAT class printed after the line total. */
    private val VAT_CLASS_TAIL = Regex("""\s+[A-E]$""")

    /**
     * One item being assembled. A "(2pcs)" row opens it and the next one closes
     * it, so everything in between belongs to this item however ML Kit happened
     * to split the rows. That matters: the slip is photographed at an angle, and
     * which row a figure lands on is not something to depend on.
     */
    private class Block(val qty: Double?, val code: String?) {
        val nameParts = mutableListOf<String>()
        var unitPrice: Double? = null
        /** The unit price printed on this item's own stock-code row. */
        var headerUnit: Double? = null
        var lineTotal: Double? = null
        var discount = 0.0
        var awaitingDiscount = false
        /** A number on a row of its own, which may turn out to be a discount. */
        var lastBare: Double? = null
        /** Set when this item's code row carried the PREVIOUS item's price. */
        var columnSlipped = false
    }

    /** Convenience for tests and for pasted text: one row per line. */
    fun parseText(text: String): ReceiptScan = parse(text.lines())

    /**
     * Rebuilds visual rows from ML Kit's lines. A till slip puts the name on the
     * left and the money on the right, and ML Kit reports those as two separate
     * lines. Anything sharing a row is joined left to right so a name and its
     * price stay together.
     *
     * [slope] is the page's text tilt (rise over run). A receipt photographed at
     * even a few degrees puts the right-hand column a whole line-height out, so
     * without correcting for it the amounts attach to the wrong names.
     */
    @JvmOverloads
    fun rowsFrom(lines: List<OcrLine>, slope: Double = 0.0): List<String> {
        val usable = lines.filter { it.text.isNotBlank() }
        if (usable.isEmpty()) return emptyList()

        // Level the page: compare rows by where they would sit with no tilt.
        fun levelled(l: OcrLine) = (l.top + l.bottom) / 2.0 - slope * (l.left + l.right) / 2.0

        val rows = mutableListOf<MutableList<OcrLine>>()
        var anchor = 0.0
        var anchorHeight = 0
        for (line in usable.sortedBy { levelled(it) }) {
            val height = line.bottom - line.top
            // Measured against the row's FIRST line, never its latest: compare
            // against whatever was added last and a chain of near-misses walks
            // down the slip swallowing row after row.
            val fits = rows.isNotEmpty() &&
                abs(levelled(line) - anchor) <= min(height, anchorHeight) * 0.5
            if (fits) {
                rows.last().add(line)
            } else {
                rows.add(mutableListOf(line))
                anchor = levelled(line)
                anchorHeight = height
            }
        }
        return rows.map { row ->
            row.sortedBy { it.left }.joinToString("   ") { it.text.trim() }
        }
    }

    fun parse(rows: List<String>): ReceiptScan {
        val items = mutableListOf<ReceiptItem>()
        var total: Double? = null
        var subtotal: Double? = null
        var beforeDiscount: Double? = null
        var awarded: Double? = null
        var lineCount: Int? = null
        // Everything past the totals is footer: the VAT table, the payment, the
        // loyalty slip. None of it is shopping.
        var inFooter = false

        var block: Block? = null
        // A name on its own row, for tills that print the money underneath.
        var pendingName: String? = null

        val codes = mutableListOf<String?>()
        fun add(code: String?, item: ReceiptItem) {
            if (items.size < MAX_ITEMS) { items += item; codes += code }
        }
        fun close() {
            block?.let { open -> open.toItem()?.let { add(open.code, it) } }
            block = null
        }

        for (raw in rows) {
            val row = raw.replace(' ', ' ').trim()
            if (row.isEmpty()) continue

            // --- the slip's own totals, which end the item list ---------------
            if (DISCOUNT_AWARDED.containsMatchIn(row)) {
                close(); awarded = lastNumber(row); inFooter = true; pendingName = null; continue
            }
            if (TOTAL_BEFORE.containsMatchIn(row)) {
                close(); beforeDiscount = lastNumber(row); inFooter = true; pendingName = null; continue
            }
            if (SUBTOTAL_ROW.containsMatchIn(row)) {
                close(); subtotal = lastNumber(row); inFooter = true; pendingName = null; continue
            }
            if (TOTAL_LINES.containsMatchIn(row)) {
                close()
                lastNumber(row)?.let { lineCount = it.toInt() }
                inFooter = true; pendingName = null; continue
            }
            if (TOTAL_ROW.containsMatchIn(row)) {
                close()
                if (!NOT_THE_TOTAL.containsMatchIn(row)) {
                    total = lastNumber(row) ?: total
                    inFooter = true
                }
                pendingName = null; continue
            }

            // The VAT table below the total has a money column of its own, and
            // "CODE" on a row by itself looked exactly like an item name.
            if (inFooter) { pendingName = null; continue }

            // --- a new "(2pcs)" row closes the item above and opens the next --
            val pack = PACK_QTY.find(row)
            if (pack != null) {
                // Rows can be read joined up, so the code may sit part way
                // along one. Everything printed before it belongs to the item
                // above; the code and what follows start the next.
                val code = ANY_CODE.findAll(row).lastOrNull { it.range.last < pack.range.first }
                val split = code?.range?.first ?: pack.range.first
                val carry = row.substring(0, split)
                val tail = row.substring(split)
                var own = PACK_QTY.find(tail)?.let { tail.removeRange(it.range) } ?: tail

                var lent = false
                block?.let { previous ->
                    if (carry.isNotBlank()) absorb(previous, carry)
                    // An item with no figure at all is about to be thrown away.
                    // When this code row carries a price, the amounts column has
                    // slipped and that price is the lost item's, so lend it -
                    // without taking it away from the item starting here.
                    if (previous.lineTotal == null && previous.unitPrice == null) {
                        QTY_PRICE.find(own)
                            ?.takeIf { MONEY.matches(it.groupValues[2]) }
                            ?.let {
                                previous.unitPrice = toMoney(it.groupValues[2])
                                lent = true
                            }
                    }
                    // A discount figure can sit a row lower still, which puts it
                    // beside this code. Claim it before the item is closed.
                    if (previous.awaitingDiscount) {
                        strayDiscount(own)?.let {
                            previous.discount += toNumber(it.value)
                            // Taken out, so it is not also read as this item's.
                            own = own.removeRange(it.range)
                        }
                        previous.awaitingDiscount = false
                    }
                }
                close()
                pendingName = null
                block = Block(quantity(pack.groupValues[1]), stockCode(own))
                // Having just handed this row's price to the item above, the
                // bare amount that follows is that item's too.
                block!!.columnSlipped = lent
                absorb(block!!, own)
                // Quantity and price printed on one row corroborate each other.
                block!!.headerUnit = block!!.unitPrice
                continue
            }

            if (block != null) {
                if (NOISE.containsMatchIn(row) || DATEISH.containsMatchIn(row)) {
                    close(); pendingName = null
                } else {
                    absorb(block!!, row)
                }
                continue
            }

            // ------------------------------------------------------------------
            // No stock-code rows on this slip, so fall back to the plainer
            // layouts: "NAME  2 x 129.00  258.00", or a name with its money
            // on the row below.
            // ------------------------------------------------------------------
            if (DISCOUNT_ROW.containsMatchIn(row) || NOISE.containsMatchIn(row) ||
                DATEISH.containsMatchIn(row)
            ) {
                pendingName = null; continue
            }

            val qtyPrice = QTY_PRICE.find(row)
                ?.takeIf { notGlued(row, it.groups[2]!!.range) && MONEY.matches(it.groupValues[2]) }
            if (qtyPrice != null) {
                val rest = row.removeRange(qtyPrice.range)
                val own = cleanName(row.substring(0, qtyPrice.range.first))
                val name = if (letters(own) >= 2) own else pendingName ?: ""
                pendingName = null
                val plain = Block(quantity(qtyPrice.groupValues[1]), null)
                plain.unitPrice = toMoney(qtyPrice.groupValues[2])
                plain.lineTotal = MONEY.findAll(rest).lastOrNull { money(rest, it.range) }
                    ?.let { toMoney(it.value) }
                if (letters(name) >= 2) plain.nameParts += name
                plain.toItem()?.let { add(null, it) }
                if (items.size >= MAX_ITEMS) break
                continue
            }

            val moneyMatch = MONEY.findAll(row).lastOrNull { money(row, it.range) }
            if (moneyMatch != null) {
                val own = cleanName(row.substring(0, moneyMatch.range.first))
                val name = if (letters(own) >= 2) own else pendingName ?: ""
                pendingName = null
                if (letters(name) >= 2) {
                    val one = Block(1.0, null)
                    one.lineTotal = toMoney(moneyMatch.value)
                    one.nameParts += name
                    one.toItem()?.let { add(null, it) }
                }
                if (items.size >= MAX_ITEMS) break
                continue
            }

            val text = cleanName(row)
            pendingName = if (letters(text) >= 2) text else null
        }
        close()

        val netOfDiscount =
            if (beforeDiscount != null && awarded != null) beforeDiscount!! - awarded!! else null
        return ReceiptScan(
            dedupe(items, codes),
            total ?: subtotal ?: netOfDiscount ?: beforeDiscount,
            lineCount,
        )
    }

    /**
     * A long slip has to be photographed in sections, and the sections overlap,
     * so the same line is read twice. Where two copies of a line differ it is
     * because one was cut off before its DISCOUNT row, so the cheaper of the
     * two is the complete one.
     */
    private fun dedupe(items: List<ReceiptItem>, codes: List<String?>): List<ReceiptItem> {
        val seen = LinkedHashMap<String, ReceiptItem>()
        for ((index, item) in items.withIndex()) {
            // The stock code identifies a line far better than a name OCR may
            // have read two different ways either side of a seam.
            val identity = codes.getOrNull(index)?.let { digitsOf(it) }
                ?: item.name.lowercase().filter { it.isLetterOrDigit() }
            val key = identity + "|" + item.qty
            val existing = seen[key]
            if (existing == null || item.total < existing.total) seen[key] = item
        }
        return seen.values.toList()
    }

    /** "No15722" and "N015722" are the same code read two ways. */
    private fun digitsOf(code: String): String =
        code.filter { it.isDigit() }.trimStart('0').ifEmpty { code.lowercase() }

    private fun stockCode(row: String): String? =
        STOCK_CODE.find(row)?.groupValues?.get(1)

    /**
     * The one number on a stock-code row that is neither the code, the pack
     * quantity nor the unit price - which makes it the discount owed to the
     * item above.
     */
    private fun strayDiscount(row: String): MatchResult? {
        val blanked = StringBuilder(row)
        fun blank(range: IntRange) { for (i in range) blanked[i] = ' ' }
        ANY_CODE.find(row)?.let { blank(it.range) }
        QTY_PRICE.find(row)?.let { blank(it.range) }
        val masked = blanked.toString()
        val found = NUMBER.findAll(masked).lastOrNull { money(masked, it.range) } ?: return null
        val value = toNumber(found.value)
        return if (value > 0 && value < 10_000) found else null
    }

    /** Files one row into the item currently being assembled. */
    private fun absorb(block: Block, raw: String) {
        var rest = raw

        if (letters(rest) == 0) {
            val cash = MONEY.find(rest)
            if (cash != null) {
                if (block.columnSlipped) {
                    block.columnSlipped = false // belongs to the item above
                    return
                }
                block.lineTotal = toMoney(cash.value)
            } else {
                // At most four digits: a stock code is longer than any
                // discount, and reading one as money empties the item.
                val bare = NUMBER.findAll(rest)
                    .lastOrNull { it.value.length <= 4 && !it.value.contains(',') }
                    ?.let { toNumber(it.value) }
                if (bare != null && bare > 0) {
                    if (block.awaitingDiscount) {
                        block.discount += bare
                        block.awaitingDiscount = false
                    } else {
                        block.lastBare = bare
                    }
                }
            }
            return
        }

        if (DISCOUNT_ROW.containsMatchIn(rest)) {
            // Discounts print without cents. Anything WITH cents on this row is
            // the line total: the money column runs about a row lower than the
            // text it belongs to, so it lands here.
            // A quantity row can be read onto this one; it belongs to the
            // next item, so take it out before looking for anything here.
            QTY_PRICE.find(rest)?.let { rest = rest.removeRange(it.range) }
            MONEY.findAll(rest).lastOrNull { money(rest, it.range) }?.let {
                block.lineTotal = toMoney(it.value)
                rest = rest.removeRange(it.range)
            }
            val off = NUMBER.findAll(rest).lastOrNull { money(rest, it.range) }
            when {
                off != null -> block.discount += toNumber(off.value)
                // The figure is often printed on the row ABOVE the word.
                block.lastBare != null -> {
                    block.discount += block.lastBare!!
                    block.lastBare = null
                }
                else -> block.awaitingDiscount = true
            }
            return
        }
        // The discount figure sits in the money column, so it can land on its
        // own row just under the word.
        if (block.awaitingDiscount) {
            val only = rest.trim()
            if (letters(only) == 0) {
                lastNumber(only)?.let { block.discount += it }
                block.awaitingDiscount = false
                return
            }
            block.awaitingDiscount = false
        }

        // A real unit price carries cents. Without that, pack text like
        // "COUNT 4*22 SIZE 6" reads as a quantity times a price and is eaten
        // out of the item's name.
        QTY_PRICE.find(rest)
            ?.takeIf { notGlued(rest, it.groups[2]!!.range) && MONEY.matches(it.groupValues[2]) }
            ?.let {
                block.unitPrice = toMoney(it.groupValues[2])
                rest = rest.removeRange(it.range)
            }
        MONEY.findAll(rest).lastOrNull { money(rest, it.range) }?.let {
            block.lineTotal = toMoney(it.value)
            rest = rest.removeRange(it.range)
        }
        // A bare figure left out in the money column is a discount waiting for
        // its label, not part of the name.
        TRAILING_FIGURE.find(rest)?.let {
            block.lastBare = toNumber(it.groupValues[1])
            rest = rest.removeRange(it.range)
        }

        val text = cleanName(rest)
        // "x 83C" has two letters but no word in it.
        if (WORDISH.containsMatchIn(text) && !CODE_ONLY.matches(text)) block.nameParts += text
    }

    private fun Block.toItem(): ReceiptItem? {
        val name = nameParts.joinToString(" ").trim()
        if (letters(name) < 2) return null

        // A weighed item (0.605351 kg) has no sensible whole quantity, so it
        // goes in as one line at what it actually cost.
        val whole = qty != null && qty >= 1.0 && abs(qty - qty.roundToInt()) < 0.001
        val count = if (whole) qty!!.roundToInt() else 1
        val units = if (whole) count.toDouble() else qty ?: 1.0
        val fromHeader = headerUnit?.times(units)
        val printed = lineTotal
        val gross = when {
            // The slip prints the quantity and the unit price side by side on
            // the stock-code row, so those two agree with each other. When they
            // disagree with the line total, the total was read off a row
            // belonging to another item.
            fromHeader != null && printed != null ->
                if (abs(fromHeader - printed) <= max(1.0, fromHeader * 0.02)) printed
                else fromHeader
            // Otherwise the printed total is what was actually charged. A unit
            // price picked up from a later row is just as likely to be the next
            // item's, so it never overrides a total.
            printed != null -> printed
            else -> unitPrice?.times(units) ?: return null
        }
        // Line totals print before discount; the basket should show what it cost.
        val net = gross - discount
        if (net <= 0.0 || net >= 10_000_000.0) return null

        val price = round2(net / count)
        if (price <= 0.0) return null
        return ReceiptItem(name, count, price, round2(net))
    }

    /** True when nothing is glued to the END of the number: 400G is a size. */
    private fun notGlued(row: String, range: IntRange): Boolean {
        val after = row.getOrNull(range.last + 1)
        return after == null || !after.isLetter()
    }

    /** True when a number stands alone, rather than being part of a word. */
    private fun money(row: String, range: IntRange): Boolean {
        val before = row.getOrNull(range.first - 1)
        return notGlued(row, range) && (before == null || !before.isLetter())
    }

    private fun cleanName(part: String): String {
        var stripped = part.replace(LEADING_CODE, "")
            .replace(JUNK_CHARS, " ")
            .replace(PACK_QTY, " ")
            .replace(SPACES, " ")
            .trim()
        while (MONEY_TAIL.containsMatchIn(stripped)) {
            stripped = stripped.replace(MONEY_TAIL, "").trim()
        }
        stripped = stripped.replace(VAT_CLASS_TAIL, "")
            .trim()
            .trim('-', '.', ':', ',', '(', ')', '*')
            .trim()
        // Till slips are all caps, which shouts next to hand-typed items. OCR
        // drops the odd lowercase letter into them, so go by the majority.
        val upper = stripped.count { it.isUpperCase() }
        val lower = stripped.count { it.isLowerCase() }
        return if (upper >= 2 && upper >= lower * 3) titleCase(stripped) else stripped
    }

    private fun titleCase(s: String): String =
        s.split(' ').joinToString(" ") { word ->
            if (word.length <= 1) word
            else word.substring(0, 1).uppercase() + word.substring(1).lowercase()
        }

    private fun letters(s: String): Int = s.count { it.isLetter() }

    private fun toNumber(s: String): Double = s.replace(",", "").toDoubleOrNull() ?: 0.0

    /** Reads "1,730.00", "170,00" and "3,650.0o" as the same kind of thing. */
    private fun toMoney(s: String): Double {
        val cut = s.length - 3
        val shillings = s.substring(0, cut).replace(",", "")
        val cents = s.substring(cut + 1).replace('o', '0').replace('O', '0')
        return (shillings + "." + cents).toDoubleOrNull() ?: 0.0
    }

    /** Reads a quantity, allowing the letter OCR leaves where a zero should be. */
    private fun quantity(s: String): Double? {
        if (s.none { it.isDigit() }) return null
        return s.replace('o', '0').replace('O', '0').toDoubleOrNull()
    }

    private fun lastNumber(s: String): Double? =
        NUMBER.findAll(s).lastOrNull()?.let { toNumber(it.value) }

    private fun round2(v: Double): Double = (v * 100).roundToLong() / 100.0
}
