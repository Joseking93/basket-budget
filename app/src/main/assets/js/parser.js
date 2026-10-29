// Parses raw M-PESA SMS text into structured transactions.
//
// Every transaction is keyed by its M-PESA receipt code (e.g. UFT8N9M0TA), which
// Safaricom guarantees unique. That code is what lets a pasted SMS and the same
// transaction arriving later in a statement collapse into one record.
//
// Anything we cannot parse is returned in `unparsed` rather than dropped, so the
// UI can show it. Silently swallowing a message would quietly understate spending.
//
// Patterns use NAMED groups, not positions. The withdrawal pattern used to read
// its amount from group 3 and its agent from group 4 while the regex actually put
// the time and the amount there — so every withdrawal read from an SMS was filed
// as "Ksh 2.00 from 1,000.00". Positional groups make that mistake invisible;
// named ones make it impossible.

const CUR = String.raw`(?:Kshs?|KES)\s?`;
const NUM = String.raw`[\d,]+(?:\.\d{1,2})?`;
const RECEIPT = String.raw`(?<rcpt>[A-Z0-9]{10})`;
// Safaricom is inconsistent about the gap after "Confirmed" — sometimes a full
// stop, sometimes a newline, sometimes nothing at all.
const CONF = `${RECEIPT}\\s*[Cc]onfirmed[.\\s]*`;
const DATE = String.raw`(?<d>\d{1,2}\/\d{1,2}\/\d{2,4})`;
const TIME = String.raw`(?<t>\d{1,2}:\d{2}\s?(?:[AP]\.?M\.?)?)`;
const AT = `on\\s+${DATE}\\s*(?:at\\s*)?${TIME}`;
// Every balance line, whether the message says "New M-PESA balance" (most of them)
// or just "M-PESA balance" (the Fuliza repayments).
const BAL = `(?:New |Your )?M-?PESA balance is`;

const amt = (name) => `${CUR}(?<${name}>${NUM})`;

function money(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/[.,]$/, '').trim();
}

// M-PESA writes dates as d/m/yy and times as "8:36 AM". Kenya is UTC+3 with no DST.
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const [d, m, y] = dateStr.split('/').map((n) => parseInt(n, 10));
  const year = y < 100 ? 2000 + y : y;
  let hour = 0;
  let minute = 0;
  const t = String(timeStr || '').match(/(\d{1,2}):(\d{2})\s*([AP])?/i);
  if (t) {
    hour = parseInt(t[1], 10);
    minute = parseInt(t[2], 10);
    const mer = (t[3] || '').toUpperCase();
    if (mer === 'P' && hour !== 12) hour += 12;
    if (mer === 'A' && hour === 12) hour = 0;
  }
  return new Date(Date.UTC(year, m - 1, d, hour - 3, minute)).toISOString();
}

// Ordered most-specific first: "sent to X for account Y" must beat plain "sent to X".
const PATTERNS = [
  {
    type: 'Pay Bill',
    direction: 'Out',
    // The account number runs to " on <date>" rather than matching a character
    // class. It is printed verbatim from the biller and carries dots, hashes,
    // colons and spaces; when the class guessed wrong the message fell through to
    // "sent to" and lost the account entirely.
    re: new RegExp(`${CONF}${amt('amt')} sent to (?<who>.+?) for account (?<acct>.+?) ${AT}`, 'i'),
  },
  {
    type: 'Merchant Payment',
    direction: 'Out',
    re: new RegExp(`${CONF}${amt('amt')} paid to (?<who>.+?)[.\\s]*${AT}`, 'i'),
  },
  {
    type: 'Customer Transfer',
    direction: 'Out',
    re: new RegExp(`${CONF}${amt('amt')} sent to (?<who>.+?) ${AT}`, 'i'),
  },
  {
    type: 'Receive Money',
    direction: 'In',
    re: new RegExp(`${CONF}You have received ${amt('amt')} from (?<who>.+?) ${AT}`, 'i'),
  },
  {
    // Loan disbursements and some bank credits arrive this way. Money in, but
    // borrowing is not earning — rules.js files the known lenders under credit.
    type: 'Credited',
    direction: 'In',
    re: new RegExp(
      `${CONF}${amt('amt')} has been credited to your M-PESA account from (?<who>.+?)[.\\s]*${AT}`,
      'i'
    ),
  },
  {
    // The same, from no one in particular.
    type: 'Credited',
    direction: 'In',
    re: new RegExp(`${CONF}${amt('amt')} has been credited to your M-PESA account[.\\s]*${AT}`, 'i'),
    who: 'M-PESA Credit',
  },
  {
    // "Your loan repayment of Ksh2,716.00 from your M-PESA account to KCB
    // M-PESA on 24/8/22 at 2:00 PM is successful."
    type: 'Loan Repayment',
    direction: 'Out',
    re: new RegExp(
      `${CONF}Your loan repayment of ${amt('amt')} from your M-PESA account to (?<who>.+?) ${AT}`,
      'i'
    ),
  },
  {
    // "Loan of Ksh2,150.00 repaid from M-PESA on 5/4/24 at 5:36 PM." Nobody is
    // named, so it carries the only thing the message says it is.
    type: 'Loan Repayment',
    direction: 'Out',
    re: new RegExp(`${CONF}Loan of ${amt('amt')} repaid from M-PESA ${AT}`, 'i'),
    who: 'Loan',
  },
  {
    // "Your M-Shwari loan has been approved on 24/3/24 3:35 PM and Ksh1,970.00
    // less excise duty has been deposited to your M-PESA account." Money in,
    // and rules.js files the lender under credit rather than income.
    type: 'Loan Disbursement',
    direction: 'In',
    re: new RegExp(
      `${CONF}Your (?<who>[A-Za-z0-9&\\-. ]+?) loan has been approved ${AT} and ${amt('amt')}`,
      'i'
    ),
  },
  {
    // "You have transferred Ksh500.00 from your KCB M-PESA account on ..."
    // FROM the savings or loan account means money arriving in the wallet.
    type: 'Savings',
    direction: 'In',
    re: new RegExp(
      `${CONF}You have transferred ${amt('amt')} (?<dir>to|from) your (?<who>[A-Za-z0-9&\\-. ]+?) account[.\\s]*${AT}`,
      'i'
    ),
    after: (t, g) => {
      t.direction = /^from$/i.test(g.dir) ? 'In' : 'Out';
      t.counterparty = clean(g.who) || 'M-PESA Savings';
    },
  },
  {
    // "You have sent Ksh800.52 to Hustler Fund on 28/12/2022  at 05:20 PM."
    type: 'Customer Transfer',
    direction: 'Out',
    re: new RegExp(`${CONF}You have sent ${amt('amt')} to (?<who>.+?) ${AT}`, 'i'),
  },
  {
    type: 'Withdrawal',
    direction: 'Out',
    re: new RegExp(`${CONF}${AT}\\s*Withdraw ${amt('amt')} from (?<who>.+?)\\s*${BAL}`, 'i'),
  },
  {
    // Cash handed over at an agent. Money IN to the wallet, but it is your own
    // cash arriving, not earnings — rules.js keeps it out of income and spending
    // both, the same way a transfer between your own accounts is kept out.
    type: 'Cash Deposit',
    direction: 'In',
    re: new RegExp(`${CONF}${AT}\\s*Give ${amt('amt')} cash to (?<who>.+?)\\s*${BAL}`, 'i'),
  },
  {
    type: 'Deposit',
    direction: 'In',
    re: new RegExp(`${CONF}${amt('amt')} deposited to your M-PESA account[.\\s]*${AT}`, 'i'),
    who: 'M-PESA Deposit',
  },
  {
    type: 'Airtime Purchase',
    direction: 'Out',
    re: new RegExp(
      `${CONF}You bought ${amt('amt')} of airtime(?: for (?<who>\\+?\\d+))?[.\\s]*${AT}`,
      'i'
    ),
    who: 'Safaricom Airtime',
    whoPrefix: 'Safaricom Airtime for ',
  },
  {
    type: 'Data Bundle Purchase',
    direction: 'Out',
    re: new RegExp(
      `${CONF}You bought ${amt('amt')} of (?:data bundles?|data|bundles?)(?: for \\+?\\d+)?[.\\s]*${AT}`,
      'i'
    ),
    who: 'Safaricom Data Bundles',
  },
  {
    // Anything else bought straight from the wallet, named by what it was.
    type: 'Purchase',
    direction: 'Out',
    re: new RegExp(`${CONF}You bought ${amt('amt')} of (?<who>[^.\\n]+?)[.\\s]*${AT}`, 'i'),
  },
  {
    // M-Shwari, KCB M-PESA, M-PESA savings — one shape, many products. The product
    // name comes out of the message rather than being listed here, so a new
    // savings rail does not need a code change to be read.
    type: 'Savings',
    direction: 'Out',
    re: new RegExp(
      `${CONF}${amt('amt')} transferred (?<dir>to|from) (?<who>[A-Za-z0-9&\\-. ]*?)\\s*account[.\\s]*(?:${AT})?`,
      'i'
    ),
    after: (t, g) => {
      t.direction = /^from$/i.test(g.dir) ? 'In' : 'Out';
      t.counterparty = clean(g.who) || 'M-PESA Savings';
    },
  },
  {
    // "Ksh 42.54 from your M-PESA has been used to fully pay your outstanding
    // Fuliza M-PESA." These carry NO date and no "New" on the balance line, which
    // is why hundreds of them were landing in the not-recognised pile. The date
    // comes from the message's own timestamp, which the phone now hands over.
    type: 'Loan Repayment',
    direction: 'Out',
    re: new RegExp(
      `${CONF}${amt('amt')} from your M-PESA (?:account )?has been used to (?:fully |partially )?(?:repay|pay)(?: your)?(?: outstanding)? (?<who>[^.\\n]+?)(?:[.\\n]|$)`,
      'i'
    ),
  },
  {
    // Money coming back after a reversal. The reversed receipt is in the text, but
    // this transaction has its own, so the two never collide.
    type: 'Refund',
    direction: 'In',
    re: new RegExp(
      `${CONF}[^]*?${amt('amt')} has been (?:returned|reversed)[^]*?${AT}`,
      'i'
    ),
    who: 'M-PESA Reversal',
  },
];

// A Fuliza draw rides along with whatever transaction it funded, so it is read
// separately rather than as one of the shapes above.
const FULIZA_RE = new RegExp(`${CONF}[^]*?Fuliza M-PESA amount is ${amt('amt')}`, 'i');

// Recognised, but not money moving. These are not failures and must not be listed
// as "could not read" — doing that is what turned the panel into a wall of noise.
const NOT_A_TRANSACTION = [
  /M-PESA balance was/i,
  /balance (?:enquiry|inquiry)/i,
  /has been registered/i,
  /Fuliza M-PESA limit (?:has been|is now|increased|decreased)/i,
  /you have requested a statement/i,
  /your statement (?:is|has been)/i,
  /PIN (?:has been|was) (?:changed|reset)/i,
  /opted (?:in|out)/i,
  /loan request will be processed/i,
  /loan (?:application|request) (?:was|has been) (?:received|declined|rejected)/i,
  /you (?:do not|don't) have enough/i,
];

/**
 * @param {string} raw one or more M-PESA SMS messages
 * @returns {{transactions: object[], unparsed: string[], ignored: number}}
 */
export function parseMessages(raw) {
  const transactions = [];
  const unparsed = [];
  let ignored = 0;
  // Messages arrive oldest first. A dateless message (a Fuliza repayment) happens
  // within seconds of the transaction that triggered it, so the previous one's
  // date is a far better answer than nothing — and when the phone hands over the
  // message's own timestamp, that is used instead and this never comes up.
  let lastDate = null;

  for (const block of splitMessages(raw)) {
    const { body, at } = stripStamp(block);
    const txns = parseOne(body, at || lastDate);
    if (txns.length) {
      transactions.push(...txns);
      lastDate = txns[0].date || lastDate;
    } else if (NOT_A_TRANSACTION.some((re) => re.test(body))) {
      ignored++;
    } else {
      unparsed.push(body);
    }
  }
  return { transactions, unparsed, ignored };
}

// The app wraps each message the phone hands over in its own timestamp, because
// several M-PESA messages carry no date of their own.
const STAMP_RE = /^#at (\d+)\n?/;

function stripStamp(block) {
  const m = block.match(STAMP_RE);
  if (!m) return { body: block, at: null };
  return { body: block.slice(m[0].length).trim(), at: new Date(Number(m[1])).toISOString() };
}

// Messages get pasted run-together. A receipt code followed by "Confirmed" reliably
// marks the start of a new one, so split there rather than on newlines. When the
// phone supplies them they arrive stamped, one per message, and that boundary is
// exact — so it wins.
function splitMessages(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  if (/^#at \d+/m.test(text)) {
    return text.split(/\n(?=#at \d+\n)/).map((s) => s.trim()).filter(Boolean);
  }

  const starts = [];
  const re = /\b[A-Z0-9]{10}\s+[Cc]onfirmed/g;
  let m;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  if (!starts.length) return text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  const blocks = [];
  if (starts[0] > 0) {
    const pre = text.slice(0, starts[0]).trim();
    if (pre) blocks.push(pre);
  }
  for (let i = 0; i < starts.length; i++) {
    blocks.push(text.slice(starts[i], starts[i + 1] ?? text.length).trim());
  }
  return blocks.filter(Boolean);
}

function parseOne(block, fallbackDate = null) {
  const out = [];

  for (const p of PATTERNS) {
    const m = block.match(p.re);
    if (!m) continue;
    const g = m.groups;

    const receipt = g.rcpt.toUpperCase();
    const date = parseDateTime(g.d, g.t) || fallbackDate;
    let counterparty = clean(g.who) || p.who || p.type;
    if (g.who && p.whoPrefix) counterparty = p.whoPrefix + clean(g.who);

    const txn = {
      id: receipt,
      receipt,
      date,
      amount: money(g.amt),
      direction: p.direction,
      type: p.type,
      counterparty,
      account: g.acct ? clean(g.acct) : null,
      balance: matchBalance(block),
      source: 'sms',
      raw: block,
    };
    if (p.after) p.after(txn, g);
    out.push(txn);

    // The transaction cost is a real, separate outflow. M-PESA reports it inside the
    // parent message, so it shares the receipt code — suffix it to keep ids unique.
    const cost = block.match(new RegExp(`Transaction cost,?\\s*${CUR}(${NUM})`, 'i'));
    if (cost && money(cost[1]) > 0) {
      out.push({
        id: `${receipt}-COST`,
        receipt,
        date: txn.date,
        amount: money(cost[1]),
        direction: 'Out',
        type: 'Charge',
        counterparty: 'M-PESA Charge',
        account: null,
        balance: null,
        source: 'sms',
        raw: block,
      });
    }
    break;
  }

  // A Fuliza overdraft can accompany another transaction, so it is not an else-branch.
  const f = block.match(FULIZA_RE);
  if (f && !out.some((t) => t.type === 'Fuliza')) {
    const anchor = out[0];
    out.push({
      id: `${f.groups.rcpt.toUpperCase()}-FULIZA`,
      receipt: f.groups.rcpt.toUpperCase(),
      date: anchor ? anchor.date : fallbackDate,
      amount: money(f.groups.amt),
      // A draw is money arriving in the wallet to cover a shortfall, so its
      // direction is In — the same convention the statement importer uses for
      // "OverDraft of Credit Party". It was 'Out' here, which meant every draw
      // read from an SMS was replayed by the Fuliza panel as a REPAYMENT and the
      // outstanding balance came out too low. rules.js files it as credit, so it
      // never reaches the income figure.
      direction: 'In',
      type: 'Fuliza',
      counterparty: 'Fuliza M-PESA',
      account: null,
      balance: null,
      source: 'sms',
      raw: block,
    });
  }

  // A transaction with no date at all cannot be placed on any chart or in any
  // month, so it is honest to report it as unread rather than file it under today.
  if (out.length && !out[0].date) return [];

  return out;
}

function matchBalance(block) {
  const b = block.match(new RegExp(`${BAL} ${CUR}(${NUM})`, 'i'));
  return b ? money(b[1]) : null;
}

/**
 * Groups messages the parser could not read by SHAPE, so a few hundred failures
 * read as a handful of lines instead of a wall of text. Receipt codes, amounts and
 * numbers are the part that varies; what is left is the sentence Safaricom used,
 * which is the only thing worth looking at when deciding what to teach it next.
 */
export function groupUnparsed(list) {
  const groups = new Map();
  for (const text of list) {
    // What varies between two messages of the same shape is the receipt, the
    // amounts, the numbers and the SHOUTED name of whoever was paid — M-PESA
    // prints merchants and people in capitals. Strip all four and what is left is
    // the sentence Safaricom wrote, which is the thing worth reading.
    const key = String(text)
      .replace(/\b[A-Z0-9]{10}\b/g, '')
      .replace(/(?:Ksh|KES)\s?[\d,]+(?:\.\d{1,2})?/gi, '#')
      .replace(/\b[\d][\d,.\/:]*\b/g, '#')
      .replace(/\b[A-Z][A-Z'&.\-]+\b/g, '')
      .replace(/[#\s]+/g, ' ')
      .trim()
      .slice(0, 110);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, sample: text });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export const _internals = { splitMessages, parseDateTime, parseOne };
