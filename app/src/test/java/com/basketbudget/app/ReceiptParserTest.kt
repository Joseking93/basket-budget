package com.basketbudget.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptParserTest {

    /**
     * Transcribed from a real Naivas slip (28 Oct 2026). Each item is a block:
     * a stock-code row carrying "(Npcs)" and the unit price, then the name with
     * the line total and a VAT class, then any run-on of the name, then an
     * optional DISCOUNT.
     */
    private val naivas = """
        QTY        PRICE       AMOUNT
        12500522   (2pcs)       2 x 105.00
        CUSSONS MILD & GENTLE BABY   210.00   A
        SOAP 100G
        DISCOUNT                      50
        15509358   (1pcs)       1 x 595.00
        DR MARCUS LUCKY TOP BLUE     595.00   A
        DISCOUNT                     120
        15000113   (3pcs)       3 x 45.00
        ARIMIS MILKING SALVE 50G     135.00   A
        N056754    (1pcs)       1 x 150.00
        OMO BLEACH MULTI-PURPOSE     150.00   A
        LAVENDER 250ML
        12500399   (1pcs)       1 x 550.00
        PROTEX HERBAL SOAP 3*90G VALUE   550.00   A
        PACK
    """.trimIndent()

    @Test
    fun `reads the real Naivas block layout`() {
        val scan = ReceiptParser.parseText(naivas)

        assertEquals(
            listOf(
                "Cussons Mild & Gentle Baby Soap 100g",
                "Dr Marcus Lucky Top Blue",
                "Arimis Milking Salve 50g",
                "Omo Bleach Multi-purpose Lavender 250ml",
                "Protex Herbal Soap 3*90g Value Pack",
            ),
            scan.items.map { it.name },
        )

        // The stock code and "(2pcs)" must never become the item's name.
        assertTrue(scan.items.none { it.name.contains("pcs", true) })
        assertTrue(scan.items.none { it.name.any { c -> c.isDigit() } && it.name.length < 10 })
    }

    @Test
    fun `quantity comes off the stock-code row, not the name`() {
        val items = ReceiptParser.parseText(naivas).items

        assertEquals(2, items[0].qty)
        assertEquals(1, items[1].qty)
        assertEquals(3, items[2].qty)
    }

    @Test
    fun `a discount comes off the item above it`() {
        val items = ReceiptParser.parseText(naivas).items

        // 2 x 105.00 = 210.00, less 50 = 160.00, so 80.00 each.
        assertEquals(160.00, items[0].total, 0.001)
        assertEquals(80.00, items[0].price, 0.001)
        // 595.00 less 120 = 475.00 for the one unit.
        assertEquals(475.00, items[1].total, 0.001)
        // No discount on this one: 3 x 45.00 stands.
        assertEquals(135.00, items[2].total, 0.001)
        assertEquals(45.00, items[2].price, 0.001)
    }

    @Test
    fun `a name that runs on to the next row is joined up`() {
        val items = ReceiptParser.parseText(naivas).items

        assertEquals("Cussons Mild & Gentle Baby Soap 100g", items[0].name)
        assertEquals("Omo Bleach Multi-purpose Lavender 250ml", items[3].name)
        // "3*90G" must not be read as a quantity times a price.
        assertEquals("Protex Herbal Soap 3*90g Value Pack", items[4].name)
        assertEquals(550.00, items[4].total, 0.001)
    }

    /**
     * A longer run off the same slip, including the shapes that used to break:
     * pack text like "4*22" and "3*90G" that looks like a quantity times a
     * price, a weighed line, and the totals block at the end. The sum of the
     * items must equal what the slip says was owed.
     */
    private val longSlip = """
        12500522   (2pcs)         2 x 105.00
        CUSSONS MILD & GENTLE BABY   210.00   A
        SOAP 100G
        DISCOUNT                      50
        12500399   (1pcs)         1 x 550.00
        PROTEX HERBAL SOAP 3*90G VALUE  550.00  A
        PACK
        28503470   (1pcs)         1 x 1,149.00
        PAMPERS PANTS DIAPERS HIGH  1,149.00  A
        COUNT 4*22 SIZE 6
        20500311   (1pcs)         1 x 240.00
        FAY ALUMINIUM FOIL 45CM*5MTR 240.00   A
        N015722    (1pcs)         1 x 299.00
        PEPSODENT HERBAL TOOTHPASTE  299.00   A
        2*150G VALUE PACK
        2036085000000   (0.605351kg)   0.605351 x 299.00
        ORANGE IMPORTED P/KG    181.00   C
        TOTAL LINES:        6
        TOTAL BEFORE DISCOUNT    2,629.00
        DISCOUNT AWARDED            50.00
    """.trimIndent()

    @Test
    fun `pack text in a name is not read as a quantity times a price`() {
        val items = ReceiptParser.parseText(longSlip).items

        assertEquals("Protex Herbal Soap 3*90g Value Pack", items[1].name)
        assertEquals(550.00, items[1].price, 0.001)
        assertEquals("Pampers Pants Diapers High Count 4*22 Size 6", items[2].name)
        assertEquals(1149.00, items[2].price, 0.001)
        assertEquals("Fay Aluminium Foil 45cm*5mtr", items[3].name)
        assertEquals(240.00, items[3].price, 0.001)
        assertEquals("Pepsodent Herbal Toothpaste 2*150g Value Pack", items[4].name)
        assertEquals(299.00, items[4].price, 0.001)
    }

    @Test
    fun `the items add up to what the slip says was owed`() {
        val scan = ReceiptParser.parseText(longSlip)

        assertEquals(6, scan.items.size)
        assertEquals(2_579.00, scan.receiptTotal!!, 0.001)
        assertEquals(scan.receiptTotal!!, scan.items.sumOf { it.total }, 0.02)
    }

    @Test
    fun `a weighed item goes in as one line at what it cost`() {
        val scan = ReceiptParser.parseText(
            """
            2036085000000   (0.605351kg)    0.605351 x 299.00
            ORANGE IMPORTED P/KG     181.00   C
            2040800000000   (0.225301pcs)   0.225301 x 830.00
            DRIED DATES P/KG         187.00   C
            """.trimIndent()
        )

        assertEquals(2, scan.items.size)
        assertEquals("Orange Imported P/kg", scan.items[0].name)
        assertEquals(1, scan.items[0].qty)
        assertEquals(181.00, scan.items[0].price, 0.001)
        assertEquals(187.00, scan.items[1].price, 0.001)
    }

    @Test
    fun `the slip's own totals are read, and TOTAL LINES is not one of them`() {
        val scan = ReceiptParser.parseText(
            """
            N039339    (1pcs)       1 x 101.00
            BROADWAYS BROWN BREAD 600G   101.00   B
            TOTAL LINES:          57
            TOTAL BEFORE DISCOUNT      27,525.00
            DISCOUNT AWARDED            2,527.00
            """.trimIndent()
        )

        assertEquals(1, scan.items.size)
        // 57 is a count of lines, and 27,525 is before the discount, so the
        // figure to check a basket against is what was actually owed.
        assertEquals(24_998.00, scan.receiptTotal!!, 0.001)
        // The count is kept, so a short read shows up instead of being guessed.
        assertEquals(57, scan.lineCount)
    }

    @Test
    fun `a plain TOTAL wins over the computed one`() {
        val scan = ReceiptParser.parseText(
            """
            13500243   (1pcs)      1 x 54.00
            JOY SUPER BITE MANDAZI 180G   54.00   B
            TOTAL BEFORE DISCOUNT     60.00
            DISCOUNT AWARDED           6.00
            TOTAL                     54.00
            """.trimIndent()
        )

        assertEquals(54.00, scan.receiptTotal!!, 0.001)
    }

    // ---- other tills, which print one row per item ------------------------

    @Test
    fun `still reads a plain one-row layout`() {
        val scan = ReceiptParser.parseText(
            """
            JOGOO MAIZE FLOUR 2KG    2 x 129.00    258.00
            FRESH MILK 500ML                        60.00
            CASHEW NUTS 500G                       450.00
            TOTAL                                  768.00
            """.trimIndent()
        )

        assertEquals(
            listOf("Jogoo Maize Flour 2kg", "Fresh Milk 500ml", "Cashew Nuts 500g"),
            scan.items.map { it.name },
        )
        assertEquals(2, scan.items[0].qty)
        assertEquals(258.00, scan.items[0].total, 0.001)
        assertEquals(60.00, scan.items[1].price, 0.001)
        // CASHEW survives the CASH rule.
        assertEquals(450.00, scan.items[2].price, 0.001)
        assertEquals(768.00, scan.receiptTotal!!, 0.001)
    }

    @Test
    fun `a pack size is not a price`() {
        val scan = ReceiptParser.parseText(
            """
            BREAD WHITE 400G
              1 x 65.00      65.00
            """.trimIndent()
        )

        assertEquals(1, scan.items.size)
        assertEquals("Bread White 400g", scan.items[0].name)
        assertEquals(65.00, scan.items[0].price, 0.001)
    }

    @Test
    fun `nothing is invented from a photo with no receipt in it`() {
        assertTrue(ReceiptParser.parseText("").items.isEmpty())
        assertTrue(ReceiptParser.parseText("### ---- ***").items.isEmpty())
        val noise = ReceiptParser.parseText("WELCOME TO NAIVAS\nTILL 4\nSERVED BY: MARY")
        assertTrue(noise.items.isEmpty())
        assertNull(noise.receiptTotal)
    }

    // ---- faults seen on the first real scan, 28 Oct -----------------------

    @Test
    fun `a stock code OCR read as letters stays out of the name`() {
        // The slip prints N015722; ML Kit reads the zero as an "o".
        val scan = ReceiptParser.parseText(
            """
            No15722    (1pcs)       1 x 299.00
            PEPSODENT HERBAL TOOTHPASTE   299.00   A
            2*150G VALUE PACK
            No46051    (1pcs)       1 x 200.00
            SAFISHA TOILET CLEANER PINE 500ML   200.00   B
            """.trimIndent()
        )

        assertEquals(
            listOf("Pepsodent Herbal Toothpaste 2*150g Value Pack", "Safisha Toilet Cleaner Pine 500ml"),
            scan.items.map { it.name },
        )
        assertTrue(scan.items.none { it.name.contains("No1") || it.name.contains("No4") })
    }

    @Test
    fun `a line read twice from overlapping photos is kept once`() {
        // Photographing a long slip in sections repeats lines at the seams. The
        // copy cut off before its DISCOUNT row reads 230 each; the whole one
        // reads 199 each, and that is the one to keep.
        val scan = ReceiptParser.parseText(
            """
            12500106   (3pcs)       3 x 230.00
            MENENGAI CREAM BAR SOAP 1KG   690.00   A
            12500106   (3pcs)       3 x 230.00
            MENENGAI CREAM BAR SOAP 1KG   690.00   A
            DISCOUNT                      93
            """.trimIndent()
        )

        assertEquals(1, scan.items.size)
        assertEquals(3, scan.items[0].qty)
        assertEquals(199.00, scan.items[0].price, 0.001)
        assertEquals(597.00, scan.items[0].total, 0.001)
    }

    @Test
    fun `an amount belonging to another item loses to the quantity row`() {
        // At a page seam the Pampers amount landed on the Pepsodent name.
        val scan = ReceiptParser.parseText(
            """
            N015722    (1pcs)       1 x 299.00
            PEPSODENT HERBAL TOOTHPASTE   1,149.00   A
            """.trimIndent()
        )

        assertEquals(1, scan.items.size)
        assertEquals(299.00, scan.items[0].price, 0.001)
    }

    @Test
    fun `one letter misread in an all-caps name does not leave it shouting`() {
        // "SUNLlGHT" - a lowercase L where the I should be.
        val scan = ReceiptParser.parseText(
            """
            13001721   (1pcs)       1 x 230.00
            SUNLlGHT TROPICAL HANDWASH   230.00   A
            POWDER 500G JAR
            """.trimIndent()
        )

        assertEquals("Sunllght Tropical Handwash Powder 500g Jar", scan.items[0].name)
    }

    @Test
    fun `the money column running a row low still lands on the right item`() {
        // From the second scan: the amounts sit about a row below the text they
        // belong to, so the line total falls on the DISCOUNT row and the
        // discount itself falls beside the next item's stock code.
        val scan = ReceiptParser.parseText(
            """
            12500522   (2pcs)
            CUSSONS MILD & GENTLE BABY      2 x 105.00
            SOAP 100G                         210.00    A
            DISCOUNT
            15509358   (1pcs)                     50
            DR MARCUS LUCKY TOP BLUE        1 x 595.00
            DISCOUNT                          595.00    A
            15000113   (3pcs)                    120
            ARIMIS MILKING SALVE 50G        3 x 45.00
            """.trimIndent()
        )

        assertEquals(3, scan.items.size)
        // 210 less the 50 that landed on the next item's row.
        assertEquals(160.00, scan.items[0].total, 0.001)
        assertEquals(80.00, scan.items[0].price, 0.001)
        // 595.00 on a DISCOUNT row is a line total, not 595 off the item.
        assertEquals(475.00, scan.items[1].total, 0.001)
        assertEquals(135.00, scan.items[2].total, 0.001)
    }

    @Test
    fun `the same stock code read two ways is still one item`() {
        val scan = ReceiptParser.parseText(
            """
            N015722    (1pcs)       1 x 299.00
            PEPSODENT HERBAL TOOTHPASTE   299.00   A
            2*150G VALUE PACK
            No15722    (1pcs)       1 x 299.00
            PEPSODENT HERBAL TOOTHPASTE   299.00   A
            24
            """.trimIndent()
        )

        // Different OCR of the name, same code, so one line.
        assertEquals(1, scan.items.size)
        assertEquals(299.00, scan.items[0].price, 0.001)
    }

    @Test
    fun `a code part way along a joined row still starts a new item`() {
        // Seen on 28 Oct: a name row read joined to the next item's code row.
        // Gracie's lost its name and its 240, and Colgate's 600 took over.
        val scan = ReceiptParser.parseText(
            """
            N034760    (2pcs)       2 x 120.00
            GRACIE'S PASSION YOGHURT 500ML  240.00  B  29003272  (1pcs)  1 x 600.00
            COLGATE 360 BASE TOOTHBRUSH    600.00   B
            VALUE PACK
            """.trimIndent()
        )

        assertEquals(2, scan.items.size)
        assertEquals("Gracie's Passion Yoghurt 500ml", scan.items[0].name)
        assertEquals(2, scan.items[0].qty)
        assertEquals(120.00, scan.items[0].price, 0.001)
        assertEquals(240.00, scan.items[0].total, 0.001)
        assertEquals("Colgate 360 Base Toothbrush Value Pack", scan.items[1].name)
        assertEquals(1, scan.items[1].qty)
        assertEquals(600.00, scan.items[1].price, 0.001)
    }

    @Test
    fun `near-miss lines do not chain into one long row`() {
        // Each line clears the one before by less than the tolerance. Measured
        // against the latest member, the whole slip collapses into one row.
        val lines = (0..3).map { i ->
            OcrLine("line$i", left = 60, top = 100 + i * 18, right = 400, bottom = 140 + i * 18)
        }

        assertEquals(2, ReceiptParser.rowsFrom(lines).size)
    }

    @Test
    fun `nothing below the totals is shopping`() {
        // The VAT table, the payment and the loyalty slip all carry money.
        // "CODE" alone on a row used to become an item worth the VAT.
        val scan = ReceiptParser.parseText(
            """
            N039339    (1pcs)       1 x 101.00
            BROADWAYS BROWN BREAD 600G    101.00   B
            TOTAL LINES:        2
            TOTAL BEFORE DISCOUNT     27,525.00
            DISCOUNT AWARDED           2,527.00
            SUBTOTAL                  22,403.66
            VAT                        2,594.34
            TOTAL                     24,998.00
            CODE
            RATE   VATABLE AMT   VAT AMT
            A      16.00%   1,593.10   2,594.34
            B      00%      2,095.00   0
            M-Pesa                    24998.00
            POINTS EARNED      : 249
            """.trimIndent()
        )

        assertEquals(listOf("Broadways Brown Bread 600g"), scan.items.map { it.name })
        assertEquals(24_998.00, scan.receiptTotal!!, 0.001)
        assertEquals(2, scan.lineCount)
    }

    @Test
    fun `a price still counts when OCR drops the spaces around the x`() {
        // Read off the phone as "1X120.00". A letter sits right against the
        // number, which used to disqualify it as money - so the price was lost
        // and the whole "1x120.00" stayed in the item's name.
        val scan = ReceiptParser.parseText(
            """
            N045177    (1pcs)      1X945.00
            ASHANTI-Q MOIST LOC COND 500ML   945.00   C
            18004060   (10pcs)     10X75.00
            BROOKSIDE DAIRYBEST MILK 500ML   750.00   B
            """.trimIndent()
        )

        assertEquals(2, scan.items.size)
        assertEquals("Ashanti-q Moist Loc Cond 500ml", scan.items[0].name)
        assertEquals(945.00, scan.items[0].price, 0.001)
        assertEquals("Brookside Dairybest Milk 500ml", scan.items[1].name)
        assertEquals(10, scan.items[1].qty)
        assertEquals(75.00, scan.items[1].price, 0.001)
    }

    @Test
    fun `a mangled line total loses to the quantity row`() {
        // "3,650.00" came back as "65.00" off a shadowed part of the slip.
        // 2 x 1,825.00 is printed on one row, so it corroborates itself.
        val scan = ReceiptParser.parseText(
            """
            19500705   (2pcs)      2X1,825.00
            SUNRICE BASMATI RICE 5KG    65.00   C
            DISCOUNT                  1052
            """.trimIndent()
        )

        assertEquals(1, scan.items.size)
        assertEquals(2, scan.items[0].qty)
        // 3,650 less the 1,052 discount, halved.
        assertEquals(1299.00, scan.items[0].price, 0.001)
        assertEquals(2598.00, scan.items[0].total, 0.001)
    }

    @Test
    fun `a zero OCR read as a letter still opens the next item`() {
        // "(0.225301pcs)" came back as "(o.225301pcs)". The marker was not
        // recognised, so Dried Dates never started and its text was swallowed
        // by the item above it.
        val scan = ReceiptParser.parseText(
            """
            16507287   (1pcs)              1 x 85.00
            KEVIAN AFIA GUAVA PET 500ML     85.00    C
            DISCOUNT                          5
            2040800000000   (o.225301pcs)   o.225301 x 830.00
            DRIED DATES P/KG                187.00   C
            """.trimIndent()
        )

        assertEquals(
            listOf("Kevian Afia Guava Pet 500ml", "Dried Dates P/kg"),
            scan.items.map { it.name },
        )
        assertEquals(80.00, scan.items[0].price, 0.001)
        assertEquals(1, scan.items[1].qty)
        assertEquals(187.00, scan.items[1].price, 0.001)
    }

    // ---- row rebuilding ---------------------------------------------------

    @Test
    fun `boxes on the same row are joined left to right`() {
        val lines = listOf(
            OcrLine("210.00   A", left = 1000, top = 102, right = 1300, bottom = 140),
            OcrLine("CUSSONS MILD & GENTLE BABY", left = 60, top = 100, right = 800, bottom = 140),
            OcrLine("SOAP 100G", left = 60, top = 160, right = 300, bottom = 198),
        )

        val rows = ReceiptParser.rowsFrom(lines)
        assertEquals(2, rows.size)
        assertTrue(rows[0].startsWith("CUSSONS"))
        assertTrue(rows[0].endsWith("210.00   A"))
    }

    @Test
    fun `a tilted slip still pairs names with their amounts`() {
        // Photographed at an angle: over the 1,000px to the money column the
        // right-hand text sits a full line-height lower than its own name.
        val slope = 0.05
        fun at(text: String, left: Int, baseline: Int) =
            OcrLine(
                text, left, baseline + (slope * left).toInt(),
                left + 300, baseline + 40 + (slope * left).toInt(),
            )

        val lines = listOf(
            at("CUSSONS MILD & GENTLE BABY", 60, 100),
            at("210.00", 1100, 100),
            at("DR MARCUS LUCKY TOP BLUE", 60, 160),
            at("595.00", 1100, 160),
        )

        // Without the correction the rows shear apart; with it they pair up.
        val rows = ReceiptParser.rowsFrom(lines, slope)
        assertEquals(2, rows.size)
        assertTrue(rows[0].contains("CUSSONS") && rows[0].contains("210.00"))
        assertTrue(rows[1].contains("MARCUS") && rows[1].contains("595.00"))
    }
}
