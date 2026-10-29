// Balance over time, and what borrowing costs.
//
// Every transaction carries the running balance the statement printed, and the app
// ignored it entirely. It's the only record of how close to zero the account ran —
// and running out is exactly when Fuliza fires, so the two belong together.

import { CLASSES, classOf } from './rules.js';

/**
 * Daily closing balance per account: the balance on the LAST transaction of each
 * day, since that's what you actually went to bed with.
 */
export function balanceSeries(txns, accountSource = 'mpesa') {
  const rows = txns
    .filter((t) => (t.accountSource || 'mpesa') === accountSource && t.balance != null && t.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const byDay = new Map();
  for (const t of rows) byDay.set(t.date.slice(0, 10), t.balance); // later in the day overwrites
  return [...byDay.entries()].map(([day, balance]) => ({ day, balance }));
}

/** Days the balance sat under a threshold — the shape of running close to empty. */
export function lowDays(series, threshold = 100) {
  return series.filter((p) => p.balance < threshold).length;
}

// Only the borrowing legs themselves — the advance and its repayment.
//
// Deliberately NOT testing `raw`: a purchase funded by Fuliza reads "Pay Bill Online
// Fuliza M-Pesa to TINGG", so matching the word anywhere would swallow the very
// purchases we're trying to identify. The draw's counterparty is the overdraft
// facility; the purchase's counterparty is the merchant.
const isFuliza = (t) =>
  t.type === 'Overdraft Credit' ||
  /^(M-PESA Overdraft|M-PESA Overdraw|Fuliza)/i.test(String(t.counterparty || '').trim());

/**
 * What the overdraft habit actually looks like.
 *
 * Deliberately NOT reporting "repaid − drawn" as the cost: the two legs sit in
 * different periods, so the difference is mostly an artefact of where the statement
 * happens to start and stop, not a fee. Only charges on Fuliza days are real cost,
 * and even those are an estimate — the statement doesn't itemise Fuliza interest.
 */
export function fulizaReport(txns) {
  const rows = txns.filter(isFuliza);
  const draws = rows.filter((t) => t.direction === 'In');
  const repayments = rows.filter((t) => t.direction === 'Out');

  const byMonth = new Map();
  for (const t of draws) {
    if (!t.date) continue;
    const k = t.date.slice(0, 7);
    const m = byMonth.get(k) || { month: k, count: 0, amount: 0 };
    m.count++;
    m.amount += t.amount;
    byMonth.set(k, m);
  }

  // What was he short FOR? The purchase a draw funded shares its receipt code.
  const receipts = new Set(draws.map((t) => t.receipt).filter(Boolean));
  const funded = txns.filter(
    (t) => t.receipt && receipts.has(t.receipt) && t.direction === 'Out' && !isFuliza(t) && classOf(t.category) !== CLASSES.FEE
  );
  const forWhat = new Map();
  for (const t of funded) {
    const c = forWhat.get(t.category) || { category: t.category, count: 0, total: 0 };
    c.count++;
    c.total += t.amount;
    forWhat.set(t.category, c);
  }

  // Charges levied on the same receipts as a draw — the closest the statement gets
  // to naming the price of being short.
  const feesOnDraws = txns
    .filter((t) => t.receipt && receipts.has(t.receipt) && classOf(t.category) === CLASSES.FEE)
    .reduce((a, t) => a + t.amount, 0);

  const dates = draws.map((t) => t.date).filter(Boolean).sort();
  const spanDays = dates.length > 1 ? (new Date(dates.at(-1)) - new Date(dates[0])) / 86400000 : 0;

  const borrowed = draws.reduce((a, t) => a + t.amount, 0);
  const repaid = repayments.reduce((a, t) => a + t.amount, 0);

  // Still owed right now. Fuliza is a revolving overdraft that repays itself the moment
  // money lands in the wallet, so the statement carries every draw and every repayment
  // — we can replay them.
  //
  // NOT a plain (drawn − repaid): a statement often opens mid-cycle, and an early
  // repayment then clears a draw made BEFORE the window we can see. Netting would let
  // that phantom repayment cancel a real later draw and undercount the balance (over
  // one real statement it read 944 when 1,783 had been drawn since the last top-up).
  // So replay chronologically and floor at zero — a repayment can only clear what's
  // actually outstanding, never push the balance negative. The tail of un-repaid draws
  // after the last top-up is what you still owe.
  const legs = rows.filter((t) => t.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  let running = 0;
  for (const t of legs) {
    if (t.direction === 'In') running += t.amount;
    else running = Math.max(0, running - t.amount);
  }
  const outstanding = Math.round(running * 100) / 100;

  return {
    times: draws.length,
    borrowed,
    repaid,
    outstanding,
    avgDraw: draws.length ? borrowed / draws.length : 0,
    feesOnDraws,
    everyNDays: draws.length > 1 && spanDays > 0 ? spanDays / draws.length : null,
    byMonth: [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    forWhat: [...forWhat.values()].sort((a, b) => b.total - a.total).slice(0, 6),
    first: dates[0] || null,
    last: dates.at(-1) || null,
  };
}
