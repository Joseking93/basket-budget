# Budget Tracker

Where the month's money went, and what the shopping actually bought — an Android app
around two offline pages that share one origin, so they share one budget.

- **Tracker** (`index.html`) — M-PESA and bank statements, categorised; budgets, debts,
  refunds, recurring payments, and the month at a glance.
- **Basket** (`basket.html`) — a shopping list against the Groceries line, and a camera
  that reads a till slip.

**Your data never leaves the device.** No account, no server, no analytics. Statements
are read in the page, text recognition runs on the phone, and the only thing that
touches the network is the check for a newer release.

## The code knows nothing about you

Every personal thing lives in the browser's storage, never in the source: your phone and
account numbers, the people you know, your debts, your budget amounts, even the name in
the greeting. The code ships empty and you fill it in through **Settings**, or by
restoring a backup.

That isn't decoration. This repo is public and the app has to be hosted for a browser to
install it — a phone number, an account number, a family member's name or a list of your
loans would all go with it.

**Settings → who you are** is the one thing you must fill in. Without your own numbers
the app can't tell a top-up to *your own* wallet from a payment to someone else, and
money moving between your accounts gets counted twice.

## The month

A financial month runs from payday, not the 1st. The app works the boundary out from the
salary landing in your own statements, falling back to the 28th when there is no pay on
file yet, and the home screen says which days it is counting — a figure for "this month"
whose edges you can't see is one you can't check.

Every figure on that card comes from the same call the Budget panel uses. Two panels
showing different totals for one month reads as a bug even when both are right.

## Basket, inside it

Basket does not carry a budget of its own. It reads the **Groceries line** from the
tracker, and the "spent" it counts is every grocery payment on your statements — not
only the slips that were scanned, which would only ever be a floor on the real figure.
Add things to the trolley and it says what the shop would leave for the rest of the
month.

Receipts travel by themselves. Both pages are served from one origin, so the tracker
reads what Basket saved and matches each shop to the payment that settled it: same
amount to the shilling, a day either side, biggest shop claiming first. Each receipt is
taken once, so one deleted in the tracker does not come back.

## Reading a till slip

A supermarket receipt prints each item as a block of rows, not one row:

```
12500522   (2pcs)              2 x 105.00
CUSSONS MILD & GENTLE BABY       210.00   A
SOAP 100G
DISCOUNT                              50
```

The parser is built around that: a `(Npcs)` row opens an item and the next one closes
it, so everything between belongs to that item however the recogniser happened to split
the rows. It survives what real scans actually do — the money column drifting a row
against the text, commas for decimal points, letters where zeros should be, rows read
joined together, and overlapping photographs of a long slip repeating lines.

`app/src/test/resources/real-scan.txt` is the text a real 57-line slip produced, kept as
a fixture. `RealScanTest` measures the only thing that matters: how much of a real shop
comes back correct. It currently reads **57 of 57 lines, 3 shillings out** — and that 3
is a discount the recogniser never produced at all.

Nothing is added without being shown first. Every line appears with its quantity and
price, with the slip's own total and line count beside the sum of what is ticked, so a
misread is visible rather than silent.

## M-PESA's own messages

The app reads them straight from the phone's inbox (`READ_SMS`), keeping only the
messages that open with a receipt code and `Confirmed` — adverts and balance replies
come from the same sender. They go to the page, which parses and categorises them by the
same rules a statement goes through, with anything unknown landing in **Needs
categorising** rather than being guessed at. Once the permission is given it reads
whatever is new each time you open the app, and says nothing when there is nothing.

A web page cannot do this on any platform; it is the one thing the APK is for. The text
never leaves the phone.

## The widget

A home-screen button that goes straight to photographing a receipt, because the till is
where a receipt is worth recording. It opens Basket and the camera in one tap.

## How spending is counted

The headline **Spent** counts goods, services and M-PESA fees.

It deliberately excludes **moved / repaid** — loan repayments, transfers to your own
accounts, money into savings. That money is real, but it isn't consumption, and a single
loan repayment can dwarf a month of food, making every other category invisible. Those
totals are shown separately.

Other rules worth knowing:

- **Categories are derived on read**, never baked into a stored transaction, so editing
  a rule recategorises history instead of only new imports.
- **Name rules match longest-first**, not in the order you made them, so a surname rule
  can cover a family while one person inside it keeps their own category.
- **People are matched by name, not number** — the masked number differs between an SMS
  and a statement, so the name is the only stable key. The bank's bare numbers are
  resolved against M-PESA's masked ones so one rule covers both accounts.
- **A send of 200 or less to a person** is treated as groceries. Guessing at *all*
  person-sends swallowed over half of spending into one category; the size cap keeps the
  convenience without the lie. Everything above it waits for you.
- **Fuliza is not a category.** It's an overdraft: a Fuliza purchase is categorised by
  merchant, because the credit line is how it was funded, not what it was spent on.
- **A refund can be pointed at the payment it repays**, reducing that category instead
  of counting as income — 3,000 paid and 2,500 returned cost 500, and that is the only
  figure that's true.

## Statements

M-PESA, Standard Chartered, KCB and NCBA PDFs; the format is detected from the file.
Each has its own password, and it stays in the page.

The check that makes a parser trustworthy is reconciliation: summed inflows and outflows
must equal the statement's own printed totals to the cent. They do, on a real 31-page
statement of 1,108 rows, delta 0.00 — and the bank parser reproduces every running
balance, which is how it knows the direction of a row the bank prints unsigned. **Re-run
that check after any parser change.**

Loading a bank statement and an M-PESA statement together would otherwise count the same
movement twice, since most of the bank's traffic is money moving to and from M-PESA. A
bank row naming your own phone or account becomes an internal transfer; one naming
someone else's is real spending. The **Account check** panel pairs the two sides
explicitly so you can see it happened.

## Syncing, and backups

Everything lives in the browser's `localStorage` — this device only. Clearing browser
data wipes it, so take a backup now and then. Devices sync by passing one between them.

- **Additive** — transactions, rules, categories, refund links, known numbers. Keyed, so
  importing the same file twice changes nothing.
- **Single-valued** — a budget amount, a debt balance. The incoming file wins, so
  restoring the *older* device into the newer one can overwrite a figure you just fixed.
  Hand-recorded payments take the larger of the two instead, since losing a payment you
  recorded is worse.

## Running the pages in a browser

Double-click **`start.bat`**, which serves `app/src/main/assets` on
<http://localhost:8777>. Keep the port: the data is keyed to that origin.

It is served rather than opened as a file because browsers block ES modules and PDF
workers on `file://`. `serve.py` sends `no-store`, because a cached module means a fixed
bug that still looks broken.

## Building

Needs a JDK 17 and an Android SDK with platform 36.

```
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`. Pushing a tag that matches
`versionName` builds a signed release on GitHub and publishes it, which is where the
app's own update check looks.

## Layout

| Path | What it is |
|---|---|
| `app/src/main/assets/index.html` | The tracker |
| `app/src/main/assets/basket.html` | Basket |
| `app/src/main/assets/js/parser.js` | M-PESA SMS → transactions |
| `app/src/main/assets/js/statement.js` | Statement PDF → transactions |
| `app/src/main/assets/js/rules.js` | Categories and the rules behind them |
| `app/src/main/assets/js/store.js` | localStorage, dedupe by receipt code |
| `app/src/main/assets/js/decal.js` | The engraving both pages share |
| `app/src/main/java/.../ReceiptParser.kt` | Till slip → items |
| `app/src/main/java/.../SmsReader.kt` | The inbox |
| `app/src/main/java/.../ScanWidget.kt` | The home-screen button |
