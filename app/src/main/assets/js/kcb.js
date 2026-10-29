// KCB "Mini Statement" parser.
//
// The simplest layout of the lot, and the only one with an EXPLICIT sign: amounts
// read "KES 1,000.00" for money in and "-KES 76.25" for money out, so no balance
// arithmetic is needed to work out direction.
//
// It also has no balance column and no declared totals, so there is nothing to
// reconcile against — unlike the other statements, this one can only be checked by
// eye. Worth knowing when trusting it.
//
// Its real value: "Vooma Loan Disbursement" / "Vooma Loan Recovery" rows are the KCB
// loan, which no other statement records.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const ROW_RE =
  /(\d{2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+([\s\S]*?)(-)?KES\s+([\d,]+\.\d{2})/g;

export function looksLikeKcb(text) {
  return /Mini Statement/i.test(text) && /KES\s+[\d,]/.test(text);
}

const num = (s) => parseFloat(String(s).replace(/,/g, ''));

function describe(details) {
  const d = details.replace(/\s+/g, ' ').trim();

  if (/Vooma Loan Disbursement/i.test(d)) return { type: 'Loan Disbursement', counterparty: 'KCB Vooma Loan' };
  if (/Vooma Loan (Recovery|Repayment)/i.test(d)) return { type: 'Loan Repayment', counterparty: 'KCB Vooma Loan' };
  if (/Transfer Charge|Charges?$/i.test(d)) return { type: 'Bank Charge', counterparty: 'Bank Charge' };
  if (/Mobile Money Transfer|Trf to M-?pesa/i.test(d)) return { type: 'Internal Transfer', counterparty: 'Transfer to my M-PESA' };
  if (/Mobi MPESA/i.test(d)) return { type: 'Internal Transfer', counterparty: 'M-PESA into this account' };
  return { type: 'Other', counterparty: d.slice(0, 60) };
}

export function parseKcbText(text) {
  const transactions = [];
  const counts = new Map();
  let m;
  ROW_RE.lastIndex = 0;

  while ((m = ROW_RE.exec(text)) !== null) {
    const [, dd, mon, yyyy, rawDetails, minus, amtStr] = m;
    const details = rawDetails.replace(/\s+/g, ' ').trim();
    const amount = num(amtStr);
    if (!amount) continue;

    const d = describe(details);
    // Kenya is UTC+3; the statement gives no time, so anchor at local midday to keep
    // the date stable whichever way it's later rendered.
    const date = new Date(Date.UTC(+yyyy, MONTHS[mon], +dd, 9)).toISOString();

    // M-PESA receipts appear inline ("Mobi MPESA UFU8N9QJR8") and are the only stable
    // id available — they also let these rows pair with the M-PESA statement.
    const receipt = (details.match(/\b([A-Z0-9]{10})\b/) || [])[1] || null;

    let id = receipt ? `KCB-${receipt}` : `KCB-${dd}${mon}${yyyy}-${amount.toFixed(2)}-${d.type}`;
    const n = counts.get(id) || 0;
    counts.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;

    transactions.push({
      id,
      receipt,
      date,
      amount,
      direction: minus ? 'Out' : 'In',
      type: d.type,
      counterparty: d.counterparty,
      account: null,
      balance: null, // this statement doesn't print one
      source: 'statement',
      raw: details,
    });
  }

  return { transactions, unresolved: 0, reconciled: null }; // null: nothing to reconcile against
}

export const _internals = { describe, ROW_RE };
