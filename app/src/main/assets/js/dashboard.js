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
export function renderCategoryBars(el, rows) {
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
            <div class="bar-fill" style="width:${pct}%;background:${rampAt(i, rows.length)}"></div>
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

export function renderTable(el, txns, onEdit, sort, onSort, totalBeforeFilters = null, onSplit = null) {
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
                       ${opts.map((o) => `<option${o === t.category ? ' selected' : ''}>${esc(o)}</option>`).join('')}
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

  el.querySelectorAll('select.cat').forEach((sel) => {
    sel.addEventListener('change', () => onEdit(sel.dataset.id, sel.value));
  });

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
