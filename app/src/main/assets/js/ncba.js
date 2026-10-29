// NCBA e-Statement parser.
//
// Layout: Date | Details | Value Date | Debit | Credit | Balance — but like the
// Hifadhi statement, an empty Debit/Credit cell is omitted rather than printed, so
// only TWO numbers ever appear: the amount and the balance. Direction comes from the
// balance delta, seeded by the printed Opening Balance.
//
// This one does declare its totals (Payments In / Payments Out), so the parse can be
// checked rather than trusted.

// Anchored to a line start (`^` + m flag). Without it the header's "From : 01/06/2026"
// is a valid opening for the first row, and every field after it shifts — the first
// transaction silently takes the statement's start date instead of its own.
//
// The trailing group captures the CONTINUATION line, which is where NCBA puts the
// bank reference ("<phone> FTC260626XXXX"). That reference also appears in the
// M-PESA row this transfer produced, so it's what proves the two are one movement —
// stopping at the balance throws away the only hard link between the statements.
const ROW_RE =
  /^\s*(\d{2}\/\d{2}\/\d{4})\s+([\s\S]*?)\s+(\d{2}\/\d{2}\/\d{4})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})([\s\S]*?)(?=^\s*\d{2}\/\d{2}\/\d{4}\s|$(?![\s\S]))/gm;

// Page furniture — NCBA repeats a legal notice on every page.
const NOISE = [
  /IMPORTANT NOTICE:[\s\S]*?ncbagroup\.com/gi,
  /Page\s+\d+/gi,
  /Date\s+Transaction Type and Details\s+Value\s*Date\s+Debit\s+Credit\s+Balance/gi,
];

export function looksLikeNcba(text) {
  return /ncbagroup\.com/i.test(text) || /e-Statement of Account/i.test(text);
}

const num = (s) => parseFloat(String(s).replace(/,/g, ''));

function toISO(dmy) {
  const [d, m, y] = dmy.split('/').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 9)).toISOString();
}

function describe(details) {
  const d = details.replace(/\s+/g, ' ').trim();

  // The narration outranks the rail. NCBA books an incoming refund as "IB Internal
  // Transfer" because that's the mechanism, and only the word "Refund" underneath
  // says what it really is — classifying by the rail would hide real money arriving.
  if (/\bRefund\b/i.test(d)) return { type: 'Refund', counterparty: 'Refund received' };

  if (/AA Loan (Repayment|Payoff)/i.test(d)) return { type: 'Loan Repayment', counterparty: 'NCBA Loop Loan' };
  if (/AA Loan Disburse|Loan Disburse/i.test(d)) return { type: 'Loan Disbursement', counterparty: 'NCBA Loop Loan' };
  if (/Charges?\b/i.test(d)) return { type: 'Bank Charge', counterparty: 'Bank Charge' };
  if (/MPESA Paybill Transfer|Mpesa Deposit/i.test(d)) return { type: 'Internal Transfer', counterparty: 'M-PESA into this account' };
  if (/Trf to M-?pesa|Transfer to M-?pesa/i.test(d)) return { type: 'Internal Transfer', counterparty: 'Transfer to my M-PESA' };
  if (/IB Internal Transfer/i.test(d)) return { type: 'Internal Transfer', counterparty: 'Transfer between my accounts' };
  if (/Salary/i.test(d)) return { type: 'Salary Payment', counterparty: 'Salary' };
  return { type: 'Other', counterparty: d.slice(0, 60) };
}

export function parseNcbaText(text) {
  let clean = text.replace(/[^\S\n]+/g, ' ');
  for (const n of NOISE) clean = clean.replace(n, '');

  const open = clean.match(/Opening Balance\s+([\d,]+\.\d{2})/i);
  let prev = open ? num(open[1]) : null;

  const declaredIn = clean.match(/Payments In\s+([\d,]+\.\d{2})/i);
  const declaredOut = clean.match(/Payments Out\s+([\d,]+\.\d{2})/i);

  const transactions = [];
  const counts = new Map();
  let unresolved = 0;
  let m;
  ROW_RE.lastIndex = 0;

  while ((m = ROW_RE.exec(clean)) !== null) {
    const [, dmy, rawDetails, , amtStr, balStr, continuation] = m;
    // Keep the continuation with the row: it holds the reference that links this
    // transfer to its other half in the M-PESA statement.
    const details = `${rawDetails} ${continuation || ''}`.replace(/\s+/g, ' ').trim();
    const amount = num(amtStr);
    const balance = num(balStr);
    if (!amount) {
      prev = balance;
      continue;
    }

    let direction;
    if (prev !== null && Math.abs(prev - amount - balance) < 0.01) direction = 'Out';
    else if (prev !== null && Math.abs(prev + amount - balance) < 0.01) direction = 'In';
    else {
      direction = null;
      unresolved++;
    }
    prev = balance;

    const d = describe(details);
    const receipt = (details.match(/MPESA REF:\s*([A-Z0-9]{10})/i) || [])[1] || null;

    let id = receipt ? `NCBA-${receipt}` : `NCBA-${dmy.replace(/\//g, '')}-${amount.toFixed(2)}-${balance.toFixed(2)}`;
    const n = counts.get(id) || 0;
    counts.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;

    transactions.push({
      id,
      receipt,
      date: toISO(dmy),
      amount,
      direction: direction || 'Out',
      directionResolved: direction !== null,
      type: d.type,
      counterparty: d.counterparty,
      account: null,
      balance,
      source: 'statement',
      raw: details,
    });
  }

  // Check the parse against the statement's own figures rather than assuming.
  const paidIn = transactions.filter((t) => t.direction === 'In').reduce((a, t) => a + t.amount, 0);
  const paidOut = transactions.filter((t) => t.direction === 'Out').reduce((a, t) => a + t.amount, 0);
  const inOk = declaredIn ? Math.abs(paidIn - num(declaredIn[1])) < 0.01 : null;
  const outOk = declaredOut ? Math.abs(paidOut - num(declaredOut[1])) < 0.01 : null;

  return {
    transactions,
    unresolved,
    reconciled: unresolved === 0 && inOk !== false && outOk !== false,
    declared: declaredIn && declaredOut ? { in: num(declaredIn[1]), out: num(declaredOut[1]) } : null,
    computed: { in: paidIn, out: paidOut },
  };
}

export const _internals = { describe, ROW_RE };
