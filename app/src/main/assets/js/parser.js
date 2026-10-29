// Parses raw M-PESA SMS text into structured transactions.
//
// Every transaction is keyed by its M-PESA receipt code (e.g. UFT8N9M0TA), which
// Safaricom guarantees unique. That code is what lets a pasted SMS and the same
// transaction arriving later in a statement collapse into one record.
//
// Anything we cannot parse is returned in `unparsed` rather than dropped, so the
// UI can show it. Silently swallowing a message would quietly understate spending.

const MONEY = String.raw`(?:Ksh|KES)\s?([\d,]+(?:\.\d{1,2})?)`;
const RECEIPT = String.raw`([A-Z0-9]{10})`;

// M-PESA writes dates as d/m/yy and times as "8:36 AM". Kenya is UTC+3 with no DST.
function parseDateTime(dateStr, timeStr) {
  const [d, m, y] = dateStr.split('/').map((n) => parseInt(n, 10));
  const year = y < 100 ? 2000 + y : y;
  let hour = 0;
  let minute = 0;
  const t = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (t) {
    hour = parseInt(t[1], 10);
    minute = parseInt(t[2], 10);
    const mer = (t[3] || '').toUpperCase();
    if (mer === 'PM' && hour !== 12) hour += 12;
    if (mer === 'AM' && hour === 12) hour = 0;
  }
  return new Date(Date.UTC(year, m - 1, d, hour - 3, minute)).toISOString();
}

function money(s) {
  return parseFloat(String(s).replace(/,/g, ''));
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

// Ordered most-specific first: "sent to X for account Y" must beat plain "sent to X".
const PATTERNS = [
  {
    type: 'Pay Bill',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*${MONEY} sent to (.+?) for account ([\\w\\-\\/ ]+?) on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({ counterparty: clean(m[3]), account: clean(m[4]), date: parseDateTime(m[5], m[6]) }),
  },
  {
    type: 'Merchant Payment',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*${MONEY} paid to (.+?)[.\\s]*on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({ counterparty: clean(m[3]), date: parseDateTime(m[4], m[5]) }),
  },
  {
    type: 'Customer Transfer',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*${MONEY} sent to (.+?) on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({ counterparty: clean(m[3]), date: parseDateTime(m[4], m[5]) }),
  },
  {
    type: 'Receive Money',
    direction: 'In',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*You have received ${MONEY} from (.+?) on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({ counterparty: clean(m[3]), date: parseDateTime(m[4], m[5]) }),
  },
  {
    type: 'Withdrawal',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?) Withdraw ${MONEY} from (.+?) New M-PESA balance`,
      'i'
    ),
    map: (m) => ({ counterparty: clean(m[4]), date: parseDateTime(m[2], m[3]) }),
    amountAt: 3,
  },
  {
    type: 'Deposit',
    direction: 'In',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*${MONEY} deposited to your M-PESA account on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({ counterparty: 'M-PESA Deposit', date: parseDateTime(m[3], m[4]) }),
  },
  {
    type: 'Airtime Purchase',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} [Cc]onfirmed[.\\s]*You bought ${MONEY} of airtime(?: for (\\d+))? on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({
      counterparty: m[3] ? `Safaricom Airtime for ${m[3]}` : 'Safaricom Airtime',
      date: parseDateTime(m[4], m[5]),
    }),
  },
  {
    type: 'Data Bundle Purchase',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} [Cc]onfirmed[.\\s]*You bought ${MONEY} of (?:data|bundles?)(?: for (\\d+))? on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m) => ({ counterparty: 'Safaricom Data Bundles', date: parseDateTime(m[4], m[5]) }),
  },
  {
    type: 'M-Shwari',
    direction: 'Out',
    re: new RegExp(
      `${RECEIPT} Confirmed[.\\s]*${MONEY} transferred (?:to|from) M-Shwari account on (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) at ([\\d:]+ ?[AP]?M?)`,
      'i'
    ),
    map: (m, raw) => ({
      counterparty: 'M-Shwari',
      date: parseDateTime(m[3], m[4]),
      direction: /transferred from M-Shwari/i.test(raw) ? 'In' : 'Out',
    }),
  },
];

// Fuliza and reversals don't carry the standard shape; handled separately.
const FULIZA_RE = new RegExp(`${RECEIPT} Confirmed[.\\s]*Fuliza M-PESA amount is ${MONEY}`, 'i');

/**
 * @param {string} raw one or more M-PESA SMS messages
 * @returns {{transactions: object[], unparsed: string[]}}
 */
export function parseMessages(raw) {
  const transactions = [];
  const unparsed = [];

  for (const block of splitMessages(raw)) {
    const txns = parseOne(block);
    if (txns.length) transactions.push(...txns);
    else unparsed.push(block);
  }
  return { transactions, unparsed };
}

// Messages get pasted run-together. A receipt code followed by "Confirmed" reliably
// marks the start of a new one, so split there rather than on newlines.
function splitMessages(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
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

function parseOne(block) {
  const out = [];

  for (const p of PATTERNS) {
    const m = block.match(p.re);
    if (!m) continue;

    const extra = p.map(m, block);
    const amount = money(m[p.amountAt ?? 2]);
    const receipt = m[1].toUpperCase();

    out.push({
      id: receipt,
      receipt,
      date: extra.date,
      amount,
      direction: extra.direction || p.direction,
      type: p.type,
      counterparty: extra.counterparty,
      account: extra.account || null,
      balance: matchBalance(block),
      source: 'sms',
      raw: block,
    });

    // The transaction cost is a real, separate outflow. M-PESA reports it inside the
    // parent message, so it shares the receipt code — suffix it to keep ids unique.
    const cost = block.match(new RegExp(`Transaction cost,?\\s*${MONEY}`, 'i'));
    if (cost && money(cost[1]) > 0) {
      out.push({
        id: `${receipt}-COST`,
        receipt,
        date: extra.date,
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
      id: `${f[1].toUpperCase()}-FULIZA`,
      receipt: f[1].toUpperCase(),
      date: anchor ? anchor.date : null,
      amount: money(f[2]),
      direction: 'Out',
      type: 'Fuliza',
      counterparty: 'Fuliza M-PESA',
      account: null,
      balance: null,
      source: 'sms',
      raw: block,
    });
  }

  return out;
}

function matchBalance(block) {
  const b = block.match(new RegExp(`New M-PESA balance is ${MONEY}`, 'i'));
  return b ? money(b[1]) : null;
}

export const _internals = { splitMessages, parseDateTime, parseOne };
