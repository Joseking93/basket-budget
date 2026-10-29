# Basket Budget

A grocery budget tracker for Kenyan supermarket shopping, built as a native Android
app around a single offline HTML page.

## What it does

- **Keep a basket** against a monthly budget that runs from the 28th to the 27th,
  so the cycle matches a pay date rather than the calendar.
- **Scan a Naivas till slip** with the camera, a photo, or a PDF from a phone
  scanner. Text recognition runs on the device.
- **Review before anything is added** — every line is shown with its quantity and
  price, with the slip's own total and line count beside the sum of what is ticked,
  so a misread is visible rather than silent.
- **Keep every receipt**, searchable across months, with spend per cycle, the items
  that cost the most, and a printable PDF of any single shop.

## Reading a till slip

A Naivas receipt prints each item as a block of rows, not one row:

```
12500522   (2pcs)              2 x 105.00
CUSSONS MILD & GENTLE BABY       210.00   A
SOAP 100G
DISCOUNT                              50
```

The parser is built around that: a `(Npcs)` row opens an item and the next one
closes it, so everything between belongs to that item however the recogniser
happened to split the rows. It survives the things real scans actually do — the
money column drifting a row against the text, commas for decimal points, letters
where zeros should be, rows read joined together, and overlapping photographs of a
long slip repeating lines.

`app/src/test/resources/real-scan.txt` is the text a real 57-line slip produced,
kept as a fixture. `RealScanTest` measures the only thing that matters: how much of
a real shop comes back correct. It currently reads **57 of 57 lines, 3 shillings out
of 24,998** — and that 3 is a discount the recogniser never produced at all.

## Offline

Text recognition uses the bundled model, the webfont ships with the app, and the
page is served from the APK's own assets over `appassets.androidplatform.net` so
its stored data survives updates. The only thing that touches the network is the
check for a newer release.

## Building

Needs a JDK 17 and an Android SDK with platform 36.

```
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`.
