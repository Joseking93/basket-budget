import { CYCLE_DAY } from './config.js';

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

/**
 * Which budget month a date belongs to.
 *
 * The cycle starts on CYCLE_DAY, so a date on or after it belongs to the cycle
 * opening that month, and a date before it to the one that opened the month
 * before. The name comes from monthAPayFunds, the same function that names a
 * real pay run, so a cycle and the pay that funds it always agree.
 */
export function cycleMonthOf(dateISO, day = CYCLE_DAY) {
  const d = String(dateISO || '');
  if (d.length < 10) return '';
  const ym = d.slice(0, 7);
  const startYM = +d.slice(8, 10) >= day ? ym : addMonths(ym, -1);
  return monthAPayFunds(`${startYM}-${String(day).padStart(2, '0')}`);
}

/** The day a budget month opens, e.g. "2026-11" -> "2026-10-28". */
export function cycleStartOf(month, day = CYCLE_DAY) {
  const pad = String(day).padStart(2, '0');
  // monthAPayFunds rolls a late-month payday on to the month it funds, so the
  // cycle named November is the one that opened on 28 October. Derived from the
  // same function rather than assumed, so the two cannot drift apart.
  const own = `${month}-${pad}`;
  return monthAPayFunds(own) === month ? own : `${addMonths(month, -1)}-${pad}`;
}

/**
 * Which month a transaction belongs to.
 *
 * A month you assigned by hand wins; otherwise it is the cycle its date falls
 * in. It used to walk the DETECTED pay runs instead, which meant pay arriving
 * on a rail the detector did not recognise left a gap, and the fallback for a
 * gap was the calendar month - a different name for the same stretch of days,
 * so two definitions of one month existed at once.
 */
export function monthResolver() {
  return (t) => t.budgetMonth || cycleMonthOf(t.date);
}

function addMonths(ym, n) {
  if (!n) return ym;
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

