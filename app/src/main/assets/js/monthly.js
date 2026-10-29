// Month-by-month reporting.
//
// The reason this matters: an "all time" view averages a month that ran three times
// heavier in with a quiet one and shows neither. Spending is lived monthly —
// so the month is the unit that answers "how am I doing".

import { classOf, CLASSES, categoryParts } from './rules.js';
import { monthResolver } from './salary.js';

// Which month a transaction belongs to. NOT its calendar month: the financial month
// runs from payday (js/salary.js owns that rule), so money spent on the 29th — after
// pay landed on the 28th — is next month's money. Reporting it under the old month
// would show an empty new month while you were already living and spending in it.
/** Every month present in the data, newest first. */
export function monthsIn(txns) {
  const monthOf = monthResolver(txns);
  return [...new Set(txns.map((t) => (t.date ? monthOf(t) : null)).filter(Boolean))].sort().reverse();
}

export function monthLabel(k) {
  if (!k) return '';
  const [y, m] = k.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function previousMonth(k) {
  const [y, m] = k.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function nextMonth(k) {
  const [y, m] = k.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Spending, income and fees for one month, plus the per-category breakdown. */
export function summariseMonth(txns, k) {
  const monthOf = monthResolver(txns);
  const rows = txns.filter((t) => t.date && monthOf(t) === k);
  let spending = 0;
  let fees = 0;
  let income = 0;
  let transfers = 0;
  const cats = new Map();

  // Iterate category-parts so a split transaction lands in each of its categories;
  // `count` above still reflects whole transactions (rows.length), because a split is
  // one movement, not several.
  for (const t of rows.flatMap(categoryParts)) {
    const cls = classOf(t.category);
    if (cls === CLASSES.FEE) fees += t.amount;
    else if (cls === CLASSES.TRANSFER) transfers += t.amount;
    else if (cls === CLASSES.INCOME || t.direction === 'In') income += t.amount;
    else spending += t.amount;

    // The category table shows money OUT — an inbound refund isn't negative spending
    // on the day, and netting it silently would hide both.
    if (t.direction === 'In') continue;
    if (cls === CLASSES.TRANSFER || cls === CLASSES.INCOME) continue;
    const c = cats.get(t.category) || { category: t.category, total: 0, count: 0 };
    c.total += t.amount;
    c.count++;
    cats.set(t.category, c);
  }

  return {
    month: k,
    spent: spending + fees,
    income,
    fees,
    transfers,
    net: income - (spending + fees),
    count: rows.length,
    categories: [...cats.values()].sort((a, b) => b.total - a.total),
  };
}

/**
 * One month against the one before, per category.
 *
 * @returns {{now, prev, movers}} movers are sorted by absolute change — the point of
 *   a comparison is what MOVED, and a category that stayed flat is not news.
 */
export function compareMonths(txns, k) {
  const now = summariseMonth(txns, k);
  const prevKey = previousMonth(k);
  const prev = summariseMonth(txns, prevKey);

  const names = new Set([...now.categories.map((c) => c.category), ...prev.categories.map((c) => c.category)]);
  const movers = [...names]
    .map((name) => {
      const a = now.categories.find((c) => c.category === name);
      const b = prev.categories.find((c) => c.category === name);
      const nowTotal = a ? a.total : 0;
      const prevTotal = b ? b.total : 0;
      return {
        category: name,
        now: nowTotal,
        prev: prevTotal,
        delta: nowTotal - prevTotal,
        // No percentage against a zero base: "+∞%" is noise. `isNew` says it better.
        pct: prevTotal > 0 ? (nowTotal - prevTotal) / prevTotal : null,
        isNew: prevTotal === 0 && nowTotal > 0,
        isGone: nowTotal === 0 && prevTotal > 0,
        count: a ? a.count : 0,
      };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return { now, prev, prevKey, movers };
}

/** The single transaction most responsible for a category's jump, if there is one. */
export function biggestDriver(txns, k, category) {
  const monthOf = monthResolver(txns);
  const rows = txns.filter((t) => t.date && monthOf(t) === k && t.category === category && t.direction === 'Out');
  if (!rows.length) return null;
  const top = rows.reduce((a, b) => (b.amount > a.amount ? b : a));
  const total = rows.reduce((a, t) => a + t.amount, 0);
  // Only worth naming if it actually dominates; otherwise it's just the largest of many.
  return total > 0 && top.amount / total >= 0.5 ? { txn: top, share: top.amount / total } : null;
}
