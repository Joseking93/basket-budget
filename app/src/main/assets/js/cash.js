// Cash in pocket.
//
// A withdrawal is ALREADY counted as spending the moment it happens — right,
// because the money has left the wallet — but it lands as one blind lump under
// "Cash Withdrawal" and nothing on the screen says what it bought. So itemising
// it must not ADD spending: counting the 430 of kale and tomatoes on top of the
// 5,000 it came out of would count the same money twice.
//
// An itemisation is therefore not a transaction. It is a claim on a withdrawal,
// and the withdrawal is SPLIT by it — 5,000 out becomes 430 of Groceries and
// 4,570 nobody has accounted for yet. Totals never move when you itemise; only
// the breakdown does, which is the whole point. It also means the figure on the
// home screen cannot drift downward just because a week went by without typing.
//
// Claims are matched to withdrawals oldest first. Whatever no claim has reached
// is what should still be in your pocket, so one piece of arithmetic answers
// both "what did the cash go on" and "how much should I be holding" — and the
// second is checkable against your actual wallet, which is what keeps the first
// honest.

import { CATEGORIES } from './rules.js';

/** Money leaving an account as physical cash. Both statements and SMS say 'Withdrawal'. */
const isWithdrawal = (t) => t.type === 'Withdrawal' && t.direction === 'Out' && t.amount > 0;

/** Cash going back IN to an account — a deposit at an agent. Takes it out of the pocket. */
const isDeposit = (t) => t.type === 'Deposit' && t.direction === 'In' && t.amount > 0;

/** The category a deposit's claim is filed under: moved, not spent. */
export const DEPOSIT_CATEGORY = 'Internal Transfer';

/** What the remainder of a withdrawal is called while nothing has claimed it. */
export const UNCLAIMED_CATEGORY = 'Cash Withdrawal';

/** Counted short: spent in cash, but you did not say on what. */
export const UNACCOUNTED_CATEGORY = 'Cash (unaccounted)';

const day = (iso) => String(iso || '').slice(0, 10);

/**
 * Work out where the cash went.
 *
 * Cash does not keep. Money drawn out in a cycle that has since closed was
 * spent - it has to have been, the month is over - so only what was drawn in the
 * CURRENT cycle can still be in a pocket. Without that line the figure only ever
 * grows: five months of unitemised withdrawals read as twenty-four thousand
 * sitting in a wallet that is empty, which is worse than not showing it at all.
 * Older withdrawals still take claims, so you can itemise last month whenever
 * you like; they just stop being counted as money you are holding.
 *
 * @param {object[]} txns  every transaction being read
 * @param {object[]} runs  itemisations: {id, date, category, amount, items[]}
 * @param {string}   since YYYY-MM-DD the current cycle began; older cash is gone
 * @returns {{splits: Map<string, {category: string, amount: number}[]>,
 *            pocket: number, since: string|null, unmatched: number,
 *            claimed: Map<string, {txnId: string, amount: number}[]>}}
 */
export function allocate(txns, runs = [], since = null) {
  const pool = txns
    .filter(isWithdrawal)
    .map((t) => ({ id: t.id, date: day(t.date), left: t.amount, parts: new Map() }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // A deposit is a claim like any other: the cash stopped being in your pocket.
  // It is filed as a transfer rather than spending, so splitting a withdrawal by
  // it quietly undoes the one case where "withdrawal = spending" was wrong —
  // money taken out and put straight back was never spent at all.
  const claims = [
    ...txns.filter(isDeposit).map((t) => ({
      date: day(t.date),
      amount: t.amount,
      category: DEPOSIT_CATEGORY,
      ref: t.id,
    })),
    ...runs.map((r) => ({
      date: day(r.date),
      amount: Number(r.amount) || 0,
      category: r.category || 'Groceries',
      ref: r.id,
    })),
  ]
    .filter((c) => c.amount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const claimed = new Map(); // claim ref -> which withdrawals paid for it
  let unmatched = 0;

  for (const claim of claims) {
    let owing = claim.amount;
    for (const w of pool) {
      if (owing <= 0) break;
      // Cash cannot be spent before it was drawn. Without this a claim would
      // reach back into last month's withdrawal and the pocket would read as
      // money you had already spent.
      if (w.date > claim.date || w.left <= 0) continue;
      const take = Math.min(w.left, owing);
      w.left -= take;
      owing -= take;
      w.parts.set(claim.category, (w.parts.get(claim.category) || 0) + take);
      if (!claimed.has(claim.ref)) claimed.set(claim.ref, []);
      claimed.get(claim.ref).push({ txnId: w.id, amount: take });
    }
    unmatched += owing;
  }

  const splits = new Map();
  for (const w of pool) {
    if (w.parts.size === 0) continue; // untouched: leave the row exactly as it was
    const parts = [...w.parts.entries()].map(([category, amount]) => ({ category, amount }));
    if (w.left > 0) parts.push({ category: UNCLAIMED_CATEGORY, amount: w.left });
    splits.set(w.id, parts.sort((a, b) => b.amount - a.amount));
  }

  const held = pool.filter((w) => w.left > 0 && (!since || w.date >= since));
  const pocket = held.reduce((a, w) => a + w.left, 0);
  // Cash drawn before this cycle and never accounted for. Not in the pocket, but
  // worth being able to see, because it is the size of the hole in the record.
  const lapsed = pool
    .filter((w) => w.left > 0 && since && w.date < since)
    .reduce((a, w) => a + w.left, 0);

  return { splits, pocket, lapsed, since: held.length ? held[0].date : null, unmatched, claimed };
}

/**
 * The things you buy for cash, most-used first, for the quick-add chips.
 *
 * Drawn from what you have actually typed rather than a list someone else wrote,
 * because the point of the chips is that after a fortnight the first four cover
 * most of a market run. Ties break on recency so a new habit climbs.
 */
export function frequentItems(runs = [], limit = 10) {
  const seen = new Map();
  for (const r of runs) {
    for (const it of r.items || []) {
      const name = String(it.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const cur = seen.get(key) || { name, n: 0, last: '' };
      cur.n++;
      cur.name = name;
      if (r.date > cur.last) cur.last = r.date;
      seen.set(key, cur);
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.name);
}

/** Categories a cash run can be filed under — spending only; you cannot pay a loan in cash here. */
export function cashCategories() {
  return Object.entries(CATEGORIES)
    .filter(([, v]) => v.class === 'spending')
    .map(([name]) => name)
    .sort();
}
