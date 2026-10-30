// Aggregation + chart rendering. Charts are hand-rolled SVG — no chart library, so
// the app stays dependency-free and works offline.

import { CATEGORIES, CLASSES, classOf, categoryParts } from './rules.js';
import { ACCOUNT_LABELS } from './import.js';

const KES = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });
const fmt = (n) => KES.format(Math.round(n));

// Single-hue ramp, ordered by spend. This is an *ordinal* ramp (discrete ranked
// categories), not a continuous sequential one, so every step must stay visible
// against the surface — the step nearest the surface still clears 2:1.
//
// The hue is the app's own: amber on black, indigo on white. It was blue, from
// when this page had a palette of its own, and a column of blue bars was the
// last thing still announcing that the tracker and Basket used to be two
// different apps. Safe to re-hue because an ordinal ramp carries its meaning in
// LIGHTNESS, which is ordered here and reads the same to everyone; the one thing
// that must never be re-picked by eye is a categorical set, and there isn't one.
const RAMP_LIGHT = ['#b0a8e8', '#9f96e0', '#8e84d8', '#7d71d0', '#6c5fc6', '#5c4fba', '#4f42a9', '#443896', '#3a2f82', '#2f266b'];
const RAMP_DARK = ['#8a5a00', '#a06800', '#b77700', '#cf8700', '#e69600', '#ff9f0a', '#ffb13a', '#ffc264', '#ffd28d', '#ffe3b8'];

const isDark = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

const ramp = () => (isDark() ? RAMP_DARK : RAMP_LIGHT);

// Rank → color. Biggest spender darkest (light mode) so weight reads as ink.
export function rampAt(rank, total) {
  const r = ramp();
  if (total <= 1) return r[Math.floor(r.length / 2)];
  const t = rank / (total - 1);
  return r[Math.round((1 - t) * (r.length - 1))];
}

export function summarise(txns) {
  let spending = 0;
  let fees = 0;
  let income = 0;
  let transfers = 0;

  for (const t of txns.flatMap(categoryParts)) {
    const cls = classOf(t.category);
    // A refund linked to a spend reduces that spend. It is not income — it's money
    // you'd already parted with coming back — and counting it as earnings would
    // overstate both sides of the ledger at once.
    if (t.isOffset) {
      if (cls === CLASSES.FEE) fees -= t.amount;
      else spending -= t.amount;
      continue;
    }
    // Class is checked before direction, deliberately. A loan disbursement or an
    // overdraft credit arrives as money IN, but borrowing is not earning; letting
    // direction decide would book every Fuliza advance as income.
    if (cls === CLASSES.FEE) fees += t.amount;
    else if (cls === CLASSES.TRANSFER) transfers += t.amount;
    else if (cls === CLASSES.INCOME || t.direction === 'In') income += t.amount;
    else spending += t.amount;
  }
  return { spending, fees, income, transfers, realSpend: spending + fees, net: income - (spending + fees) };
}

export function byCategory(txns, cls) {
  const m = new Map();
  for (const t of txns.flatMap(categoryParts)) {
    // Inbound money is skipped — except a refund linked to a spend, which subtracts
    // from the category it paid back.
    if (t.direction === 'In' && !t.isOffset) continue;
    const c = classOf(t.category);
    if (cls && c !== cls) continue;
    if (!cls && (c === CLASSES.INCOME || c === CLASSES.TRANSFER)) continue;
    const cur = m.get(t.category) || { category: t.category, total: 0, count: 0 };
    if (t.isOffset) {
      cur.total -= t.amount; // it isn't another purchase, so the count doesn't move
    } else {
      cur.total += t.amount;
      cur.count++;
    }
    m.set(t.category, cur);
  }
  return [...m.values()].filter((r) => r.count > 0).sort((a, b) => b.total - a.total);
}

export function byMerchant(txns, limit = 12) {
  const m = new Map();
  for (const t of txns) {
    if (t.direction === 'In') continue;
    const key = t.counterparty || '(unknown)';
    const cur = m.get(key) || { name: key, total: 0, count: 0, category: t.category };
    cur.total += t.amount;
    cur.count++;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

// Group by day for short ranges, by month once the history is long enough that
// daily bars would be unreadable.
export function overTime(txns) {
  const dates = txns.map((t) => t.date).filter(Boolean).sort();
  if (!dates.length) return { buckets: [], grain: 'day' };
  const span = (new Date(dates.at(-1)) - new Date(dates[0])) / 86400000;
  const grain = span > 62 ? 'month' : 'day';

  const m = new Map();
  for (const t of txns.flatMap(categoryParts)) {
    if (!t.date || t.direction === 'In') continue;
    const cls = classOf(t.category);
    if (cls === CLASSES.TRANSFER || cls === CLASSES.INCOME) continue;
    const key = grain === 'month' ? t.date.slice(0, 7) : t.date.slice(0, 10);
    m.set(key, (m.get(key) || 0) + t.amount);
  }
  const buckets = [...m.entries()].map(([key, total]) => ({ key, total })).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { buckets, grain };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Horizontal bars — long category names need the room. */
export function renderCategoryBars(el, rows, slotOf = null) {
  if (!rows.length) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.total));
  el.innerHTML = rows
    .map((r, i) => {
      const pct = (r.total / max) * 100;
      return `<div class="bar-row drill" tabindex="0" role="listitem" data-drill-cat="${esc(r.category)}"
                   title="Show these transactions"
                   aria-label="${esc(r.category)}: ${fmt(r.total)} shillings across ${r.count} transactions. Activate to see them.">
          <div class="bar-label">${esc(r.category)}</div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${pct}%;background:${
              slotOf ? seriesColour(slotOf(r.category)) : rampAt(i, rows.length)
            }"></div>
          </div>
          <div class="bar-value">${fmt(r.total)}<span class="bar-count">${r.count}×</span></div>
        </div>`;
    })
    .join('');
}

/** Single-series columns over time, with a hover tooltip. */
export function renderTrend(el, buckets, grain) {
  if (buckets.length < 1) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }
  const W = 720;
  const H = 200;
  const PAD = { t: 12, r: 12, b: 28, l: 52 };
  const max = Math.max(...buckets.map((b) => b.total)) || 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const bw = Math.min(48, (iw / buckets.length) * 0.68);
  const step = iw / buckets.length;
  const hue = isDark() ? '#ff9f0a' : '#4b3fbf';

  const ticks = [0, max / 2, max].map((v) => {
    const y = PAD.t + ih - (v / max) * ih;
    return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/>
            <text class="tick" x="${PAD.l - 8}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`;
  });

  const bars = buckets.map((b, i) => {
    const h = Math.max(2, (b.total / max) * ih);
    const x = PAD.l + i * step + (step - bw) / 2;
    const y = PAD.t + ih - h;
    const label = grain === 'month' ? monthLabel(b.key) : b.key.slice(8) + '/' + b.key.slice(5, 7);
    return `<g class="col" tabindex="0" role="listitem" aria-label="${esc(label)}: ${fmt(b.total)} shillings">
        <title>${esc(label)} — KES ${fmt(b.total)}</title>
        <rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${hue}"/>
        <text class="tick" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>
      </g>`;
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="list" aria-label="Spending over time">
      ${ticks.join('')}
      <line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${PAD.t + ih}" y2="${PAD.t + ih}"/>
      ${bars.join('')}
    </svg>`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en', { month: 'short' }) + ' ' + y.slice(2);
}

/** The bank<->M-PESA pairing report. Only meaningful once both accounts are loaded. */
export function renderReconcile(el, r) {
  const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', yy: '2-digit' });

  if (!r.checked) {
    el.innerHTML = `<p class="empty">The two statements don't overlap in time, so there is nothing to cross-check.
      Import a bank statement and an M-PESA statement covering the same period.</p>`;
    return;
  }

  const value = r.matched.reduce((a, x) => a + x.bank.amount, 0);
  const total = r.matched.length + r.unmatchedBank.length;
  const allMatched = r.unmatchedBank.length === 0;

  el.innerHTML = `
    <div class="recon-head">
      <div class="recon-stat">
        <span class="kpi-label">Matched pairs</span>
        <span class="kpi-value">${r.matched.length}<span class="dim" style="font-size:14px">/${total}</span></span>
        <span class="kpi-note">${fmt(value)} counted once</span>
      </div>
      <div class="recon-stat">
        <span class="kpi-label">Checked period</span>
        <span class="kpi-value" style="font-size:15px">${day(r.window.from)} – ${day(r.window.to)}</span>
        <span class="kpi-note">where both statements overlap</span>
      </div>
      <div class="recon-stat">
        <span class="kpi-label">Outside that period</span>
        <span class="kpi-value">${r.outsideWindow}</span>
        <span class="kpi-note">no counterpart to check against</span>
      </div>
    </div>
    ${
      allMatched
        ? `<p class="recon-ok">✓ Every bank↔M-PESA movement in the overlapping period was matched to its other half.</p>`
        : `<p class="recon-warn"><strong>${r.unmatchedBank.length} bank movement(s) had no M-PESA counterpart.</strong>
             A transfer between two of your own bank accounts belongs here — it has no M-PESA side. Anything else is worth a look:</p>
           <ul class="recon-list">${r.unmatchedBank
             .map((x) => `<li>${x.date.slice(0, 10)} · ${fmt(x.amount)} · ${esc(x.counterparty)}</li>`)
             .join('')}</ul>`
    }
    <details class="recon-details">
      <summary>Show the ${r.matched.length} matched pairs</summary>
      <table class="mini">
        <thead><tr><th>Date</th><th class="num">Amount</th><th>Bank side</th><th>M-PESA side</th><th class="num">Gap</th></tr></thead>
        <tbody>${r.matched
          .map(
            (x) => `<tr>
            <td class="dim nowrap">${x.bank.date.slice(0, 10)}</td>
            <td class="num">${fmt(x.bank.amount)}</td>
            <td>${esc(x.bank.counterparty)}</td>
            <td class="dim">${esc(String(x.mpesa.counterparty).slice(0, 46))}</td>
            <td class="num dim">${x.gapHours}h</td>
          </tr>`
          )
          .join('')}</tbody>
      </table>
    </details>`;
}

/** Balance line over time, with a hover crosshair. */
export function renderBalance(el, series, label) {
  if (series.length < 2) {
    el.innerHTML = '<p class="empty">Not enough balance history to chart.</p>';
    return;
  }
  const W = 720;
  const H = 190;
  const PAD = { t: 12, r: 14, b: 26, l: 58 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const vals = series.map((p) => p.balance);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const x = (i) => PAD.l + (i / (series.length - 1)) * iw;
  const y = (v) => PAD.t + ih - ((v - min) / (max - min || 1)) * ih;
  const hue = isDark() ? '#ff9f0a' : '#4b3fbf';

  const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const area = `${d} L${x(series.length - 1).toFixed(1)},${y(min)} L${x(0).toFixed(1)},${y(min)} Z`;

  const ticks = [min, (min + max) / 2, max].map((v) => {
    const yy = y(v);
    return `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${yy}" y2="${yy}"/>
            <text class="tick" x="${PAD.l - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
  });

  // Month boundaries give the eye something to hang the timeline on.
  const marks = [];
  let lastMonth = null;
  series.forEach((p, i) => {
    const m = p.day.slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      if (i > 0)
        marks.push(
          `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${new Date(p.day + 'T00:00Z').toLocaleDateString('en-GB', { month: 'short' })}</text>`
        );
    }
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} balance over time">
      ${ticks.join('')}
      <path d="${area}" fill="${hue}" opacity="0.10"/>
      <path d="${d}" fill="none" stroke="${hue}" stroke-width="2" stroke-linejoin="round"/>
      ${marks.join('')}
      <g class="bal-hover"></g>
    </svg>
    <div class="bal-read"><span class="dim">Hover the line for a day</span></div>`;

  const svg = el.querySelector('svg');
  const read = el.querySelector('.bal-read');
  const hover = el.querySelector('.bal-hover');
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - PAD.l) / iw) * (series.length - 1));
    const p = series[Math.max(0, Math.min(series.length - 1, i))];
    if (!p) return;
    hover.innerHTML = `<line class="grid" x1="${x(series.indexOf(p))}" x2="${x(series.indexOf(p))}" y1="${PAD.t}" y2="${PAD.t + ih}" stroke="${hue}"/>
      <circle cx="${x(series.indexOf(p))}" cy="${y(p.balance)}" r="4" fill="${hue}" stroke="var(--surface-1)" stroke-width="2"/>`;
    read.innerHTML = `<strong>${fmt(p.balance)}</strong> <span class="dim">on ${new Date(p.day + 'T00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}</span>`;
  });
  svg.addEventListener('mouseleave', () => {
    hover.innerHTML = '';
    read.innerHTML = '<span class="dim">Hover the line for a day</span>';
  });
}

export function renderMerchants(el, rows) {
  if (!rows.length) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }
  el.innerHTML = `<table class="mini">
      <thead><tr><th>Merchant</th><th>Category</th><th class="num">Total</th><th class="num">Txns</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr class="drill" data-drill-name="${esc(r.name)}" tabindex="0" title="Show these transactions">
                 <td>${esc(r.name)}</td><td class="dim">${esc(r.category)}</td>
                 <td class="num">${fmt(r.total)}</td><td class="num dim">${r.count}</td></tr>`
        )
        .join('')}</tbody></table>`;
}

const COLS = [
  { key: 'date', label: 'Date' },
  { key: 'counterparty', label: 'Details' },
  { key: 'amount', label: 'Amount', cls: 'num' },
  { key: 'category', label: 'Category' },
];

export function renderTable(el, txns, onEdit, sort, onSort, totalBeforeFilters = null, onSplit = null, more = null) {
  if (!txns.length) {
    // An empty app and an over-narrow filter are different problems; telling someone
    // with no data to "clear the filters" sends them looking for a filter that isn't set.
    el.innerHTML =
      totalBeforeFilters === 0
        ? `<p class="empty">Nothing here yet. Import a statement PDF or paste M-PESA messages above.</p>`
        : `<p class="empty">No transactions match these filters.</p>`;
    return;
  }
  const opts = Object.keys(CATEGORIES);
  const head = COLS.map((c) => {
    const active = sort.key === c.key;
    // aria-sort so the sort state is exposed to screen readers, not just the arrow.
    const aria = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${c.cls || ''} sortable${active ? ' active' : ''}"
                aria-sort="${aria}" data-sort="${c.key}" tabindex="0"
                role="button">${c.label}${arrow}</th>`;
  }).join('');

  el.innerHTML = `<table class="txns">
      <thead><tr>${head}</tr></thead>
      <tbody>${txns
        .map((t) => {
          const d = t.date ? new Date(t.date) : null;
          const when = d ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
          return `<tr>
            <td class="dim nowrap">${when}</td>
            <td>
              <div class="cp">${esc(t.counterparty || '—')}</div>
              <div class="dim small">
                <span class="acct acct-${(t.accountSource || 'mpesa') === 'mpesa' ? 'mpesa' : 'bank'}">${esc(
                  ACCOUNT_LABELS[t.accountSource || 'mpesa'] || t.accountSource
                )}</span>
                ${esc(t.type)}${t.receipt ? ' · ' + esc(t.receipt) : ''}
              </div>
            </td>
            <td class="num ${t.direction === 'In' ? 'in' : ''}">${t.direction === 'In' ? '+' : '−'}${fmt(t.amount)}</td>
            <td>${
              t.isSplit
                ? `<div class="cat-split">
                     <button class="split-tag" data-split="${esc(t.id)}" title="Edit split">Split ✎</button>
                     <div class="dim small">${t.splits.map((p) => `${esc(p.category)} ${fmt(p.amount)}`).join(' · ')}</div>
                   </div>`
                : `<div class="cat-cell">
                     <select data-id="${esc(t.id)}" class="cat" title="Set by: ${esc(t.why || '—')}">
                       <option selected>${esc(t.category)}</option>
                     </select>${
                       onSplit && t.direction === 'Out'
                         ? `<button class="split-open" data-split="${esc(t.id)}" title="Split across categories">⑃</button>`
                         : ''
                     }
                   </div>`
            }</td>
          </tr>`;
        })
        .join('')}</tbody></table>`;

  // Fill a picker the first time it is touched. Both events, because a tap on a
  // phone and a keyboard tab are different ways in, and the list has to be there
  // before the native picker opens.
  const fill = (e) => {
    const sel = e.target.closest && e.target.closest('select.cat');
    if (!sel || sel.dataset.full) return;
    const current = sel.value;
    sel.innerHTML = opts.map((o) => `<option${o === current ? ' selected' : ''}>${esc(o)}</option>`).join('');
    sel.value = current;
    sel.dataset.full = '1';
  };
  el.addEventListener('pointerdown', fill, true);
  el.addEventListener('focusin', fill, true);

  el.querySelectorAll('select.cat').forEach((sel) => {
    sel.addEventListener('change', () => onEdit(sel.dataset.id, sel.value));
  });

  // Showing every transaction at once is thousands of rows nobody scrolls to, and
  // the cost is paid again on every re-render. The filters above are the way to
  // find something; this is the way to keep reading.
  if (more && more.shown < more.total) {
    const btn = document.createElement('button');
    btn.className = 'ghost more-rows';
    btn.type = 'button';
    btn.textContent = `Show more — ${more.shown} of ${more.total}`;
    btn.addEventListener('click', more.onMore);
    el.appendChild(btn);
  }

  if (onSplit) {
    el.querySelectorAll('button[data-split]').forEach((b) => {
      b.addEventListener('click', () => onSplit(b.dataset.split));
    });
  }

  el.querySelectorAll('th.sortable').forEach((th) => {
    const go = () => onSort(th.dataset.sort);
    th.addEventListener('click', go);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
}

/** Sort a decorated transaction list. Amounts sort numerically, everything else by text. */
export function sortTxns(txns, { key, dir }) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...txns].sort((a, b) => {
    let x = a[key];
    let y = b[key];
    if (key === 'amount') return (x - y) * mul;
    x = String(x ?? '').toLowerCase();
    y = String(y ?? '').toLowerCase();
    if (x === y) return 0;
    return (x < y ? -1 : 1) * mul;
  });
}

export { fmt };

/* ---- The ring ------------------------------------------------------------ */
//
// Where the money went, as a shape. The ranked bars underneath answer "how much
// on what" precisely; the ring answers "what is this month SHAPED like" at a
// glance - one category eating half of it reads instantly, which is the one
// thing a sorted list of numbers cannot show you.
//
// Eight colours, assigned per CATEGORY rather than per rank, so Groceries is the
// same colour next month even when it moves from second to fourth. A ninth
// category is never given a new hue: the tail folds into "Other", which is also
// the only honest thing to do with twenty slices too thin to see.

/** Validated categorical hues, in fixed order. See the data-viz palette. */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export const seriesColour = (slot) => (isDark() ? SERIES_DARK : SERIES_LIGHT)[slot % 8];

/** How many slices before the tail is folded away. */
export const DONUT_SLICES = 7;

/**
 * What the folded tail is called.
 *
 * Deliberately not "Other": that is a real category, and naming the fold after
 * one means a tap on it filters to that category instead of to the things it
 * actually folded up.
 */
export const REST_LABEL = 'Everything else';

/**
 * Rank the categories and fold the tail.
 *
 * @param {object[]} rows  byCategory output, biggest first
 * @returns {{category: string, total: number, count: number, rest?: string[]}[]}
 */
export function donutRows(rows) {
  if (rows.length <= DONUT_SLICES + 1) return rows;
  const head = rows.slice(0, DONUT_SLICES);
  const tail = rows.slice(DONUT_SLICES);
  return [
    ...head,
    {
      category: REST_LABEL,
      total: tail.reduce((a, r) => a + r.total, 0),
      count: tail.reduce((a, r) => a + r.count, 0),
      rest: tail.map((r) => r.category),
    },
  ];
}

/**
 * @param {Function} slotOf  category -> 0..7, stable across renders
 */
/** The folded row filters to everything it folded; a real one to itself. */
const drillAttr = (r) =>
  r.rest
    ? `data-drill-cats="${esc(r.rest.join('|'))}" data-drill-label="${esc(REST_LABEL)}"`
    : `data-drill-cat="${esc(r.category)}"`;

/**
 * @param {object}  o
 * @param {boolean} o.middle  false leaves the hole empty - the hero card puts
 *                            its own figure there, and two totals in one ring
 *                            is one too many.
 * @param {boolean} o.legend  false draws the ring alone.
 * @param {boolean} o.ring    false draws the legend alone - for a page that
 *                            is already carrying this ring further up.
 * @param {boolean} o.round   rounded ends, which is what makes the ring read
 *                            as ribbons rather than tiles. It costs accuracy
 *                            at the bottom: a cap is half the stroke wide at
 *                            each end, so no slice can draw thinner than the
 *                            stroke, and anything under about 5% reads the
 *                            same size. Only worth it where the exact figures
 *                            are written out directly underneath.
 */
/**
 * Fold the slices a rounded ring cannot draw honestly.
 *
 * A round cap hangs half a stroke past each end, so no slice can be drawn
 * thinner than the stroke itself. Seven thin categories therefore come back
 * as seven identical pills - equal-looking slices that are not equal - and
 * because each one is drawn shorter than the share it was given, the
 * leftovers pile up as blank sectors: a fifth of the ring showing nothing.
 *
 * So anything too thin to draw at its real size is not drawn at its real
 * size. It joins the fold that already exists for the long tail, under the
 * same label, and the exact figures stay in the tiles underneath.
 */
function foldThin(rows, minShare) {
  const total = rows.reduce((a, r) => a + r.total, 0);
  const thin = rows.filter((r) => r.total / total < minShare);
  // One thin slice is a slice. Two or more is the problem described above.
  if (thin.length < 2) return rows;
  const kept = rows.filter((r) => r.total / total >= minShare);
  const folded = {
    category: REST_LABEL,
    total: thin.reduce((a, r) => a + r.total, 0),
    count: thin.reduce((a, r) => a + r.count, 0),
    // Keep what it stands for, so tapping it still opens those transactions.
    rest: thin.flatMap((r) => r.rest || [r.category]),
  };
  return [...kept, folded];
}

export function renderDonut(
  el,
  rows,
  slotOf,
  { label = 'spent', middle = true, legend = true, ring = true, round = false } = {},
) {
  if (!rows.length || rows.reduce((a, r) => a + r.total, 0) <= 0) {
    el.innerHTML = '<p class="empty">Nothing to show yet.</p>';
    return;
  }

  const R = 52;
  const W = round ? 13 : 16;
  const C = 2 * Math.PI * R;
  // A 2px gap in the surface colour is what separates touching slices - never a
  // stroke around them, which would add ink that is not data. In this viewBox
  // 1.6 units lands at about 2px once the ring is drawn at its real size.
  // 1.6 units is about 2px on the ring as the standard look draws it. The
  // rounded ring is drawn half as big again and on a phone three times that,
  // where the same gap became a 17px trench between every slice - separation
  // you could see from across the room rather than a hairline. It is set from
  // what it has to look like at the size it is actually drawn.
  const GAP = rows.length > 1 ? (round ? 1.1 : 1.6) : 0;
  // A round cap hangs half a stroke past each end of the dash, so the dash has
  // to give that back or every slice grows by a stroke width.
  const CAP = round ? W : 0;
  // Which is also the smallest slice a rounded ring can tell the truth about.
  if (round) rows = foldThin(rows, (CAP + GAP) / C);
  const total = rows.reduce((a, r) => a + r.total, 0);

  let at = 0;
  const arcs = rows
    .map((r) => {
      const len = Math.max((r.total / total) * C - GAP - CAP, 0.6);
      const dash = `${len} ${C - len}`;
      const offset = -at;
      at += (r.total / total) * C;
      return `<circle class="ring-arc" cx="60" cy="60" r="${R}" fill="none"
                 stroke="${seriesColour(slotOf(r.category))}" stroke-width="${W}"
                 ${round ? 'stroke-linecap="round"' : ''}
                 stroke-dasharray="${dash}" stroke-dashoffset="${offset}"
                 ${drillAttr(r)}><title>${esc(r.category)}: ${fmt(r.total)}</title></circle>`;
    })
    .join('');

  const legendHtml = !legend ? '' : rows
    .map((r) => {
      const pct = Math.round((r.total / total) * 100);
      // The name is always written out: three of the light-mode hues sit under
      // 3:1 on white, so identity can never rest on the colour alone.
      return `<button type="button" class="leg" ${drillAttr(r)}
                 title="${r.rest ? esc(r.rest.join(', ')) : 'Show these transactions'}">
          <span class="leg-dot" style="background:${seriesColour(slotOf(r.category))}"></span>
          <span class="leg-text">
            <span class="leg-name">${esc(r.category)}</span>
            <span class="leg-sub">${pct}% · ${r.count}&times;</span>
          </span>
          <span class="leg-amt">${fmt(r.total)}</span>
        </button>`;
    })
    .join('');

  el.innerHTML = `
    ${!ring ? '' : `<div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" role="img" aria-label="Spending by category">
        <g transform="rotate(-90 60 60)">${arcs}</g>
      </svg>
      ${middle ? `<div class="ring-mid">
        <span class="ring-total">${fmt(total)}</span>
        <span class="ring-label">${esc(label)}</span>
      </div>` : ''}
    </div>`}
    ${legend ? `<div class="legend">${legendHtml}</div>` : ''}`;
}
