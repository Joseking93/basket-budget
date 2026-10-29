// What the app can honestly work out about a name before you tell it.
//
// Most of categorising is not hard, it is just long: ninety rows, twenty people,
// the same decision made over and over. The triage screen already collapses the
// rows into names. What was missing is that for some of those names the answer
// is already sitting in the data, and the app was making you type it anyway.
//
// Only two signals here are strong enough to act on, and both are arithmetic
// rather than guesswork:
//
//   money that came back    — 4,000 out to a person and 4,000 back from them is
//                             a loan repaid, not 8,000 of spending. Getting this
//                             wrong in either direction moves real money: filed
//                             as spending it doubles, and the repayment lands in
//                             income as if you had earned it.
//
//   a decision you already made — one row of this person's set by hand, the rest
//                             left behind. That is not a guess at all, it is
//                             your own answer being offered back.
//
// Everything else — whether 3,000 to a cousin was groceries or rent — the app
// has no way to know, and a confident wrong guess is worse than a blank, because
// you would have to check the ones it got right as well.

/** Two amounts near enough to be the same money going back the other way. */
const SAME_MONEY = (a, b) => Math.abs(a - b) <= Math.max(50, a * 0.1);

/**
 * Pair outgoing amounts with incoming ones from the same person.
 *
 * Greedy, biggest first, each amount used once: 4,000 out and 4,000 back is one
 * pair, not two. Returns what matched so the screen can say WHICH amounts it
 * means — "money came back" on its own is the kind of hint that makes you go
 * and check, which is the work this is supposed to save.
 */
export function repayments(rows) {
  const outs = rows.filter((t) => t.direction === 'Out').sort((a, b) => b.amount - a.amount);
  const ins = rows.filter((t) => t.direction === 'In').sort((a, b) => b.amount - a.amount);
  const used = new Set();
  const pairs = [];

  for (const o of outs) {
    const back = ins.find((i) => !used.has(i.id) && SAME_MONEY(o.amount, i.amount) && (!i.date || !o.date || i.date >= o.date));
    if (!back) continue;
    used.add(back.id);
    pairs.push({ out: o, back });
  }
  return pairs;
}

/**
 * The category to offer for a name, or null when nothing is known.
 *
 * @param {object[]} rows      every transaction of this person's
 * @param {Function} chosenFor   the category you SET on a row, if you set one
 * @returns {{category: string, why: string, sure: boolean}|null}
 */
export function suggestFor(rows, chosenFor) {
  // 1. Money that went out and came back. This is checked first because it is
  // arithmetic, and because the repayment itself has usually been filed as
  // Income by the ordinary rules - which is the very mistake it is here to
  // catch, so taking the row's current category as an answer would launder it.
  const pairs = repayments(rows);
  if (pairs.length) {
    const total = pairs.reduce((a, p) => a + p.out.amount, 0);
    return {
      category: 'Money Lent',
      why:
        pairs.length === 1
          ? `${fmtish(pairs[0].out.amount)} went out and came back`
          : `${pairs.length} amounts went out and came back (${fmtish(total)})`,
      sure: true,
    };
  }

  // 2. An answer you gave by hand on one of these rows and not the rest. Only a
  // category you SET counts - what a built-in rule happened to produce is not a
  // decision, it is the default that left the row in this list to begin with.
  const decided = rows.map(chosenFor).find(Boolean);
  if (decided) {
    return { category: decided, why: 'you already put one of these there', sure: true };
  }

  // 3. Money came back, but not in matching amounts — still more like lending
  // than like spending, and worth saying so without pretending to be certain.
  const back = rows.filter((t) => t.direction === 'In').reduce((a, t) => a + t.amount, 0);
  const sent = rows.filter((t) => t.direction === 'Out').reduce((a, t) => a + t.amount, 0);
  if (back > 0 && sent > 0) {
    return { category: 'Money Lent', why: `${fmtish(back)} has come back from them`, sure: false };
  }

  return null;
}

const fmtish = (n) => Math.round(n).toLocaleString('en-GB');
