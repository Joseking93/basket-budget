// Debts, plots and other payables — the wealth-tracker side of the app.
//
// Seeded from Jose_Wealth_Tracker_1.xlsx (Payables sheet), then kept current from
// the imported statements instead of by hand.
//
// THE IMPORTANT DISTINCTION: a payable is either FIXED or REVOLVING, and treating
// them the same is what makes the spreadsheet wrong.
//
//   fixed     — a set amount you pay down (logbook loan, plot balance, insurance).
//               Remaining = original − everything paid. Payments only go one way.
//
//   revolving — a credit line you draw AND repay, repeatedly (Zenka, M-Shwari, KCB
//               M-Pesa, Fuliza). Summing repayments and calling it progress is
//               nonsense: a revolving line shows its whole original repaid, which
//               reads as PAID OFF — while most of it was drawn again since. The
//               balance is opening + drawn − repaid, and it can go UP.
//
// `asOf` is the date `opening` was TRUE. Only movements after it count — otherwise
// history the figure already accounts for gets counted a second time.
//
// The two kinds need different asOf dates, and mixing them up is how the spreadsheet
// went wrong:
//   revolving — `opening` is a BALANCE stated on a date, so asOf is that date.
//   fixed     — `opening` is the ORIGINAL loan, so asOf predates every payment.

export const FIXED = 'fixed';
export const REVOLVING = 'revolving';

// Bump ONLY if a future default list must reach existing installs. Left as-is so
// nobody's stored payables are overwritten by an empty seed.
export const SEED_VERSION = 4;

// EMPTY BY DESIGN.
//
// This list held real balances: a logbook loan, two plot balances, an insurance
// debt, five credit lines. That is an entire financial position, and it was sitting
// in source that now has to be hosted somewhere for a phone to install it. Your
// debts are yours; the app ships knowing none of them.
//
// Yours already live in this browser's storage and stay there. On a new device,
// restore a backup (Data -> Restore) and they travel with it. Add new ones in the
// "What I owe" panel.
export const DEFAULT_PAYABLES = [];

const hay = (t) => `${t.counterparty || ''} ${t.raw || ''}`.toLowerCase();

/**
 * Work out where a payable actually stands.
 *
 * @returns {{owed, paid, drawn, matched, pct, movedSince, trackable}}
 *   owed   — what's left (revolving can exceed the opening figure)
 *   paid   — repayments seen since asOf, plus anything recorded by hand
 *   drawn  — new borrowing since asOf (revolving only)
 */
export function computePayable(p, transactions) {
  const after = p.asOf ? new Date(p.asOf).getTime() : 0;
  const byMatch = p.match
    ? transactions.filter((t) => hay(t).includes(p.match.toLowerCase()) && (!t.date || new Date(t.date).getTime() >= after))
    : [];

  // Transactions you pointed at this debt by hand. They count whatever their date —
  // an explicit link is you saying "this payment is for this", which beats any rule.
  // Union by id so a transaction that's both matched AND linked isn't counted twice.
  const linkedIds = new Set(p.linkedIds || []);
  const seen = new Set(byMatch.map((t) => t.id));
  const linked = transactions.filter((t) => linkedIds.has(t.id) && !seen.has(t.id));
  const matched = [...byMatch, ...linked];

  const repaid = matched.filter((t) => t.direction === 'Out').reduce((a, t) => a + t.amount, 0);
  // Money IN from the lender is NEW borrowing only on a revolving line. On a fixed
  // loan the lump that arrived IS the loan — it is the opening balance, not a second
  // loan on top of it. Counting it as "drawn" showed the whole principal again on the
  // card and pushed the panel's "new draws on revolving lines"
  // headline up by a fixed loan's original disbursement.
  const drawn =
    p.kind === REVOLVING
      ? matched.filter((t) => t.direction === 'In').reduce((a, t) => a + t.amount, 0)
      : 0;
  const manual = p.manualPaid || 0;
  const paid = repaid + manual;

  // Revolving: the line can be drawn again, so the balance moves both ways and is
  // floored at zero rather than assumed to only fall.
  const owed = p.kind === REVOLVING ? Math.max(0, p.opening + drawn - paid) : Math.max(0, p.opening - paid);

  const denom = p.kind === REVOLVING ? p.opening + drawn : p.opening;
  const pct = denom > 0 ? Math.min(1, paid / denom) : 0;

  return {
    owed,
    paid,
    drawn,
    repaid,
    manual,
    matched: matched.length,
    autoMatched: byMatch.length,
    linked,
    pct,
    trackable: Boolean(p.match),
    movedSince: matched.length > 0,
  };
}

export function totalOwed(payables, transactions) {
  return payables.reduce((a, p) => a + computePayable(p, transactions).owed, 0);
}
