// Salary — paid through TerraPay, and it arrives in CHUNKS.
//
// M-PESA caps how much can land in one transfer, so a month's pay arrives as a
// capped slice plus a remainder - usually minutes apart, sometimes days (one month
// the head came on the 30th and the tail on the 4th).
//
// Treating each chunk as a separate payment makes income look erratic and hides what a
// month was actually paid, so they are grouped into one RUN. A run is what you'd call
// "getting paid"; the chunks are just M-PESA's plumbing.

// TerraPay's own signature is the conversation ID it stamps on every transfer —
// "Original conversation ID is TPWT000212154881". Match THAT, not the paybill name:
// from September 2026 the pay stopped arriving through the TerraPay paybill and
// started landing via "EQUITY BANK IMT B2C ACCOUNT" instead, and a name-only match
// filed a whole month's salary as a bank transfer — no income, no payday, no cycle.
export const SALARY_RE = /TERRAPAY|TPWT\d{6,}/i;

/** Money in from the salary rail. */
export const isSalary = (t) =>
  t && t.direction === 'In' && SALARY_RE.test(`${t.counterparty || ''} ${t.raw || ''}`);

// Observed spreads run from 9 minutes to 5 days. Beyond that it's the next pay, not a
// late chunk of the last one.
const RUN_GAP_DAYS = 5;

/**
 * Group salary chunks into pay runs, newest first.
 * @returns {Array<{first, last, total, count, ids}>}
 */
export function salaryRuns(txns) {
  const rows = txns.filter(isSalary).filter((t) => t.date).sort((a, b) => (a.date < b.date ? -1 : 1));

  const runs = [];
  for (const t of rows) {
    const cur = runs[runs.length - 1];
    const gapDays = cur ? (new Date(t.date) - new Date(cur.last)) / 86400000 : Infinity;
    if (cur && gapDays <= RUN_GAP_DAYS) {
      cur.total += t.amount;
      cur.count++;
      cur.last = t.date;
      cur.ids.push(t.id);
    } else {
      runs.push({ first: t.date, last: t.date, total: t.amount, count: 1, ids: [t.id] });
    }
  }
  return runs.reverse();
}

// ── The financial month ───────────────────────────────────────────────────────
//
// His month starts on payday, not the 1st: he's paid at the end of one month for the
// next, so money spent on the 29th is next month's money. Every report that talks
// about "a month" resolves it through here, so the budget, the monthly report and the
// per-line trend can't tell three different stories about the same transaction.

// Pay landing at the tail of a month funds the month after — true of every payday in
// the data (26th–30th). Earlier pay is a top-up within the month it arrived in.
const PAY_FUNDS_NEXT_FROM_DAY = 25;

function monthAPayFunds(date) {
  const ym = String(date).slice(0, 7);
  if (+String(date).slice(8, 10) < PAY_FUNDS_NEXT_FROM_DAY) return ym;
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Pay cycles, oldest first: each starts at a payday and runs until the next. */
export function payCycles(txns) {
  return salaryRuns(txns)
    .map((run) => {
      // If you've said which month a pay funds, that's the answer.
      const assigned = txns.find((t) => run.ids.includes(t.id) && t.budgetMonth);
      return { month: assigned ? assigned.budgetMonth : monthAPayFunds(run.first), start: run.first };
    })
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

// Resolving a month means scanning the pay runs, and the reports ask per month and per
// transaction — so the cycles are computed once per transaction list. Keyed on the
// array itself, which is rebuilt on every render, so a stale answer can't survive an
// edit.
const cycleCache = new WeakMap();

/**
 * A function that answers "which month does this belong to" for one transaction list.
 * Order: a month you assigned it to → the pay cycle its date falls in → its calendar
 * month. Before the first payday, or with no salary at all, it's just the calendar.
 */
export function monthResolver(txns) {
  let cycles = cycleCache.get(txns);
  if (!cycles) {
    cycles = payCycles(txns);
    cycleCache.set(txns, cycles);
  }
  const last = cycles.length - 1;
  return (t) => {
    if (t.budgetMonth) return t.budgetMonth;
    const d = t.date || '';
    for (let i = last; i >= 0; i--) {
      if (d < cycles[i].start) continue;
      // Earlier cycles are closed by the payday that followed them, so they're exact.
      if (i !== last) return cycles[i].month;
      // The newest cycle has no payday after it to close it — so left alone it would
      // claim every future transaction forever, and the month you're actually living
      // in would sit empty while the old one kept growing. That's what happened when
      // September showed nothing and August held six weeks of spending.
      //
      // So once the calendar passes the point the next pay was due, roll the month on
      // anyway. A real payday landing later just replaces this guess.
      return addMonths(cycles[i].month, wholeMonthsSince(cycles[i].start, d));
    }
    return d.slice(0, 7);
  };
}

function addMonths(ym, n) {
  if (!n) return ym;
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Whole pay-periods between a payday and a date — 0 until the same day next month. */
function wholeMonthsSince(startISO, dateISO) {
  const s = new Date(startISO);
  const d = new Date(dateISO);
  if (isNaN(s) || isNaN(d)) return 0;
  let n = (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + (d.getUTCMonth() - s.getUTCMonth());
  if (d.getUTCDate() < s.getUTCDate()) n -= 1;
  return Math.max(0, n);
}
