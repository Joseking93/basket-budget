package com.basketbudget.app

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Quickmart prints a slip the other way up from Naivas.
 *
 * Naivas leads with the stock code, the quantity and the unit price, and puts
 * the name underneath. Quickmart leads with the NAME, and puts the code, the
 * quantity, the unit and both money columns on the row below:
 *
 *     PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ   G
 *     230297        1.000 PC    1299.00    1299.00
 *
 * Read by the Naivas rules that is not an item at all. The numbers row looks
 * like a name, "1299.00" loses its leading digit to the column before it, and
 * the real name is thrown away - which is exactly what came back: two items
 * called "1.000 Pc" priced 299 and 190.
 *
 * Transcribed from a real slip (30 Oct 2026).
 */
class QuickmartTest {

    private val quickmart = """
        QUICK MART PLC
        EMBAKASI
        CASH SALE
        VAT Reg: 0126753Q  Pin No. P051188806D
        Date: 08:34am Fri 30 October 2026
        Branch: 38 Till: 8 Session: 4129 Rct: 48
        JOSE
        Item          Qty       Each       Total
        PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ    G
        230297        1.000 PC    1299.00    1299.00
        PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ    G
        230297        1.000 PC    1299.00    1299.00
        FR-JAR SPINACH PER BUNCH                   E
        0023.11.00    2.000 BU      39.00      78.00
        HC-UNI VIM LEMON FRESH 1KG                 G
        280225        1.000 PC     190.00     190.00
        TOTAL      :     2,866.00
        CASH PAID  :         0.00
        MPESA PAY  :     2,866.00
        Total Qty  :     5.00 units
        Cashier    : SARAH S MUTIE
    """.trimIndent()

    @Test
    fun `reads the Quickmart name-above-numbers layout`() {
        val scan = ReceiptParser.parseText(quickmart)

        assertEquals(
            listOf(
                "PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ" to 1299.0,
                "PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ" to 1299.0,
                "FR-JAR SPINACH PER BUNCH" to 78.0,
                "HC-UNI VIM LEMON FRESH 1KG" to 190.0,
            ),
            scan.items.map { it.name to it.total },
        )
    }

    @Test
    fun `keeps the quantity off the numbers row`() {
        val scan = ReceiptParser.parseText(quickmart)
        assertEquals(listOf(1, 1, 2, 1), scan.items.map { it.qty })
    }

    @Test
    fun `the unit price is not truncated`() {
        val scan = ReceiptParser.parseText(quickmart)
        assertEquals(listOf(1299.0, 1299.0, 39.0, 190.0), scan.items.map { it.price })
    }

    @Test
    fun `reads the slip total, not a fragment of it`() {
        val scan = ReceiptParser.parseText(quickmart)
        assertEquals(2866.0, scan.receiptTotal!!, 0.01)
    }

    @Test
    fun `the items add up to the slip`() {
        val scan = ReceiptParser.parseText(quickmart)
        assertEquals(2866.0, scan.items.sumOf { it.total }, 0.01)
    }

    /**
     * The same shop, as the CAMERA reported it: name and figures on one row.
     *
     * Which of those two shapes comes back is not up to the slip. ML Kit joins
     * what sits close together, so the angle and the light decide it, row by
     * row - which is why the same receipt gave four items one time, two the
     * next, and a different two the time after.
     */
    private val joined = """
        Item          Qty       Each       Total
        PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ G 230297 1.000 PC 1299.00 1299.00
        PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ G 230297 1.000 PC 1299.00 1299.00
        FR-JAR SPINACH PER BUNCH E 0023.11.00 2.000 BU 39.00 78.00
        HC-UNI VIM LEMON FRESH 1KG G 280225 1.000 PC 190.00 190.00
        TOTAL      :     2,866.00
    """.trimIndent()

    @Test
    fun `reads a row where the name and the figures arrived joined`() {
        val scan = ReceiptParser.parseText(joined)

        assertEquals(
            listOf(
                "PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ" to 1299.0,
                "PC-HKL-PAMPERS PANTS JR U/SEX JP3*48-SZ" to 1299.0,
                "FR-JAR SPINACH PER BUNCH" to 78.0,
                "HC-UNI VIM LEMON FRESH 1KG" to 190.0,
            ),
            scan.items.map { it.name to it.total },
        )
        assertEquals(2866.0, scan.items.sumOf { it.total }, 0.01)
    }

    /**
     * A printed Q is a circle with a tick in it, so OCR calls it an O about as
     * often as it calls it a Q. "Total Oty : 5.00 units" was being read as the
     * bill, which made a 2,866 shop think it had spent 5 - and the app then
     * told him his two real nappy packs were a double-read and to untick one.
     */
    @Test
    fun `a mangled Total Qty row is not the bill`() {
        val scan = ReceiptParser.parseText(
            quickmart.replace("Total Qty", "Total Oty")
        )
        assertEquals(2866.0, scan.receiptTotal!!, 0.01)
    }

    /** A bill is never smaller than one of the things on it. */
    @Test
    fun `a total below the biggest line is discarded rather than believed`() {
        val scan = ReceiptParser.parseText(
            quickmart.replace("TOTAL      :     2,866.00", "TOTAL      :     5.00")
        )
        assertEquals(null, scan.receiptTotal)
        assertEquals(4, scan.items.size)
    }

    /**
     * The camera lost the name row entirely. The money still left his pocket,
     * so the line is kept under its stock code: a wrongly named line can be
     * fixed in the sheet, a line that never appears cannot.
     */
    @Test
    fun `a figures row with no name anywhere is kept under its code`() {
        val scan = ReceiptParser.parseText(
            """
            230297        1.000 PC    1299.00    1299.00
            280225        1.000 PC     190.00     190.00
            TOTAL      :     1,489.00
            """.trimIndent()
        )
        assertEquals(listOf("230297", "280225"), scan.items.map { it.name })
        assertEquals(1489.0, scan.items.sumOf { it.total }, 0.01)
    }
}
