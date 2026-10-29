// Putting names to the bank's bare phone numbers.
//
// The bank writes "IBKG MPESA PAY TO 2547XXXXXXXX" — a full number, no name. M-PESA
// writes "254727***052 JANE DOE" — a name, but a masked number. Neither is usable
// alone: the bank row is unidentifiable, and a name rule for that person silently
// misses everything you paid them from the bank.
//
// Together they resolve: the mask hides the middle digits, so a full number matches
// a mask when the visible prefix and suffix line up and the lengths agree.

/** 07… and 2547… are the same line. Compare on one form. */
const norm = (n) => String(n || '').replace(/^\+/, '').replace(/^0/, '254');

const MASK_RE = /^([\d]*)\*+([\d]+)\s+(.+)$/;

/** Every masked number → name pairing the M-PESA data knows about. */
export function buildMaskIndex(transactions) {
  const index = [];
  const seen = new Set();
  for (const t of transactions) {
    if ((t.accountSource || 'mpesa') !== 'mpesa') continue;
    const cp = String(t.counterparty || '');
    if (seen.has(cp)) continue;
    seen.add(cp);
    const m = cp.match(MASK_RE);
    if (!m) continue;
    const stars = (cp.match(/\*+/) || [''])[0].length;
    index.push({ pre: norm(m[1]), hidden: stars, suf: m[2], name: m[3].trim() });
  }
  return index;
}

/**
 * @returns {string|null} the name, or null if nothing matches — or if more than one
 *   *different* name does. An ambiguous match is worse than none: it would quietly
 *   attribute someone's money to the wrong person.
 */
export function resolveNumber(fullNumber, index) {
  const f = norm(fullNumber);
  if (!/^\d{9,15}$/.test(f)) return null;

  const hits = index.filter(
    (e) => f.startsWith(e.pre) && f.endsWith(e.suf) && f.length === e.pre.length + e.hidden + e.suf.length
  );
  if (!hits.length) return null;

  const names = new Set(hits.map((h) => h.name.toLowerCase()));
  if (names.size > 1) return null; // two different people fit the same mask
  return hits[0].name;
}

/**
 * Names the bare-number counterparties in place, using the masks the M-PESA data
 * supplies. Returns how many were resolved.
 *
 * Rewrites `counterparty` to "<number> <NAME>" — the shape personName() and the name
 * rules already understand — so one rule then covers both accounts. `raw` still holds
 * the untouched statement text.
 */
export function nameBareNumbers(transactions) {
  const index = buildMaskIndex(transactions);
  if (!index.length) return 0;

  let resolved = 0;
  for (const t of transactions) {
    // Any bank, not one specific one — they all name people by bare number.
    if ((t.accountSource || 'mpesa') === 'mpesa') continue;
    const cp = String(t.counterparty || '').trim();
    if (!/^\d{9,15}$/.test(cp)) continue; // already named, or not a number at all
    const name = resolveNumber(cp, index);
    if (!name) continue;
    t.counterparty = `${cp} ${name}`;
    resolved++;
  }
  return resolved;
}
