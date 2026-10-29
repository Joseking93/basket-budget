// Finding the payments that repeat.
//
// The useful question isn't "what did I spend" but "what am I committed to before I
// decide anything" — rent, fibre, subscriptions. Those are also where forgotten
// spending hides: nobody notices the thing they stopped using.

import { personName } from './rules.js';

const DAY = 86400000;

// Cadences worth naming, and how much wobble still counts. A monthly bill on the
// 1st can land on the 3rd; that's still monthly.
const CADENCES = [
  { name: 'weekly', days: 7, tol: 2 },
  { name: 'fortnightly', days: 14, tol: 3 },
  { name: 'monthly', days: 30.4, tol: 6 },
  { name: 'quarterly', days: 91, tol: 12 },
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @returns {object[]} groups that look scheduled, most committed first
 *
 * A group qualifies on THREE tests, all needed:
 *   - at least 3 occurrences (two points make a line, not a pattern)
 *   - gaps clustering around a known cadence
 *   - amounts that don't wander (a variable bill is still recurring, but 5x swings
 *     mean it's just a shop you use often — Naivas isn't a subscription)
 */
export function findRecurring(txns, { minOccurrences = 3 } = {}) {
  const groups = new Map();
  for (const t of txns) {
    if (t.direction !== 'Out' || !t.date) continue;
    const name = personName(t.counterparty) || t.counterparty;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(t);
  }

  const out = [];
  for (const [name, rows] of groups) {
    if (rows.length < minOccurrences) continue;
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));

    const gaps = [];
    for (let i = 1; i < rows.length; i++) gaps.push((new Date(rows[i].date) - new Date(rows[i - 1].date)) / DAY);
    const gap = median(gaps);
    if (!gap || gap < 4) continue; // several times a week isn't a subscription

    const cadence = CADENCES.find((c) => Math.abs(gap - c.days) <= c.tol);
    if (!cadence) continue;

    // How regular, really: the share of gaps close to the cadence.
    const onBeat = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tol).length / gaps.length;
    if (onBeat < 0.6) continue;

    const amounts = rows.map((t) => t.amount);
    const typical = median(amounts);
    const spread = typical > 0 ? median(amounts.map((a) => Math.abs(a - typical))) / typical : 1;
    if (spread > 0.35) continue; // amount wanders too much to be a commitment

    const last = new Date(rows.at(-1).date);
    const sinceLast = (Date.now() - last) / DAY;

    out.push({
      name,
      category: rows.at(-1).category,
      count: rows.length,
      typical,
      total: amounts.reduce((a, b) => a + b, 0),
      cadence: cadence.name,
      perMonth: typical * (30.4 / cadence.days),
      confidence: onBeat,
      first: rows[0].date,
      last: rows.at(-1).date,
      // Overdue by more than a full cycle: either it stopped, or a payment failed.
      stale: sinceLast > cadence.days * 1.8,
      nextDue: new Date(last.getTime() + cadence.days * DAY).toISOString(),
      txns: rows,
    });
  }

  return out.sort((a, b) => b.perMonth - a.perMonth);
}

/** What you're committed to each month before choosing anything. */
export function committedMonthly(recurring) {
  return recurring.filter((r) => !r.stale).reduce((a, r) => a + r.perMonth, 0);
}
