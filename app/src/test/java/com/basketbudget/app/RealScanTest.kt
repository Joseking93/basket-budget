package com.basketbudget.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The text ML Kit actually produced from a 57-line Naivas slip photographed in
 * sections, copied off the phone on 28 Oct 2026. Every OCR habit this parser
 * has to survive is in here: commas for decimal points, letters for zeros,
 * DISCOUWNT, rows joined together, rows out of order, and a stretch repeated
 * where two photographs overlapped.
 *
 * It is the only test that measures the thing that actually matters - how much
 * of a real shop comes back correct.
 */
class RealScanTest {

    private val scan: ReceiptScan by lazy {
        val text = javaClass.classLoader!!.getResourceAsStream("real-scan.txt")!!
            .bufferedReader().use { it.readText() }
        ReceiptParser.parseText(text)
    }

    @Test
    fun `reads the slip to within a shilling or so per line`() {
        assertEquals(57, scan.lineCount)
        assertEquals(24_998.00, scan.receiptTotal!!, 0.001)

        assertEquals("read ${scan.items.size} of 57 lines", 57, scan.items.size)

        val gap = abs(scan.receiptTotal!! - scan.items.sumOf { it.total })
        // The only shortfall left is a 3-shilling discount ML Kit never read.
        assertTrue("KSh %.2f adrift on a 24,998 slip".format(gap), gap <= 10.0)
    }

    @Test
    fun `the lines that used to come out wrong are right`() {
        fun priceOf(fragment: String) =
            scan.items.first { it.name.contains(fragment, true) }.total

        // A stray quantity row from a neighbour used to reprice these.
        assertEquals(1149.00, priceOf("Pampers"), 0.001)
        assertEquals(945.00, priceOf("Ashant"), 0.001)
        assertEquals(530.00, priceOf("Mung Dal"), 0.001)
        assertEquals(45.00, priceOf("Kensalt"), 0.001)
        assertEquals(750.00, priceOf("Dairybest"), 0.001)
        // "3,650.0o" with a letter for the last zero, less a 1,052 discount.
        assertEquals(2598.00, priceOf("Basmati"), 0.001)
        // Discounts printed on the row above their own label.
        assertEquals(1329.00, priceOf("Fresh Fri"), 0.001)
        assertEquals(597.00, priceOf("Menengai"), 0.001)
        assertEquals(615.00, priceOf("Blue Band"), 0.001)
        // Two photographs overlapped and read this one twice.
        assertEquals(1, scan.items.count { it.name.contains("Kevian", true) })
        // Its price sat on the next item's code row; without lending it back
        // this line had no figure at all and was dropped.
        assertEquals(170.00, priceOf("Stallion"), 0.001)
        // And the item after it must not inherit that same 170.
        assertEquals(129.00, priceOf("Kotex"), 0.001)
        assertEquals(1125.00, priceOf("Sybra"), 0.001)
    }

    @Test
    fun `no stock codes or debris end up in the names`() {
        for (item in scan.items) {
            assertTrue("code in name: ${item.name}", !Regex("""\bN[oO0]\d{4,}""").containsMatchIn(item.name))
            assertTrue("no word in name: ${item.name}", Regex("""[A-Za-z]{3}""").containsMatchIn(item.name))
            assertTrue("price out of range: ${item.name} ${item.price}", item.price in 1.0..10_000.0)
        }
    }
}
