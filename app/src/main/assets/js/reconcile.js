// Pairing bank <-> M-PESA internal movements.
//
// The netting works by classifying each side independently: a bank row naming your
// own number is internal, and the M-PESA side is a bank transfer. Both are excluded,
// so the totals come out right. But "the totals come out right" is not the same as
// "these two rows are the same movement" — and if a top-up has no counterpart, you
// want to know whether that's because the statements don't overlap or because
// something is genuinely missing.
//
// This pairs them explicitly and reports what didn't match.
//
// Only the OVERLAPPING date range is judged. The bank statement covers Jun 2025 -
// May 2026 while an M-PESA statement might cover Jan - Jul 2026; a top-up in Aug
// 2025 has no counterpart because the M-PESA data doesn't reach back that far. That
// is not a discrepancy, and calling it one would be noise.

const DAY = 86400000;
const TOLERANCE_DAYS = 2; // value date vs entry date can legitimately differ

// Any institution that isn't the wallet. All of them shuttle money to and from
// M-PESA, so all of them can double-count against it.
const isMpesa = (t) => (t.accountSource || 'mpesa') === 'mpesa';
const isBank = (t) => !isMpesa(t);

// Bank side: money leaving the bank into your M-PESA, or arriving from it.
const bankInternal = (t) => isBank(t) && t.type === 'Internal Transfer';

const BANKS =
  /Equity|NCBA|KCB|Stanbic|Co-?\s?operative|Standard Chartered|SBM|I&M|IM BANK|DTB|Absa|Family Bank|\bBank\b|via API/i;

// M-PESA side: the same movement, seen from the wallet.
//
// Matched on the BANK'S NAME, not the transaction type. Safaricom labels money
// arriving from a bank's B2C rail as "Salary Payment" whether or not it's a salary —
// a transfer from your own NCBA account arrives typed exactly like wages. Filtering
// by type therefore misses your own money and books it as income.
const mpesaBankward = (t) => isMpesa(t) && BANKS.test(t.counterparty || '');

// Banks stamp a reference on both legs ("FTC260626XXXX" appears in the NCBA row and
// in the M-PESA row it produced). When present it's proof, not inference — worth far
// more than "same amount, close in time", which can pair two unrelated payments.
const REF_RE = /\b(F[TC][A-Z0-9]{8,})\b|\b(KE-[A-Z0-9-]{6,})\b/g;
function refsOf(t) {
  const out = new Set();
  let m;
  const s = `${t.raw || ''} ${t.counterparty || ''}`;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(s)) !== null) out.add((m[1] || m[2]).toUpperCase());
  return out;
}
const shareRef = (a, b) => {
  const ra = refsOf(a);
  if (!ra.size) return false;
  for (const r of refsOf(b)) if (ra.has(r)) return true;
  return false;
};

function overlapWindow(txns) {
  const span = (pred) => {
    const ds = txns.filter(pred).map((t) => +new Date(t.date)).filter(Number.isFinite);
    return ds.length ? { min: Math.min(...ds), max: Math.max(...ds) } : null;
  };
  const b = span(isBank);
  const m = span(isMpesa);
  if (!b || !m) return null;
  const from = Math.max(b.min, m.min);
  const to = Math.min(b.max, m.max);
  return from <= to ? { from, to, bank: b, mpesa: m } : { from: null, to: null, bank: b, mpesa: m };
}

/**
 * @returns {{window, matched, unmatchedBank, unmatchedMpesa, outsideWindow, checked}}
 */
export function reconcileAccounts(txns) {
  const win = overlapWindow(txns);
  if (!win || win.from === null) {
    return { window: win, matched: [], unmatchedBank: [], unmatchedMpesa: [], outsideWindow: 0, checked: false };
  }

  const inWin = (t) => {
    const d = +new Date(t.date);
    return d >= win.from - DAY && d <= win.to + DAY;
  };

  const bank = txns.filter(bankInternal);
  const bankIn = bank.filter(inWin);
  const outsideWindow = bank.length - bankIn.length;

  const candidates = txns.filter((t) => mpesaBankward(t) && inWin(t));

  // Build every feasible pair first, then assign closest-first across the whole set.
  //
  // Matching one bank row at a time and letting it take its nearest candidate is
  // order-dependent: with two 3,000 top-ups on consecutive days, whichever row is
  // processed first can take the other's counterpart and leave it orphaned — so the
  // answer changes with input order, which makes the check worthless. Assigning
  // globally by smallest gap is deterministic regardless of the order rows arrive in.
  const pairs = [];
  for (const b of bankIn) {
    const bt = +new Date(b.date);
    for (const m of candidates) {
      if (m.direction === b.direction) continue; // must be opposite sides of one movement
      const proof = shareRef(b, m);
      // A shared reference is proof, so it doesn't need the amount to agree (fees can
      // differ between the legs) and gets a generous window. Everything else must
      // match on amount and land close in time.
      if (!proof) {
        if (Math.abs(m.amount - b.amount) >= 0.01) continue;
        const gap = Math.abs(+new Date(m.date) - bt);
        if (gap > TOLERANCE_DAYS * DAY) continue;
        pairs.push({ b, m, gap, proof: false });
      } else {
        const gap = Math.abs(+new Date(m.date) - bt);
        if (gap > TOLERANCE_DAYS * 2 * DAY) continue;
        pairs.push({ b, m, gap, proof: true });
      }
    }
  }
  // Reference-proved pairs win outright; then closest in time. Tie-break on id so
  // equal gaps resolve the same way every run.
  pairs.sort((x, y) => (y.proof ? 1 : 0) - (x.proof ? 1 : 0) || x.gap - y.gap || (x.b.id < y.b.id ? -1 : 1));

  const usedBank = new Set();
  const used = new Set();
  const matched = [];

  for (const p of pairs) {
    if (usedBank.has(p.b.id) || used.has(p.m.id)) continue;
    usedBank.add(p.b.id);
    used.add(p.m.id);
    matched.push({ bank: p.b, mpesa: p.m, gapHours: Math.round(p.gap / 3600000), proof: p.proof });
  }

  matched.sort((a, c) => (a.bank.date < c.bank.date ? 1 : -1));
  const unmatchedBank = bankIn.filter((b) => !usedBank.has(b.id));
  const unmatchedMpesa = candidates.filter((m) => !used.has(m.id));

  return { window: win, matched, unmatchedBank, unmatchedMpesa, outsideWindow, checked: true };
}
