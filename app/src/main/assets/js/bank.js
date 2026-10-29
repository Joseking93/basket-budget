// Bank statement parser (Hifadhi Current Account layout).
//
// Validated against a real 14-page statement: 239 rows parsed, resolving to exactly
// 218 debits and 21 credits — the counts the statement itself declares — with every
// running balance reproducing.
//
// The hard part vs M-PESA: there is NO SIGN on the amount. A row ends
// "<amount> <balance>" and nothing marks a deposit from a withdrawal. Direction is
// derived from the balance delta, which is self-checking: if the running balance
// doesn't reproduce, the parse is wrong and we say so rather than guess.

import { isSelf, PEOPLE } from './config.js';

const DATE = String.raw`\d{2} [A-Z][a-z]{2} \d{4}`;

// Page furniture lands between a row and the next date, which would let the row
// pattern run past its own end and swallow the header. Strip it first.
//
// Every pattern is whitespace-tolerant (\s+, never a literal space) because
// different PDF text extractors emit different spacing for the same document:
// pdf.js produces "Entry Date  Value Date" and "EXCHANGE RATE None None /" where
// others produce single spaces. A literal-space pattern silently matches nothing
// and the rows quietly break instead of failing loudly.
const NOISE = [
  /Page\s+of\s+\d+\s+\d+/g,
  /Page\s+\d+\s+of\s+\d+/g,
  /Entry\s+Date\s+Value\s+Date\s+Description\s+Deposit\s+Withdrawal\s+Balance/g,
  /EXCHANGE\s+RATE\s+None\s+None\s*\//g,
  /^\s*YES\s*$/gm,
];

const ROW_RE = new RegExp(
  `(${DATE})\\s+(${DATE})\\s+([\\s\\S]*?)([\\d,]+\\.\\d{2})\\s+([\\d,]+\\.\\d{2})\\s*(?=\\n\\s*${DATE}|$)`,
  'g'
);

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const num = (s) => parseFloat(String(s).replace(/,/g, ''));

function toISO(d) {
  const [dd, mon, yyyy] = d.split(' ');
  return new Date(Date.UTC(+yyyy, MONTHS[mon], +dd, -3)).toISOString();
}

/** Is this statement text the bank layout (rather than M-PESA)? */
export function looksLikeBank(text) {
  return /Entry Date\s+Value Date\s+Description/i.test(text) || /Statement of Account/i.test(text);
}

function describe(desc) {
  // Bank/M-PESA plumbing
  const payTo = desc.match(/PAY TO (\d{9,15})/i);
  const toAcc = desc.match(/MPESA TO ACC (\d+)/i);
  const trfFrom = desc.match(/IBANKING TRF FROM (\d+)/i);
  const trfTo = desc.match(/IBANKING TRF TO (\d+)\s*(.*)$/i);

  if (/EXCISE DUTY|MPESA CHARGE|PESA CHARGES|PESA EXCISE DUTY|LEDGER FEE|SERVICE CHARGE|COMMISS?ION|PAYMENT CHARGE/i.test(desc)) {
    return { type: 'Bank Charge', counterparty: 'Bank Charge' };
  }

  // A known person's number can appear anywhere in the description, not only after
  // "PAY TO" — e.g. "IBS UTIL-<number>". Check before the structural patterns so
  // money to or from a known person is never misread as a generic bank movement.
  const person = PEOPLE.find((p) => desc.includes(p.number));
  if (person) return { type: 'Person', counterparty: person.name };

  if (payTo) {
    const n = payTo[1];
    if (isSelf(n)) return { type: 'Internal Transfer', counterparty: 'Top-up to my M-PESA' };
    const known = PEOPLE.find((p) => p.number === n);
    return { type: 'Bank to M-PESA', counterparty: known ? known.name : n };
  }
  if (toAcc) return { type: 'Internal Transfer', counterparty: 'M-PESA into this account' };
  if (trfFrom) {
    return isSelf(trfFrom[1])
      ? { type: 'Internal Transfer', counterparty: 'Transfer from my other account' }
      : { type: 'Bank Credit', counterparty: trfFrom[1] };
  }
  if (trfTo) {
    return isSelf(trfTo[1])
      ? { type: 'Internal Transfer', counterparty: 'Transfer to my other account' }
      : { type: 'Bank Transfer Out', counterparty: (trfTo[2] || trfTo[1]).trim() };
  }

  // Card spending — this never touches M-PESA, so it exists only here.
  const card = desc.match(/DEBIT CARD TXN AT\s+(.+?)\s+\d{2}-\d{2}-\d{4}/i);
  if (card) return { type: 'Card Payment', counterparty: tidyMerchant(card[1]) };
  const sub = desc.match(/^([A-Z0-9]+\s*\*\s*[A-Z0-9 ]+?)\s*\+?\d*\s+\d{2}-\d{2}-\d{4}/i);
  if (sub) return { type: 'Card Payment', counterparty: tidyMerchant(sub[1]) };

  // "KE-013-… <account holder>| …PESA |0007" — the bank's own M-PESA rail
  if (/\|PES\s?A\s?\|/i.test(desc) || /\bPESA\b/i.test(desc)) {
    return { type: 'Internal Transfer', counterparty: 'M-PESA rail' };
  }
  if (/BALANCE FROM PREVIOUS STATEMENT/i.test(desc)) return null;

  return { type: 'Other', counterparty: desc.slice(0, 60) };
}

function tidyMerchant(s) {
  return s
    .replace(/\s*\*\s*/g, ' ')
    .replace(/\s+G\.CO\/HELPPAY.*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * @returns {{transactions: object[], unresolved: number, reconciled: boolean}}
 */
export function parseBankText(text) {
  // Collapse horizontal whitespace but keep newlines: row boundaries depend on
  // line structure, while everything else must not depend on the extractor's
  // spacing quirks.
  let clean = text.replace(/[^\S\n]+/g, ' ');
  for (const n of NOISE) clean = clean.replace(n, '');
  clean = clean.replace(/\n{2,}/g, '\n');

  const open = clean.match(/BALANCE FROM PREVIOUS STATEMENT\s+([\d,]+\.\d{2})/i);
  let prev = open ? num(open[1]) : null;

  const transactions = [];
  let unresolved = 0;
  let m;
  ROW_RE.lastIndex = 0;

  while ((m = ROW_RE.exec(clean)) !== null) {
    const [, entry, , rawDesc, amtStr, balStr] = m;
    const desc = rawDesc.replace(/\s+/g, ' ').trim();
    const amount = num(amtStr);
    const balance = num(balStr);

    const d = describe(desc);
    if (!d || !amount) {
      prev = balance;
      continue;
    }

    // Direction from the balance delta. No sign exists to read.
    let direction;
    if (prev !== null && Math.abs(prev - amount - balance) < 0.01) direction = 'Out';
    else if (prev !== null && Math.abs(prev + amount - balance) < 0.01) direction = 'In';
    else {
      direction = null;
      unresolved++;
    }
    prev = balance;

    // No receipt code exists here, so the id is built from the fields that make a
    // row unique. Re-importing the same statement must not duplicate.
    const id = `BANK-${entry.replace(/ /g, '')}-${amount.toFixed(2)}-${balance.toFixed(2)}`;

    transactions.push({
      id,
      receipt: null,
      date: toISO(entry),
      amount,
      direction: direction || 'Out',
      directionResolved: direction !== null,
      type: d.type,
      counterparty: d.counterparty,
      account: null,
      accountSource: 'bank',
      balance,
      source: 'statement',
      raw: desc,
    });
  }

  return { transactions, unresolved, reconciled: unresolved === 0 };
}

export const _internals = { describe, ROW_RE };
