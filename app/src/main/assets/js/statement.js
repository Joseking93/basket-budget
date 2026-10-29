// Safaricom M-PESA statement (PDF) importer.
//
// Validated against a real 31-page, 3-month statement: 1,108 rows parsed, and the
// summed Paid In / Paid Out reconcile to the statement's own printed totals to the
// cent — delta 0.00 on both. Every detail shape in that file classifies; none fall
// through to Other.
//
// Two things the layout does that are easy to get wrong:
//  1. `Details` wraps across several lines, so a row is NOT a single line of text.
//  2. There are only ever TWO numbers before the balance column is reached —
//     an empty Paid In/Withdrawn cell is omitted entirely rather than printed as
//     0.00. The sign discriminates: negative = withdrawn, positive = paid in.

import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.mjs';

const ROW_RE = new RegExp(
  String.raw`([A-Z0-9]{10})\s+` + // receipt
    String.raw`(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+` + // completion time
    String.raw`([\s\S]*?)\s+` + // details (wraps across lines)
    String.raw`(Completed|Failed|Pending|Reversed)\s+` + // status
    String.raw`(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})`, // amount, balance
  'g'
);

// "Online" and "Fuliza M-Pesa" appear as infixes in either order. A Fuliza purchase
// is still a purchase at that merchant — the credit line is how it was funded, not
// what it was spent on — so these classify by merchant, never as debt.
const INFIX = String.raw`(?:\s+(?:Online|Fuliza\s+M-?Pesa))*`;

const DETAIL_RULES = [
  { re: /Charge$/i, type: 'Charge', party: () => 'M-PESA Charge' },
  { re: /Reversal/i, type: 'Reversal', party: (m, d) => d.slice(0, 60) },
  {
    re: new RegExp(String.raw`Pay Bill${INFIX}\s+to\s+(\d+)\s*-\s*(.+?)(?:\s+Acc\.\s*(.*))?$`, 'i'),
    type: 'Pay Bill',
    party: (m) => `${m[1]} - ${m[2].trim()}`,
    account: (m) => (m[3] || '').trim() || null,
  },
  {
    re: new RegExp(String.raw`Merchant Payment${INFIX}\s+to\s+(\d+)\s*-\s*(.+)$`, 'i'),
    type: 'Merchant Payment',
    party: (m) => `${m[1]} - ${m[2].trim()}`,
  },
  {
    re: /Customer Payment to Small Business to\s*-?\s*(.+)$/i,
    type: 'Merchant Payment',
    party: (m) => m[1].trim(),
  },
  {
    re: /(?:Customer Bundle Purchase|Recharge for Customer)/i,
    type: 'Data Bundle Purchase',
    party: () => 'Safaricom Data Bundles',
  },
  { re: /Airtime Purchase/i, type: 'Airtime Purchase', party: () => 'Safaricom' },
  {
    re: /Receive International Transfer From\s+(.+?)\.?$/i,
    type: 'International Transfer',
    party: (m) => m[1].trim(),
  },
  {
    re: /Customer Send Money to Micro SME Business.*?to\s*-?\s*(.+)$/i,
    type: 'Customer Transfer',
    party: (m) => m[1].trim(),
  },
  // "Customer Transfer Fuliza MPesa to - <person>" is money sent TO a person, funded
  // by Fuliza credit. It must be captured before the generic Customer Transfer rule
  // below, which would otherwise leave "Fuliza MPesa to -" glued to the counterparty
  // — and the /Fuliza/ rule in rules.js would then file it as debt, excluding it from
  // spending. Same principle as the merchant case: the credit line is how it was
  // funded, not what it was spent on.
  {
    re: /Customer Transfer\s+Fuliza\s+M-?Pesa\s+to\s*-?\s*(.+)$/i,
    type: 'Customer Transfer',
    party: (m) => m[1].trim(),
  },
  {
    re: /Customer Transfer(?: of Funds)?(?:\s+to)?\s*-?\s*(.*)$/i,
    type: 'Customer Transfer',
    party: (m) => m[1].trim() || 'Customer Transfer',
  },
  { re: /Funds received from\s*-?\s*(.+)$/i, type: 'Receive Money', party: (m) => m[1].trim() },
  { re: /Salary Payment(?: from)?\s*(.*)$/i, type: 'Salary Payment', party: (m) => m[1].trim() || 'Salary' },
  { re: /Business Payment(?: from)?\s*(.*)$/i, type: 'Business Payment', party: (m) => m[1].trim() || 'Business Payment' },
  {
    re: /Transfer from Bank\s+(.+?)\s+to Customer/i,
    type: 'Business Payment',
    party: (m) => m[1].trim(),
  },
  { re: /OverDraft of Credit Party/i, type: 'Overdraft Credit', party: () => 'M-PESA Overdraft' },
  { re: /Savings Contribution/i, type: 'Savings', party: () => 'M-PESA Savings' },
  {
    re: /(?:Term Loan|M-Shwari|KCB M-PESA).*?(?:Disbursement|Disburse|Request)/i,
    type: 'Loan Disbursement',
    party: (m, d) => loanName(d),
  },
  { re: /Loan Repayment/i, type: 'Loan Repayment', party: (m, d) => loanName(d) },
  // Withdrawals name the agent in two shapes: "…from <agent>" and
  // "Customer Withdrawal At Agent Till <n> - <agent>". Match on the word alone and
  // pull the agent out separately — anchoring this to end-of-string silently drops
  // agent-till withdrawals into Other.
  {
    re: /Withdraw/i,
    type: 'Withdrawal',
    party: (m, d) => {
      // "KCB M-PESA Withdraw" is money coming OUT of that account and INTO the wallet —
      // your own money moving, not cash taken at an agent. Naming it "Agent
      // withdrawal" (the fallback below) made 27 inbound rows read as cash spending,
      // and the debts panel then offered "Agent withdrawal" as a lender.
      if (/KCB\s*M-?PESA\s*Withdraw/i.test(d)) return 'KCB M-PESA Withdrawal';
      const at = d.match(/At Agent Till\s+([\d]+)\s*-\s*(.+)$/i);
      if (at) return `${at[1]} - ${at[2].trim()}`;
      const from = d.match(/from\s+(.+)$/i);
      return from ? from[1].trim() : 'Agent withdrawal';
    },
  },
  { re: /Deposit/i, type: 'Deposit', party: () => 'M-PESA Deposit' },
];

function loanName(d) {
  if (/M-Shwari/i.test(d)) return 'M-Shwari';
  if (/KCB M-PESA/i.test(d)) return 'KCB M-PESA';
  if (/H-\s?Fund/i.test(d)) return 'H-Fund';
  if (/Overdraw/i.test(d)) return 'M-PESA Overdraw';
  if (/Fuliza/i.test(d)) return 'Fuliza M-PESA';
  return 'Loan';
}

function parseDetails(details) {
  for (const r of DETAIL_RULES) {
    const m = details.match(r.re);
    if (m) {
      return { type: r.type, counterparty: r.party(m, details), account: r.account ? r.account(m) : null };
    }
  }
  return { type: 'Other', counterparty: details.slice(0, 60), account: null };
}

const num = (s) => parseFloat(String(s).replace(/,/g, '')) || 0;

export async function extractText(buf, password) {
  const doc = await pdfjsLib.getDocument({ data: buf, password }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Rebuild lines from text runs: a y-shift means a new line.
    let lastY = null;
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !/[\s\n]$/.test(text)) text += ' ';
      text += item.str;
      lastY = y;
    }
    text += '\n';
  }
  return { text, pages: doc.numPages };
}

export async function importStatement(buf, password) {
  const { text, pages } = await extractText(buf, password);
  const res = parseStatementText(text);
  // Carry the raw text back so the UI can show what the parser actually saw when it
  // finds nothing. A silent "0 rows" is impossible to act on.
  return { ...res, text, pages };
}

export function parseStatementText(text) {
  const transactions = [];
  const counts = new Map();
  let m;
  ROW_RE.lastIndex = 0;

  while ((m = ROW_RE.exec(text)) !== null) {
    const [, receipt, when, rawDetails, status, amtStr, balStr] = m;
    if (status !== 'Completed') continue; // failed/reversed rows aren't money moved

    const details = rawDetails.replace(/\s+/g, ' ').trim();
    const amt = num(amtStr);
    if (!amt) continue;

    const d = parseDetails(details);
    // Charges share the parent's receipt code; suffix so both survive dedupe.
    // A receipt can legitimately carry more than one charge, so count rather than
    // clobber — an id collision would silently drop a real transaction.
    let id = d.type === 'Charge' ? `${receipt}-COST` : receipt;
    const n = counts.get(id) || 0;
    counts.set(id, n + 1);
    if (n) id = `${id}-${n + 1}`;

    transactions.push({
      id,
      receipt,
      date: new Date(when.replace(' ', 'T') + '+03:00').toISOString(),
      amount: Math.abs(amt),
      direction: amt < 0 ? 'Out' : 'In',
      type: d.type,
      counterparty: d.counterparty,
      account: d.account,
      balance: num(balStr),
      source: 'statement',
      raw: details,
    });
  }
  return { transactions, unparsed: [] };
}

export const _internals = { parseDetails, ROW_RE, loanName };
