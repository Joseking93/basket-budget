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
}
