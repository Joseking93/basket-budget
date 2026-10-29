import { parseMessages, groupUnparsed } from './parser.js';
import {
  categorise,
  CLASSES,
  CATEGORIES,
  classOf,
  LENDER_RE,
  ONE_OFF_CATEGORIES,
  personName,
  registerCustomCategories,
  isBuiltInCategory,
} from './rules.js';
import * as store from './store.js';
import * as viz from './dashboard.js';
import { reconcileAccounts } from './reconcile.js';
import { computePayable } from './payables.js';
import { monthsIn, monthLabel, compareMonths, biggestDriver, nextMonth } from './monthly.js';
import { salaryRuns, monthResolver, payCycles } from './salary.js';
import { balanceSeries, lowDays, fulizaReport } from './balance.js';
import { findRecurring, committedMonthly } from './recurring.js';
import { budgetReport } from './budgets.js';
import * as basket from './basket.js';
import { ACCOUNT_LABELS } from './import.js';
import { isConfigured, norm as normNumber } from './config.js';

const rampFor = (i, n) => viz.rampAt(i, n);

const $ = (s) => document.querySelector(s);
const state = {
  range: 'all',
  search: '',
  catFilter: 'all',
  dirFilter: 'all',
  acctFilter: 'all',
  showSettled: false,
  month: null,
  // Which budget line / category the "Track a budget line" panel is following.
  track: null,
  drillMonth: null,
  balAcct: null,
  sort: { key: 'date', dir: 'desc' },
};

// Categories are derived on read, never baked into the stored transaction — so
// editing a rule instantly recategorises history instead of only new imports.
const WHY = {
  user: 'an exact rule for this counterparty',
  name: 'a name rule',
  rule: 'a built-in rule',
  'small-send': `a small send (${'≤'}200 to a person is treated as groceries)`,
  fallback: 'nothing — it needs categorising',
};

function decorate(txns) {
  const { userRules, nameRules, overrides, refundLinks } = store.getState();
  const byId = new Map(txns.map((t) => [t.id, t]));

  const base = txns.map((t) => {
    // A split is one movement assigned across several categories. It outranks both an
    // override and the rules: the parts drive every total (via categoryParts). The
    // row's own `category` is set to the biggest slice purely so labels and filters
    // have a real category to show — the truth is in `splits`.
    // Whole-transaction budget month (used for un-split payments pulled into another
    // month). For a split, each slice carries its own month; this is the fallback.
    const budgetMonth = store.budgetMonthFor(t.id);
    const splits = store.splitFor(t.id);
    if (splits && splits.length) {
      const primary = splits.reduce((a, b) => (b.amount > a.amount ? b : a));
      return { ...t, category: primary.category, splits, isSplit: true, budgetMonth, why: `split: ${splits.map((p) => p.category).join(' + ')}` };
    }
    // Carry WHY the category was chosen, not just what. When a category looks wrong
    // the only useful question is which rule decided it, and that used to be
    // unanswerable from the UI.
    if (overrides[t.id]) return { ...t, category: overrides[t.id], budgetMonth, why: 'set by hand on this row' };
    const c = categorise(t, userRules, nameRules);
    const detail =
      c.source === 'name'
        ? `name rule “${(specificMatch(t, nameRules) || {}).match || ''}”`
        : WHY[c.source] || c.source;
    return { ...t, category: c.category, budgetMonth, why: detail };
  });

  // A refund pointed at a spend takes that spend's category and nets against it —
  // so a 3,000 fee refunded 2,500 reads as 500, which is what it cost.
  const decorated = new Map(base.map((t) => [t.id, t]));
  for (const [refundId, spendId] of Object.entries(refundLinks || {})) {
    const r = decorated.get(refundId);
    const s = decorated.get(spendId);
    if (!r || !s) continue; // one of them isn't loaded; leave the refund as it was
    r.category = s.category;
    r.isOffset = true;
    r.offsets = { id: s.id, counterparty: s.counterparty, amount: s.amount, date: s.date };
    r.why = `offsets ${s.counterparty} (${viz.fmt(s.amount)})`;
    s.offsetBy = (s.offsetBy || 0) + r.amount;
  }
  return [...decorated.values()];
}

// Which name rule actually won, for the explanation.
function specificMatch(txn, nameRules) {
  const hay = `${txn.counterparty || ''} ${txn.account || ''}`.toLowerCase();
  return [...nameRules]
    .sort((a, b) => (b.match || '').length - (a.match || '').length)
    .find((r) => r.match && hay.includes(r.match.toLowerCase()));
}

function inRange(txns) {
  if (state.range === 'all') return txns;
  const days = parseInt(state.range, 10);
  const cutoff = Date.now() - days * 86400000;
  return txns.filter((t) => t.date && new Date(t.date).getTime() >= cutoff);
}

function render() {
  const all = decorate(store.allTransactions());
  const txns = inRange(all);

  const s = viz.summarise(txns);
  $('#kpi-spend').textContent = viz.fmt(s.realSpend);
  $('#kpi-income').textContent = viz.fmt(s.income);
  $('#kpi-fees').textContent = viz.fmt(s.fees);
  $('#kpi-transfers').textContent = viz.fmt(s.transfers);
  $('#kpi-count').textContent = txns.length;

  const net = s.income - s.realSpend;
  const netEl = $('#kpi-net');
  netEl.textContent = (net < 0 ? '−' : '+') + viz.fmt(Math.abs(net));
  netEl.classList.toggle('neg', net < 0);

  viz.renderCategoryBars($('#chart-categories'), viz.byCategory(txns));
  wireDrill($('#chart-categories'));
  const t = viz.overTime(txns);
  viz.renderTrend($('#chart-trend'), t.buckets, t.grain);
  viz.renderMerchants($('#table-merchants'), viz.byMerchant(txns));
  wireDrill($('#table-merchants'));
  renderHome(all);
  renderMonthly(all);
  renderRefunds(all);
  renderBudget(all);
  renderTrack(all);
  renderRecurring(all);
  renderBalance(all);
  renderFuliza(all);

  refreshCategoryFilter(txns);
  refreshAccountFilter(txns);
  // Debts read the whole ledger, not the selected range: what you owe doesn't
  // change because you're looking at last month.
  renderDebts(all);
  renderTriage(txns);

  // Cross-account check. Only shown once both accounts are actually present —
  // otherwise there is nothing to reconcile and the panel would be noise.
  const hasBoth =
    all.some((t) => (t.accountSource || 'mpesa') !== 'mpesa') && all.some((t) => (t.accountSource || 'mpesa') === 'mpesa');
  $('#recon-card').hidden = !hasBoth;
  if (hasBoth) {
    const r = reconcileAccounts(all);
    viz.renderReconcile($('#recon'), r);
    // An unmatched movement is the thing you'd want to know about without opening it.
    setBadge(
      '#recon-badge',
      r.checked ? `${r.matched.length} matched${r.unmatchedBank.length ? ` · ${r.unmatchedBank.length} unmatched` : ''}` : '',
      r.checked && r.unmatchedBank.length > 0
    );
  }

  const debt = viz.byCategory(txns, CLASSES.TRANSFER);
  $('#transfers-note').textContent = debt.length
    ? `Excluded from "spent": ${debt.map((d) => `${d.category} ${viz.fmt(d.total)}`).join(' · ')}`
    : '';

  // The charts always show the whole range; only the table below is filtered, so
  // narrowing to one person never silently rewrites the totals above.
  const rows = viz.sortTxns(applyFilters(txns), state.sort);
  const filtered = rows.length !== txns.length;
  $('#filter-count').textContent = filtered ? `${rows.length} of ${txns.length}` : `${txns.length} transactions`;
  setBadge('#txn-badge', filtered ? `${rows.length} of ${txns.length}` : `${txns.length}`);

  // A drill-down must be obviously undoable, or it looks like the app lost your data.
  const chip = $('#drill-chip');
  const bits = [];
  if (state.drillMonth) bits.push(monthLabel(state.drillMonth));
  if (state.catFilter !== 'all') bits.push(state.catFilter);
  if (state.search) bits.push(`“${state.search}”`);
  if (state.dirFilter !== 'all') bits.push(state.dirFilter === 'Out' ? 'out only' : 'in only');
  if (state.acctFilter !== 'all') bits.push(state.acctFilter === 'bank' ? 'bank' : 'M-PESA');
  chip.hidden = bits.length === 0;
  if (bits.length) chip.innerHTML = `<span>${bits.map(escapeHtml).join(' · ')}</span><button id="drill-clear">Clear</button>`;
  if (bits.length)
    $('#drill-clear').addEventListener('click', () => {
      state.drillMonth = null;
      state.catFilter = 'all';
      state.search = '';
      state.dirFilter = 'all';
      state.acctFilter = 'all';
      $('#search').value = '';
      render();
    });

  viz.renderTable(
    $('#table-txns'),
    rows,
    (id, cat) => {
      // A pass-through or an internal transfer is true of this payment only — making
      // it a rule for the sender would misfile everything they send you afterwards.
      const oneOff = ONE_OFF_CATEGORIES.has(cat);
      const { applied, name } = store.setCategory(id, cat, !oneOff, personName);
      render();
      renderNameRules();
      toast(
        name
          ? `“${name}” → ${cat}. ${applied} transaction${applied === 1 ? '' : 's'} follow, past and future.`
          : oneOff
            ? `${cat} — this transaction only, no rule made.`
            : `Recategorised.`
      );
    },
    state.sort,
    (key) => {
      // Same column toggles direction; a new column starts descending, which is
      // what you want for amounts and dates alike.
      state.sort =
        state.sort.key === key
          ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: 'desc' };
      render();
    },
    all.length,
    (id) => openSplitEditor(all.find((t) => t.id === id))
  );
}

// Split one transaction across categories — one movement, several intents (one send
// covering both the househelp and the shopping). A small modal, because the parts have to
// reconcile to the transaction's amount before it can be saved.
function openSplitEditor(txn) {
  if (!txn) return;
  const cats = Object.keys(CATEGORIES);
  const existing = store.splitFor(txn.id);
  // Seed with the current split, or a two-part start: the whole amount on its current
  // category, plus an empty second part to move some of it into.
  let parts = existing
    ? existing.map((p) => ({ ...p }))
    : [
        { category: txn.category, amount: txn.amount },
        { category: cats.find((c) => c !== txn.category) || 'Groceries', amount: 0 },
      ];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const close = () => overlay.remove();
  const catOptions = (sel) => cats.map((c) => `<option${c === sel ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  const remainderText = (rem) => (rem >= 0 ? `${viz.fmt(rem)} left to assign` : `${viz.fmt(-rem)} over`);

  const draw = () => {
    const sum = parts.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    const remaining = Math.round((txn.amount - sum) * 100) / 100;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Split transaction">
        <h3>Split this transaction</h3>
        <p class="dim small">${escapeHtml(String(txn.counterparty || '—'))} · ${viz.fmt(txn.amount)} · ${shortDate(txn.date)}</p>
        <div class="split-parts">
          ${parts
            .map(
              (p, i) => `<div class="split-part">
                <select class="split-cat" data-i="${i}" aria-label="Category for part ${i + 1}">${catOptions(p.category)}</select>
                <input class="split-amt" data-i="${i}" type="number" min="0" step="100" value="${p.amount}" aria-label="Amount for part ${i + 1}">
                ${parts.length > 2 ? `<button class="link-btn" data-rm="${i}" title="Remove part">✕</button>` : '<span class="split-rm-spacer"></span>'}
              </div>`
            )
            .join('')}
        </div>
        <div class="split-foot">
          <button type="button" class="ghost" id="split-add">+ Add part</button>
          <span class="split-rem ${Math.abs(remaining) > 1 ? 'neg' : 'pos'}">${remainderText(remaining)}</span>
        </div>
        <div class="modal-actions">
          ${existing ? '<button type="button" class="ghost" id="split-remove">Remove split</button>' : ''}
          <button type="button" class="ghost" id="split-cancel">Cancel</button>
          <button type="button" id="split-save">Save split</button>
        </div>
      </div>`;

    overlay.querySelectorAll('.split-cat').forEach((s) =>
      s.addEventListener('change', () => {
        parts[+s.dataset.i].category = s.value;
      })
    );
    overlay.querySelectorAll('.split-amt').forEach((inp) =>
      inp.addEventListener('input', () => {
        parts[+inp.dataset.i].amount = Number(inp.value) || 0;
        const rem = Math.round((txn.amount - parts.reduce((a, p) => a + (Number(p.amount) || 0), 0)) * 100) / 100;
        const el = overlay.querySelector('.split-rem');
        el.textContent = remainderText(rem);
        el.classList.toggle('neg', Math.abs(rem) > 1);
        el.classList.toggle('pos', Math.abs(rem) <= 1);
      })
    );
    overlay.querySelectorAll('[data-rm]').forEach((b) =>
      b.addEventListener('click', () => {
        parts.splice(+b.dataset.rm, 1);
        draw();
      })
    );
    overlay.querySelector('#split-add').addEventListener('click', () => {
      const rem = Math.round((txn.amount - parts.reduce((a, p) => a + (Number(p.amount) || 0), 0)) * 100) / 100;
      parts.push({ category: cats[0], amount: Math.max(0, rem) });
      draw();
    });
    overlay.querySelector('#split-cancel').addEventListener('click', close);
    const rm = overlay.querySelector('#split-remove');
    if (rm)
      rm.addEventListener('click', () => {
        store.clearSplit(txn.id);
        close();
        render();
        toast('Split removed.');
      });
    overlay.querySelector('#split-save').addEventListener('click', () => {
      const res = store.setSplit(txn.id, parts);
      if (!res.ok) {
        toast(res.error);
        return;
      }
      close();
      render();
      toast('Split saved.');
    });
  };

  draw();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onEsc);
    }
  });
  document.body.appendChild(overlay);
}

// Say which month a pay funds. Salary lands through TerraPay in several chunks, so the
// picker offers whole pay RUNS — assigning one moves every chunk together, which is the
// only way it makes sense: they're one payment that M-PESA had to split up.
function openPayAssign(month) {
  // Recomputed on every draw, not captured once: assigning a run changes where it
  // counts, and a stale snapshot would keep showing the month it used to fund.
  let all = [];
  let runs = [];
  const refresh = () => {
    all = decorate(store.allTransactions());
    runs = salaryRuns(all);
  };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };

  // Where a run currently counts. Asked through the SAME resolver the budget uses —
  // a local guess here (say, the month the last chunk landed in) would label a run
  // "funds June" while the budget was counting it in July.
  const runMonth = (run) => {
    const t = all.find((x) => x.id === run.ids[0]);
    return t ? monthResolver(all)(t) : (run.last || '').slice(0, 7);
  };

  const draw = () => {
    refresh();
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Assign a pay to a month">
        <h3>Which pay funds ${escapeHtml(monthLabel(month))}?</h3>
        <p class="dim small">Your salary arrives from TerraPay in chunks — M-PESA won't take it in one go — so each row below is one payday, chunks added up. Assigning it moves every chunk together. Statement dates don't change.</p>
        <div class="pick-list">${
          runs.length
            ? runs
                .map((r, i) => {
                  const here = runMonth(r) === month;
                  const span =
                    r.first.slice(0, 10) === r.last.slice(0, 10)
                      ? shortDate(r.last)
                      : `${shortDate(r.first)} – ${shortDate(r.last)}`;
                  return `<button type="button" class="pick-row${here ? ' is-linked' : ''}" data-run="${i}">
                    <span class="dim small">${span}</span>
                    <strong>${viz.fmt(r.total)}</strong>
                    <span class="ellip dim small">${r.count} chunk${r.count === 1 ? '' : 's'}</span>
                    <span class="dim small">${here ? '✓ funds this month' : `now: ${monthLabel(runMonth(r))}`}</span>
                  </button>`;
                })
                .join('')
            : '<p class="hint">No TerraPay salary found yet. Import a statement that covers a payday.</p>'
        }</div>
        <div class="modal-actions"><button type="button" class="ghost" id="pay-close">Close</button></div>
      </div>`;

    overlay.querySelectorAll('button[data-run]').forEach((b) =>
      b.addEventListener('click', () => {
        const run = runs[+b.dataset.run];
        const here = runMonth(run) === month;
        // Clicking the run that already funds this month releases it back to its own date.
        for (const id of run.ids) store.assignBudgetMonth(id, [], here ? null : month);
        toast(
          here
            ? `That pay goes back to ${monthLabel((run.last || '').slice(0, 7))}.`
            : `${viz.fmt(run.total)} now funds ${monthLabel(month)}.`
        );
        render();
        draw();
      })
    );
    overlay.querySelector('#pay-close').addEventListener('click', close);
  };

  draw();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

// Work FROM a budget line: pick a payment (from another month) and count it toward
// this line for the month on screen — an end-of-June househelp salary pulled into
// July. Only the slice that belongs to this line moves; the statement date stays put.
function openBudgetAssign(line, month) {
  const cats = new Set(line.categories);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onEsc);
  };

  const partsOf = (t) => (t.splits && t.splits.length ? t.splits.map((p) => p.category) : [t.category]);
  // Where a slice currently counts: its own month, else the whole-txn assignment, else date.
  const sliceMonth = (t, cat) => {
    const p = (t.splits || []).find((x) => x.category === cat);
    return (p && p.month) || t.budgetMonth || (t.date || '').slice(0, 7);
  };
  const lineAmount = (t, hits) =>
    t.splits && t.splits.length
      ? t.splits.filter((p) => hits.includes(p.category)).reduce((a, p) => a + p.amount, 0)
      : t.amount;

  let relevant = [];
  const recompute = () => {
    relevant = decorate(store.allTransactions())
      .filter((t) => t.direction === 'Out')
      .map((t) => ({ t, hits: partsOf(t).filter((c) => cats.has(c)) }))
      .filter((x) => x.hits.length);
  };

  let query = '';
  const row = ({ t, hits }, action) => `
    <button type="button" class="pick-row" data-${action}="${escapeHtml(t.id)}">
      <span class="dim small">${shortDate(t.date)}</span>
      <strong>${viz.fmt(lineAmount(t, hits))}</strong>
      <span class="ellip">${escapeHtml(String(t.counterparty || '—').slice(0, 26))}</span>
      <span class="dim small">${escapeHtml(hits.join(', '))}</span>
    </button>`;

  const updateList = () => {
    const q = query.trim().toLowerCase();
    const assigned = relevant.filter(
      ({ t, hits }) => hits.some((c) => sliceMonth(t, c) === month) && (t.date || '').slice(0, 7) !== month
    );
    const pool = relevant
      .filter(({ t, hits }) => hits.some((c) => sliceMonth(t, c) !== month))
      .filter(({ t }) => !q || `${t.counterparty || ''} ${t.receipt || ''} ${t.type || ''}`.toLowerCase().includes(q))
      .sort((a, b) => (a.t.date < b.t.date ? 1 : -1))
      .slice(0, 40);

    overlay.querySelector('.assign-here-box').innerHTML = assigned.length
      ? `<div class="dim small budget-outside-head">Pulled into ${escapeHtml(monthLabel(month))} — click to remove</div>${assigned
          .map((x) => row(x, 'unassign'))
          .join('')}`
      : '';
    overlay.querySelector('#assign-pool').innerHTML = pool.length
      ? pool.map((x) => row(x, 'assign')).join('')
      : '<p class="hint">No payments in other months belong to this line.</p>';

    overlay.querySelectorAll('button[data-assign]').forEach((b) =>
      b.addEventListener('click', () => {
        const res = store.assignBudgetMonth(b.dataset.assign, line.categories, month);
        if (!res.ok) return toast(res.error);
        toast(`Added to ${line.label} for ${monthLabel(month)}.`);
        render();
        recompute();
        updateList();
      })
    );
    overlay.querySelectorAll('button[data-unassign]').forEach((b) =>
      b.addEventListener('click', () => {
        store.assignBudgetMonth(b.dataset.unassign, line.categories, null);
        toast('Removed from this month.');
        render();
        recompute();
        updateList();
      })
    );
  };

  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Assign a payment to a budget line">
      <h3>Count a payment toward ${escapeHtml(line.label)}</h3>
      <p class="dim small">for ${escapeHtml(monthLabel(month))} — pick a payment from another month and it counts on this line, without moving its statement date.</p>
      <div class="assign-here-box"></div>
      <input type="search" class="pick-search" id="assign-search" placeholder="Search a payment to pull in…">
      <div class="pick-list" id="assign-pool"></div>
      <div class="modal-actions"><button type="button" class="ghost" id="assign-close">Close</button></div>
    </div>`;
  overlay.querySelector('#assign-search').addEventListener('input', (e) => {
    query = e.target.value;
    updateList();
  });
  overlay.querySelector('#assign-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onEsc);

  recompute();
  updateList();
  document.body.appendChild(overlay);
}

function renderRefunds(all) {
  // Anything the rules called a refund, plus anything already pointed at a spend.
  const refunds = all.filter((t) => t.direction === 'In' && (t.isOffset || t.category === 'Refunds'));
  const card = $('#refunds-card');
  card.hidden = refunds.length === 0;
  if (!refunds.length) return;

  refunds.sort((a, b) => (a.date < b.date ? 1 : -1));
  const linked = refunds.filter((t) => t.isOffset);
  const loose = refunds.filter((t) => !t.isOffset);
  const total = refunds.reduce((a, t) => a + t.amount, 0);
  setBadge('#refunds-badge', `${viz.fmt(total)} back${loose.length ? ` · ${loose.length} unlinked` : ''}`, loose.length > 0);

  $('#refunds').innerHTML = `
    <table class="mini">
      <thead><tr><th>Refund</th><th class="num">Amount</th><th>Offsets</th><th class="num">Net cost</th><th></th></tr></thead>
      <tbody>${refunds
        .map((t) => {
          const net = t.offsets ? t.offsets.amount - t.amount : null;
          return `<tr>
          <td>
            <strong>${escapeHtml(String(t.counterparty || '').slice(0, 30))}</strong>
            <div class="dim small">${shortDate(t.date)}${t.receipt ? ` · ${escapeHtml(t.receipt)}` : ''}</div>
          </td>
          <td class="num in">+${viz.fmt(t.amount)}</td>
          <td>${
            t.offsets
              ? `<span class="dim">${escapeHtml(String(t.offsets.counterparty).slice(0, 26))} · ${viz.fmt(t.offsets.amount)} on ${shortDate(t.offsets.date)}</span>`
              : `<button class="btn-quiet" data-off="${escapeHtml(t.id)}">Offset against…</button>`
          }</td>
          <td class="num ${net !== null ? (net > 0 ? '' : 'in') : 'dim'}">${net !== null ? viz.fmt(net) : '—'}</td>
          <td class="num">${
            t.offsets ? `<button class="link-btn" data-unoff="${escapeHtml(t.id)}" title="Unlink">✕</button>` : ''
          }</td>
        </tr>
        <tr class="off-picker-row" data-row="${escapeHtml(t.id)}" hidden><td colspan="5">
          <div class="pick-box" style="margin:0">
            <input type="search" class="pick-search" data-offsearch="${escapeHtml(t.id)}" placeholder="Search the payment this refunds…">
            <div class="pick-list" data-offlist="${escapeHtml(t.id)}"></div>
            <button type="button" class="ghost pick-close" data-offcancel="${escapeHtml(t.id)}">Close</button>
          </div>
        </td></tr>`;
        })
        .join('')}</tbody>
    </table>
    ${
      linked.length
        ? `<p class="hint note">${linked.length} refund(s) linked — those reduce their original category instead of counting as income.</p>`
        : ''
    }`;

  const drawOff = (id) => {
    const q = $(`input[data-offsearch="${CSS.escape(id)}"]`).value;
    const hits = store.offsetCandidates(id, { query: q });
    const box = $(`div[data-offlist="${CSS.escape(id)}"]`);
    box.innerHTML = hits.length
      ? hits
          .map(
            (t) => `<button type="button" class="pick-row" data-dolink="${escapeHtml(id)}|${escapeHtml(t.id)}">
        <span class="dim small">${shortDate(t.date)}</span>
        <strong>${viz.fmt(t.amount)}</strong>
        <span class="ellip">${escapeHtml(String(t.counterparty || '—').slice(0, 30))}</span>
        <span class="dim small">${escapeHtml(t.receipt || '')}</span>
      </button>`
          )
          .join('')
      : '<p class="hint">Nothing matches that search.</p>';

    box.querySelectorAll('button[data-dolink]').forEach((b) =>
      b.addEventListener('click', () => {
        const [rid, sid] = b.dataset.dolink.split('|');
        const res = store.linkRefund(rid, sid);
        if (!res.ok) {
          toast(res.error, 'warn');
          return;
        }
        render();
        const net = res.spend.amount - res.refund.amount;
        toast(`Linked. ${res.spend.counterparty} cost you ${viz.fmt(net)} after the refund.`);
      })
    );
  };

  $('#refunds')
    .querySelectorAll('button[data-off]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.off;
        const row = $(`tr[data-row="${CSS.escape(id)}"]`);
        const opening = row.hidden;
        $('#refunds')
          .querySelectorAll('.off-picker-row')
          .forEach((r) => (r.hidden = true));
        row.hidden = !opening;
        if (opening) {
          drawOff(id);
          row.querySelector('input').focus();
        }
      })
    );

  $('#refunds')
    .querySelectorAll('input[data-offsearch]')
    .forEach((inp) => {
      let t;
      inp.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => drawOff(inp.dataset.offsearch), 140);
      });
    });

  $('#refunds')
    .querySelectorAll('button[data-offcancel]')
    .forEach((b) => b.addEventListener('click', () => ($(`tr[data-row="${CSS.escape(b.dataset.offcancel)}"]`).hidden = true)));

  $('#refunds')
    .querySelectorAll('button[data-unoff]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        store.unlinkRefund(b.dataset.unoff);
        render();
        toast('Unlinked — it counts as money in again.');
      })
    );
}

function renderBudget(all) {
  const card = $('#budget-card');
  if (!state.month) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const { report, budgeted, spent, left, outside, outsideItems, funded, cycleStart } = budgetReport(
    store.budgets(),
    all,
    state.month
  );
  setBadge('#budget-badge', `${viz.fmt(spent)} of ${viz.fmt(budgeted)}`, spent > budgeted);

  $('#budget').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Spent against budget</span>
        <span class="kpi-value ${spent > budgeted ? 'neg' : ''}">${viz.fmt(spent)}</span>
        <span class="kpi-note">of ${viz.fmt(budgeted)} budgeted</span>
      </div>
      <div class="kpi"><span class="kpi-label">${left >= 0 ? 'Left' : 'Over'}</span><span class="kpi-value ${left < 0 ? 'neg' : 'pos'}">${viz.fmt(Math.abs(left))}</span></div>
      <div class="kpi"><span class="kpi-label">Outside any budget</span><span class="kpi-value">${viz.fmt(outside)}</span><span class="kpi-note">not covered by a line below</span></div>
      <div class="kpi">
        <span class="kpi-label">Pay funding this month</span>
        <span class="kpi-value ${funded > 0 ? 'pos' : ''}">${viz.fmt(funded)}</span>
        <span class="kpi-note"><button class="budget-assign" id="assign-pay">${
          funded > 0 ? 'change which pay' : '＋ assign a pay'
        }</button></span>
      </div>
    </div>
    ${
      cycleStart
        ? `<p class="hint note">This month runs from payday — <strong>${shortDate(cycleStart)}</strong> onward counts here, not from the 1st. Everything spent after that pay is spending this month's money.</p>`
        : ''
    }
    ${
      /* The arithmetic, stated. Two panels showing different totals for the same month
         reads as a bug even when both are right, so the tie-back to the monthly
         report's "spent" is spelled out rather than left to be worked out. */
      outside > 0
        ? `<p class="hint note"><strong>${viz.fmt(spent + outside)}</strong> went out this month: ${viz.fmt(spent)} on the lines below + ${viz.fmt(outside)} no line covers. That total is what the monthly report shows as spent.</p>`
        : ''
    }
    <table class="mini budget-table">
      <thead><tr><th>Line</th><th class="num">Budget</th><th class="num">Spent</th><th>Progress</th><th class="num">Left</th></tr></thead>
      <tbody>${report
        .map(
          (r) => `<tr>
        <td>
          <strong>${escapeHtml(r.label)}</strong>
          <div class="dim small">${
            r.unmapped
              ? '<span class="shadow">no category mapped — always 0</span>'
              : r.categories
                  .map(
                    (c) =>
                      `<span class="cat-chip" data-drill-cat="${escapeHtml(c)}" role="button" tabindex="0" title="Show ${escapeHtml(c)} transactions this month">${escapeHtml(c)}</span>`
                  )
                  .join(' ')
          }</div>
          ${
            r.unmapped
              ? ''
              : `<button class="budget-assign" data-assign="${r.id}" title="Count a payment from another month toward this line">＋ pull in a payment</button>`
          }
        </td>
        <td class="num"><input class="budget-input" type="number" min="0" step="500" value="${r.amount}" data-budget="${r.id}" aria-label="Budget for ${escapeHtml(r.label)}"></td>
        <td class="num ${r.over ? 'neg' : ''}">${viz.fmt(r.spent)}</td>
        <td class="debt-bar-cell">
          <div class="meter"><div class="meter-fill" style="width:${Math.min(100, r.pct * 100)}%;${
            r.over ? 'background:var(--critical)' : ''
          }"></div></div>
        </td>
        <td class="num ${r.left < 0 ? 'neg' : 'dim'}">${r.left < 0 ? '−' : ''}${viz.fmt(Math.abs(r.left))}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>
    ${
      outsideItems && outsideItems.length
        ? `<div class="budget-outside">
             <div class="dim small budget-outside-head">Spending not on any budget line — ${viz.fmt(outside)} total</div>
             <table class="mini">
               <tbody>${outsideItems
                 .map(
                   (o) => `<tr>
                     <td><span class="cat-chip" data-drill-cat="${escapeHtml(o.category)}" role="button" tabindex="0" title="Show ${escapeHtml(o.category)} transactions this month">${escapeHtml(o.category)}</span>${
                     o.category === 'Uncategorised'
                       ? ' <span class="shadow">— name these in People to place them</span>'
                       : !isBuiltInCategory(o.category)
                         ? ' <span class="shadow">— custom category, add it to a line above</span>'
                         : ''
                   }</td>
                     <td class="num">${viz.fmt(o.amount)}</td>
                   </tr>`
                 )
                 .join('')}</tbody>
             </table>
           </div>`
        : ''
    }`;

  $('#budget')
    .querySelectorAll('input[data-budget]')
    .forEach((i) =>
      i.addEventListener('change', () => {
        store.setBudget(i.dataset.budget, i.value);
        render();
        toast('Budget updated.');
      })
    );

  // Every budget category is a question you can follow: click it to see the
  // transactions behind it, for the month the budget is showing.
  wireDrill($('#budget'), state.month);

  const payBtn = $('#assign-pay');
  if (payBtn) payBtn.addEventListener('click', () => openPayAssign(state.month));

  // "Pull in a payment" — assign a spend from another month to this line's month.
  $('#budget')
    .querySelectorAll('button[data-assign]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const line = report.find((r) => r.id === b.dataset.assign);
        if (line) openBudgetAssign(line, state.month);
      })
    );
}

function renderRecurring(all) {
  const found = findRecurring(all);
  const card = $('#recurring-card');
  card.hidden = found.length === 0;
  if (!found.length) return;

  const committed = committedMonthly(found);
  const stale = found.filter((r) => r.stale);
  setBadge('#recurring-badge', `${viz.fmt(committed)}/mo committed`, false);

  $('#recurring').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Committed monthly</span>
        <span class="kpi-value">${viz.fmt(committed)}</span>
        <span class="kpi-note">across ${found.length - stale.length} live commitments</span>
      </div>
      ${
        stale.length
          ? `<div class="kpi"><span class="kpi-label">Lapsed</span><span class="kpi-value">${stale.length}</span><span class="kpi-note">overdue by more than a cycle</span></div>`
          : ''
      }
    </div>
    <table class="mini">
      <thead><tr><th>Payment</th><th class="num">Typical</th><th>Cadence</th><th class="num">Per month</th><th class="num">Last</th><th class="num">Next due</th></tr></thead>
      <tbody>${found
        .map(
          (r) => `<tr class="drill${r.stale ? ' is-stale' : ''}" data-drill-name="${escapeHtml(r.name)}" tabindex="0">
        <td>
          <strong>${escapeHtml(r.name)}</strong>
          <div class="dim small">${escapeHtml(r.category)} · ${r.count}× · ${Math.round(r.confidence * 100)}% regular</div>
        </td>
        <td class="num">${viz.fmt(r.typical)}</td>
        <td class="dim">${r.cadence}</td>
        <td class="num">${viz.fmt(r.perMonth)}</td>
        <td class="num dim nowrap">${shortDate(r.last)}</td>
        <td class="num nowrap ${r.stale ? 'shadow' : 'dim'}">${r.stale ? 'lapsed' : shortDate(r.nextDue)}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>`;
  wireDrill($('#recurring'));
}

function renderBalance(all) {
  const accts = [...new Set(all.map((t) => t.accountSource || 'mpesa'))];
  const card = $('#balance-card');
  const any = all.some((t) => t.balance != null);
  card.hidden = !any;
  if (!any) return;

  if (!state.balAcct || !accts.includes(state.balAcct)) state.balAcct = accts.includes('mpesa') ? 'mpesa' : accts[0];
  const sel = $('#bal-acct');
  sel.innerHTML = accts
    .map((a) => `<option value="${a}"${a === state.balAcct ? ' selected' : ''}>${a === 'bank' ? 'Bank' : 'M-PESA'}</option>`)
    .join('');

  const series = balanceSeries(all, state.balAcct);
  const low = lowDays(series, 100);
  const latest = series.at(-1);
  setBadge(
    '#balance-badge',
    latest ? `${viz.fmt(latest.balance)} latest${low ? ` · ${low} days under 100` : ''}` : '',
    low > 0
  );
  viz.renderBalance($('#chart-balance'), series, state.balAcct);

  sel.addEventListener('change', () => {
    state.balAcct = sel.value;
    render();
  });
}

function renderFuliza(all) {
  const f = fulizaReport(all);
  const card = $('#fuliza-card');
  card.hidden = f.times === 0;
  if (!f.times) return;

  setBadge(
    '#fuliza-badge',
    `${f.outstanding > 0 ? `${viz.fmt(f.outstanding)} owed · ` : 'clear · '}${f.times} draws`,
    f.outstanding > 0
  );
  const maxMonth = Math.max(...f.byMonth.map((m) => m.amount), 1);

  $('#fuliza').innerHTML = `
    <p class="hint">Fuliza covers you when the wallet is short. Drawing on it isn't spending — it's borrowing — so it never counts toward your totals. It repays itself the moment money lands in your wallet, so the balance below is read straight from your statements' draws and repayments.</p>
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Still owed on Fuliza</span>
        <span class="kpi-value ${f.outstanding > 0 ? 'neg' : 'pos'}">${viz.fmt(f.outstanding)}</span>
        <span class="kpi-note">${f.outstanding > 0 ? 'drawn, not yet repaid' : 'cleared — every draw repaid'}</span>
      </div>
      <div class="kpi"><span class="kpi-label">Times short</span><span class="kpi-value">${f.times}</span><span class="kpi-note">${f.everyNDays ? `about every ${f.everyNDays.toFixed(1)} days` : ''}</span></div>
      <div class="kpi"><span class="kpi-label">Total drawn</span><span class="kpi-value">${viz.fmt(f.borrowed)}</span><span class="kpi-note">avg ${viz.fmt(f.avgDraw)}</span></div>
      <div class="kpi"><span class="kpi-label">Repaid</span><span class="kpi-value">${viz.fmt(f.repaid)}</span></div>
      <div class="kpi"><span class="kpi-label">Charges on those days</span><span class="kpi-value">${viz.fmt(f.feesOnDraws)}</span><span class="kpi-note">fees, not interest</span></div>
    </div>

    <h3 class="debt-group">How often, by month</h3>
    <div class="bars">${f.byMonth
      .map(
        (m) => `<div class="bar-row">
        <div class="bar-label">${escapeHtml(monthLabel(m.month))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(m.amount / maxMonth) * 100}%"></div></div>
        <div class="bar-value">${viz.fmt(m.amount)}<span class="bar-count">${m.count}×</span></div>
      </div>`
      )
      .join('')}</div>

    <h3 class="debt-group">What you were short for</h3>
    <table class="mini">
      <thead><tr><th>Category</th><th class="num">Funded by Fuliza</th><th class="num">Times</th></tr></thead>
      <tbody>${f.forWhat
        .map(
          (c) => `<tr class="drill" data-drill-cat="${escapeHtml(c.category)}" tabindex="0">
        <td>${escapeHtml(c.category)}</td><td class="num">${viz.fmt(c.total)}</td><td class="num dim">${c.count}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>
    <p class="hint note">I'm not quoting a cost of borrowing. Draws and repayments fall in different periods, so “repaid minus drawn” would mostly measure where the statement starts and stops, not what Fuliza charged you. The statement doesn't itemise Fuliza interest — the charges above are the fees on those same receipts, which is the closest honest figure.</p>`;

  wireDrill($('#fuliza'));
}

/**
 * Months you can select. Transaction dates alone aren't enough: pay received on 28 July
 * that funds AUGUST needs an August to assign it to, and August has no transactions
 * yet. So the list also carries every month something has been assigned to, plus one
 * month past the newest data — the month you're about to live in.
 */
function selectableMonths(all) {
  const set = new Set(monthsIn(all));
  for (const m of store.assignedBudgetMonths()) set.add(m);
  const newest = [...set].sort().at(-1);
  if (newest) set.add(nextMonth(newest));
  return [...set].sort().reverse();
}

/**
 * One budget line (or one category) across every month.
 *
 * The monthly report answers "how did this month compare with last"; this answers
 * "is this creeping up", which needs the whole run of months at once.
 *
 * Every figure comes from budgetReport, deliberately — that's the only way it agrees
 * with the Budget panel. A plain sum by transaction date would quietly disagree with
 * it for anything split across categories or assigned to a different month.
 */
function renderTrack(all) {
  const card = $('#track-card');
  const months = selectableMonths(all).slice().reverse(); // oldest → newest
  const budgets = store.budgets();
  if (months.length < 2) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const lines = budgets.filter((b) => b.categories.length);
  const cats = [
    ...new Set(
      all
        .filter((t) => t.direction === 'Out')
        .flatMap((t) => (t.splits && t.splits.length ? t.splits.map((p) => p.category) : [t.category]))
    ),
  ]
    .filter((c) => classOf(c) === CLASSES.SPENDING)
    .sort();

  const valid = new Set([...lines.map((b) => `line:${b.id}`), ...cats.map((c) => `cat:${c}`)]);
  if (!state.track || !valid.has(state.track)) state.track = lines.length ? `line:${lines[0].id}` : `cat:${cats[0]}`;

  const sel = $('#track-sel');
  sel.innerHTML =
    `<optgroup label="Budget lines">${lines
      .map((b) => `<option value="line:${escapeHtml(b.id)}"${state.track === `line:${b.id}` ? ' selected' : ''}>${escapeHtml(b.label)}</option>`)
      .join('')}</optgroup>` +
    `<optgroup label="Single categories">${cats
      .map((c) => `<option value="cat:${escapeHtml(c)}"${state.track === `cat:${c}` ? ' selected' : ''}>${escapeHtml(c)}</option>`)
      .join('')}</optgroup>`;

  // A single category is measured by asking the budget engine about a one-line budget
  // containing just it — same code path, so the numbers can't drift apart.
  const isLine = state.track.startsWith('line:');
  const line = isLine ? lines.find((b) => `line:${b.id}` === state.track) : null;
  const cat = isLine ? null : state.track.slice(4);
  const probe = isLine ? budgets : [{ id: 'probe', label: cat, amount: 0, categories: [cat] }];
  const label = isLine ? line.label : cat;
  const covers = isLine ? line.categories : [cat];

  const full = months.map((m) => {
    const rep = budgetReport(probe, all, m);
    const row = isLine ? rep.report.find((r) => r.id === line.id) : rep.report[0];
    return { month: m, spent: row.spent, budget: row.amount, count: row.count };
  });

  // Months before this line ever saw a shilling say nothing — the data simply starts
  // sparse. Interior gaps stay: "nothing in April" is a real answer.
  const firstActive = full.findIndex((s) => s.count > 0);
  const series = firstActive > 0 ? full.slice(firstActive) : full;

  const spentMonths = series.filter((s) => s.count > 0);
  const avg = spentMonths.length ? spentMonths.reduce((a, s) => a + s.spent, 0) / spentMonths.length : 0;
  const peak = series.reduce((a, s) => (s.spent > a.spent ? s : a), series[0]);
  // The newest month with activity, not simply the last column — the list runs one
  // month ahead for budgeting, and "August: 0, down 100%" is noise, not news.
  const latest = spentMonths.length ? spentMonths[spentMonths.length - 1] : series[series.length - 1];
  const vsAvg = avg > 0 && latest.count > 0 ? (latest.spent - avg) / avg : null;
  const max = Math.max(...series.map((s) => Math.max(s.spent, s.budget)), 1);

  setBadge('#track-badge', `${label} · ${viz.fmt(avg)}/mo avg`);

  $('#track').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Average a month</span>
        <span class="kpi-value">${viz.fmt(avg)}</span>
        <span class="kpi-note">${spentMonths.length} month${spentMonths.length === 1 ? '' : 's'} with spending</span>
      </div>
      <div class="kpi"><span class="kpi-label">${escapeHtml(monthLabel(latest.month))}</span><span class="kpi-value">${viz.fmt(latest.spent)}</span><span class="kpi-note">${
        vsAvg === null ? '&nbsp;' : `${vsAvg >= 0 ? '↑' : '↓'} ${Math.abs(vsAvg * 100).toFixed(0)}% vs average`
      }</span></div>
      <div class="kpi"><span class="kpi-label">Highest</span><span class="kpi-value">${viz.fmt(peak.spent)}</span><span class="kpi-note">${escapeHtml(monthLabel(peak.month))}</span></div>
      <div class="kpi"><span class="kpi-label">Covers</span><span class="kpi-value" style="font-size:15px;line-height:1.3">${covers.map(escapeHtml).join('<br>')}</span></div>
    </div>

    <div class="bars" role="list">${series
      .map((s) => {
        const over = s.budget > 0 && s.spent > s.budget;
        // The budget shows as a notch on the track, so "over" is visible at a glance
        // rather than something you work out from two numbers.
        const notch =
          s.budget > 0
            ? `<div class="budget-notch" style="left:${Math.min(100, (s.budget / max) * 100)}%" title="Budget ${viz.fmt(s.budget)}"></div>`
            : '';
        return `<div class="bar-row track-row" data-track-month="${s.month}" role="listitem" tabindex="0" title="Show these transactions">
          <div class="bar-label">${escapeHtml(monthLabel(s.month))}</div>
          <div class="bar-track">${notch}<div class="bar-fill" style="width:${(s.spent / max) * 100}%${
            over ? ';background:var(--critical)' : ''
          }"></div></div>
          <div class="bar-value ${over ? 'neg' : ''}">${viz.fmt(s.spent)}${
            s.count ? `<span class="bar-count">${s.count}×</span>` : ''
          }</div>
        </div>`;
      })
      .join('')}</div>
    ${
      series.some((s) => s.budget > 0)
        ? '<p class="hint note">The notch on each bar is that month’s budget; a red bar went over it.</p>'
        : ''
    }`;

  sel.onchange = () => {
    state.track = sel.value;
    renderTrack(all);
  };

  // Click a month to see exactly what made it up — budget-month aware, so it matches
  // the bar rather than the calendar.
  $('#track')
    .querySelectorAll('[data-track-month]')
    .forEach((el) => {
      const go = () => {
        state.drillMonth = el.dataset.trackMonth;
        state.catFilter = covers.length === 1 ? covers[0] : 'all';
        state.search = '';
        state.dirFilter = 'Out';
        render();
        $('details[data-panel="txns"]').open = true;
        $('#table-txns').scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(`Showing ${label} in ${monthLabel(el.dataset.trackMonth)}.`);
      };
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    });
}

function renderMonthly(all) {
  const months = selectableMonths(all);
  const card = $('#month-card');
  card.hidden = months.length === 0;
  if (!months.length) return;

  if (!state.month || !months.includes(state.month)) state.month = months[0];

  const sel = $('#month-sel');
  sel.innerHTML = months.map((m) => `<option value="${m}"${m === state.month ? ' selected' : ''}>${monthLabel(m)}</option>`).join('');

  const { now, prev, prevKey, movers } = compareMonths(all, state.month);
  const hasPrev = prev.count > 0;
  $('#month-vs').textContent = hasPrev ? `compared with ${monthLabel(prevKey)}` : 'no earlier month to compare with';
  setBadge('#month-badge', `${monthLabel(state.month)} · ${viz.fmt(now.spent)} spent`);

  const delta = now.spent - prev.spent;
  const pct = prev.spent > 0 ? delta / prev.spent : null;
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '';

  // Everything spent on this month gets a comparison — ranking by size of CHANGE alone
  // filled the table with categories that had gone quiet while dropping the ones money
  // actually went to. Two days into a month, every category shows a big drop, so
  // "biggest movers" is a list of things that haven't happened yet.
  //
  // So: what you spent on, biggest first, always. Then the largest categories that have
  // gone quiet, which is real information early in a month ("rent hasn't gone out yet")
  // but must not crowd out the spending itself.
  const active = movers.filter((m) => m.now > 0).sort((a, b) => b.now - a.now);
  const quiet = movers
    .filter((m) => m.now === 0 && m.prev >= Math.max(500, prev.spent * 0.02))
    .sort((a, b) => b.prev - a.prev)
    .slice(0, 6);
  const material = [...active, ...quiet];

  $('#month-report').innerHTML = `
    <div class="kpis month-kpis">
      <div class="kpi lead">
        <span class="kpi-label">Spent</span>
        <span class="kpi-value">${viz.fmt(now.spent)}</span>
        <span class="kpi-note">${
          hasPrev
            ? `${arrow} ${viz.fmt(Math.abs(delta))}${pct !== null ? ` (${(Math.abs(pct) * 100).toFixed(0)}%)` : ''} vs ${monthLabel(prevKey).split(' ')[0]}`
            : '&nbsp;'
        }</span>
      </div>
      <div class="kpi"><span class="kpi-label">Received</span><span class="kpi-value">${viz.fmt(now.income)}</span></div>
      <div class="kpi"><span class="kpi-label">Net</span><span class="kpi-value ${now.net < 0 ? 'neg' : 'pos'}">${
        now.net < 0 ? '−' : '+'
      }${viz.fmt(Math.abs(now.net))}</span></div>
      <div class="kpi"><span class="kpi-label">Fees</span><span class="kpi-value">${viz.fmt(now.fees)}</span></div>
      <div class="kpi"><span class="kpi-label">Transactions</span><span class="kpi-value">${now.count}</span></div>
    </div>

    ${
      hasPrev && material.length
        ? `<h3 class="debt-group">${escapeHtml(monthLabel(state.month).split(' ')[0])} vs ${escapeHtml(monthLabel(prevKey).split(' ')[0])}</h3>
           <table class="mini month-table">
             <thead><tr><th>Category</th><th class="num">${monthLabel(state.month).split(' ')[0]}</th><th class="num">${monthLabel(prevKey).split(' ')[0]}</th><th class="num">Change</th><th>Why</th></tr></thead>
             <tbody>${material.map((m) => moverRow(m, all)).join('')}</tbody>
           </table>`
        : ''
    }

    <h3 class="debt-group">Everything in ${escapeHtml(monthLabel(state.month))}</h3>
    <div class="bars" role="list">${
      now.categories.length
        ? now.categories
            .map((c, i) => {
              const max = now.categories[0].total;
              return `<div class="bar-row drill" data-drill-cat="${escapeHtml(c.category)}" role="listitem" tabindex="0"
                        title="Show these transactions">
                <div class="bar-label">${escapeHtml(c.category)}</div>
                <div class="bar-track"><div class="bar-fill" style="width:${(c.total / max) * 100}%;background:${rampFor(i, now.categories.length)}"></div></div>
                <div class="bar-value">${viz.fmt(c.total)}<span class="bar-count">${c.count}×</span></div>
              </div>`;
            })
            .join('')
        : '<p class="empty">Nothing spent this month.</p>'
    }</div>`;

  sel.addEventListener('change', () => {
    state.month = sel.value;
    render();
  });

  wireDrill($('#month-report'));
}

function moverRow(m, all) {
  const up = m.delta > 0;
  const driver = up && !m.isGone ? biggestDriver(all, state.month, m.category) : null;
  const why = m.isNew
    ? '<span class="dim">new this month</span>'
    : m.isGone
      ? '<span class="dim">nothing this month</span>'
      : driver
        ? `<span class="dim">mostly ${escapeHtml(String(driver.txn.counterparty || '').slice(0, 26))} (${viz.fmt(driver.txn.amount)})</span>`
        : `<span class="dim">${m.count} transaction${m.count === 1 ? '' : 's'}</span>`;

  return `<tr class="drill" data-drill-cat="${escapeHtml(m.category)}" tabindex="0">
    <td><strong>${escapeHtml(m.category)}</strong></td>
    <td class="num">${m.now ? viz.fmt(m.now) : '—'}</td>
    <td class="num dim">${m.prev ? viz.fmt(m.prev) : '—'}</td>
    <td class="num ${up ? 'shadow' : 'in'}">${up ? '+' : '−'}${viz.fmt(Math.abs(m.delta))}${
      m.pct !== null ? `<span class="dim small"> ${(Math.abs(m.pct) * 100).toFixed(0)}%</span>` : ''
    }</td>
    <td>${why}</td>
  </tr>`;
}

function debtCard({ p, c }) {
  const pct = Math.round(c.pct * 100);
  const clear = c.owed <= 0.5;
  // The amount owed is the one number that matters, so it gets the size. Everything
  // else is context and recedes.
  return `
    <article class="debt-card${clear ? ' is-clear' : ''}">
      <header>
        <h4>${escapeHtml(p.name)}</h4>
        ${p.kind === 'revolving' ? '<span class="pill pill-revolving" title="You can draw on this again — the balance goes up as well as down">revolving</span>' : ''}
        <button class="link-btn debt-remove" data-rmdebt="${escapeHtml(p.id)}" title="Remove this debt">✕</button>
      </header>

      <div class="debt-amount ${clear ? 'in' : ''}">${clear ? 'Cleared' : viz.fmt(c.owed)}</div>
      <div class="debt-sub">${clear ? escapeHtml(p.note || 'nothing outstanding') : 'still owed'}</div>

      <div class="meter" role="img" aria-label="${pct}% paid">
        <div class="meter-fill" style="width:${Math.max(pct, clear ? 100 : 2)}%;${clear ? 'background:var(--good)' : ''}"></div>
      </div>

      <dl class="debt-facts">
        <div><dt>Paid</dt><dd>${c.paid ? viz.fmt(c.paid) : '—'}</dd></div>
        ${c.drawn > 0.5 ? `<div><dt>Drawn</dt><dd class="shadow">+${viz.fmt(c.drawn)}</dd></div>` : ''}
        <div><dt>${p.due ? 'Due' : 'Source'}</dt><dd>${escapeHtml(p.due ? prettyDue(p.due) : c.trackable ? `${c.matched} txns` : 'by hand')}</dd></div>
      </dl>

      ${
        c.trackable
          ? `<p class="debt-note">Updates itself — matches “${escapeHtml(p.match)}” in new statements.</p>`
          : `<p class="debt-note">Nothing matches this automatically — link a payment or record one.</p>`
      }

      ${
        c.linked.length
          ? `<ul class="linked-list">${c.linked
              .map(
                (t) => `<li>
                  <span class="dim small">${shortDate(t.date)}</span>
                  <span>${viz.fmt(t.amount)}</span>
                  <span class="dim small ellip">${escapeHtml(String(t.counterparty || '').slice(0, 22))}</span>
                  <button class="link-btn" data-unlink="${p.id}|${t.id}" title="Unlink">✕</button>
                </li>`
              )
              .join('')}</ul>`
          : ''
      }

      <footer class="debt-actions">
        <button class="btn-quiet" data-pick="${p.id}">Link a payment</button>
        <button class="btn-quiet" data-pay="${p.id}">Enter amount</button>
        <button class="btn-quiet" data-edit="${p.id}">Edit</button>
      </footer>

      <div class="pick-box" data-pick-box="${p.id}" hidden>
        <input type="search" class="pick-search" data-search="${p.id}" placeholder="Search your transactions…" aria-label="Search transactions to link">
        <div class="pick-list" data-list="${p.id}"></div>
        <button type="button" class="ghost pick-close" data-cancel-pick="${p.id}">Close</button>
      </div>

      <form class="pay-form" data-form="${p.id}" hidden>
        <label class="dim small" for="amt-${p.id}">Amount paid outside these accounts (cheque, cash)</label>
        <div class="pay-row">
          <input id="amt-${p.id}" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00">
          <button type="submit" class="primary">Save</button>
          <button type="button" class="ghost" data-cancel="${p.id}">Cancel</button>
        </div>
      </form>

      <form class="pay-form edit-form" data-editform="${p.id}" hidden>
        <label class="dim small" for="ed-name-${p.id}">Name</label>
        <input id="ed-name-${p.id}" type="text" value="${escapeHtml(p.name)}">

        <label class="dim small" for="ed-open-${p.id}">Balance owed</label>
        <input id="ed-open-${p.id}" type="number" inputmode="decimal" step="0.01" min="0" value="${p.opening}">

        <label class="dim small" for="ed-asof-${p.id}">…as of this date</label>
        <input id="ed-asof-${p.id}" type="date" value="${escapeHtml(String(p.asOf || '').slice(0, 10))}">

        <label class="dim small" for="ed-match-${p.id}">Matches this word in statements (blank = track by hand)</label>
        <input id="ed-match-${p.id}" type="text" value="${escapeHtml(p.match || '')}" placeholder="e.g. the lender's name">

        <label class="dim small" for="ed-due-${p.id}">Due (a date, or free text like “Target Feb 2027”)</label>
        <input id="ed-due-${p.id}" type="text" value="${escapeHtml(p.due || '')}" placeholder="e.g. Target Feb 2027">

        <label class="dim small" for="ed-kind-${p.id}">Kind</label>
        <select id="ed-kind-${p.id}">
          <option value="fixed"${p.kind !== 'revolving' ? ' selected' : ''}>Fixed — a set amount you pay down</option>
          <option value="revolving"${p.kind === 'revolving' ? ' selected' : ''}>Revolving — you can draw on it again</option>
        </select>

        <p class="hint">A restated balance replaces what came before it, so payments already recorded against this debt are cleared and only ones after that date count again. The transactions themselves aren't touched.</p>
        <div class="pay-row">
          <button type="submit" class="primary">Save</button>
          <button type="button" class="ghost" data-cancel-edit="${p.id}">Cancel</button>
        </div>
      </form>
    </article>`;
}

// Lenders seen in the statements that have NO debt line — money you received from a
// loan app that isn't in "What I owe", so the total understates what you owe. Each
// gets a one-click add; the new line then tracks itself via its match string.
function untrackedLenders(txns, payables) {
  const isOverdraft = (t) =>
    t.type === 'Overdraft Credit' || /^(M-PESA Overdraft|M-PESA Overdraw)/i.test(String(t.counterparty || '').trim());
  const covered = payables.map((p) => (p.match || '').toLowerCase()).filter(Boolean);
  const found = new Map();
  for (const t of txns) {
    // Disbursement legs only. Fuliza has its own panel; repayment-only lenders are
    // already going down, and with no draw seen there's no balance to seed.
    if (t.direction !== 'In' || t.category !== 'Loans & Credit' || isOverdraft(t)) continue;
    const name = String(t.counterparty || '').trim();
    if (!name || /^Fuliza/i.test(name)) continue;
    // The category alone is too weak a test to offer someone a DEBT off the back of.
    // It once surfaced "Agent withdrawal" — M-PESA plumbing, not a lender — and one
    // click booked six figures of imagined borrowing. So the name has to actually look
    // like a lender we know, or the row has to be an explicit disbursement.
    const looksLikeLender = LENDER_RE.test(name) || t.type === 'Loan Disbursement';
    const isPlumbing = /^(Withdrawal|Deposit|Charge|Reversal)$/i.test(t.type || '');
    if (!looksLikeLender || isPlumbing) continue;
    if (covered.some((m) => name.toLowerCase().includes(m))) continue;
    const cur = found.get(name) || { name, drawn: 0, count: 0, last: null };
    cur.drawn += t.amount;
    cur.count++;
    if (!cur.last || t.date > cur.last) cur.last = t.date;
    found.set(name, cur);
  }
  return [...found.values()].sort((a, b) => b.drawn - a.drawn);
}

function renderDebts(txns) {
  const list = store.payables();
  const el = $('#debts');
  if (!list.length) {
    el.innerHTML = '<p class="hint">No payables. They seeded from your wealth tracker; if you cleared them, restore a backup to get them back.</p>';
    setBadge('#debts-badge', '');
    return;
  }

  const rows = list.map((p) => ({ p, c: computePayable(p, txns) }));
  const owed = rows.reduce((a, r) => a + r.c.owed, 0);
  const drawnSince = rows.reduce((a, r) => a + r.c.drawn, 0);
  setBadge('#debts-badge', `${viz.fmt(owed)} owed`, owed > 0);

  // Settled items stay in the data — a cleared revolving line can be drawn on again,
  // and its history is how you'd notice — but they don't belong in a list of what you
  // owe. Hidden by default, one click away.
  const settled = rows.filter((r) => r.c.owed <= 0.5);
  const open = rows.filter((r) => r.c.owed > 0.5);
  const shown = state.showSettled ? rows : open;

  const groups = new Map();
  for (const r of shown) {
    if (!groups.has(r.p.group)) groups.set(r.p.group, []);
    groups.get(r.p.group).push(r);
  }

  el.innerHTML = `
    <div class="recon-head">
      <div class="recon-stat">
        <span class="kpi-label">Total owed</span>
        <span class="kpi-value">${viz.fmt(owed)}</span>
        <span class="kpi-note">across ${list.length} items</span>
      </div>
      ${
        drawnSince > 0.5
          ? `<div class="recon-stat">
               <span class="kpi-label">Borrowed since</span>
               <span class="kpi-value" style="color:var(--critical)">${viz.fmt(drawnSince)}</span>
               <span class="kpi-note">new draws on revolving lines</span>
             </div>`
          : ''
      }
      ${
        settled.length
          ? `<div class="recon-stat">
               <span class="kpi-label">Settled</span>
               <span class="kpi-value in">${settled.length}</span>
               <span class="kpi-note"><label class="settled-toggle"><input type="checkbox" id="show-settled"${
                 state.showSettled ? ' checked' : ''
               }> show them</label></span>
             </div>`
          : ''
      }
    </div>
    ${(() => {
      const missing = untrackedLenders(txns, list);
      return missing.length
        ? `<h3 class="debt-group">Lenders not tracked yet</h3>
           <p class="hint">Money arrived from these loan apps but they have no line above — so what you owe them isn't in the total. Add one and it tracks itself from here on.</p>
           <table class="mini">
             <tbody>${missing
               .map(
                 (m) => `<tr>
                   <td><strong>${escapeHtml(m.name)}</strong><div class="dim small">last ${shortDate(m.last)}</div></td>
                   <td class="num">${viz.fmt(m.drawn)}<div class="dim small">${m.count} draw${m.count === 1 ? '' : 's'}</div></td>
                   <td class="num"><button class="btn-quiet" data-add-lender="${escapeHtml(m.name)}" data-drawn="${m.drawn}">Track this debt</button></td>
                 </tr>`
               )
               .join('')}</tbody>
           </table>`
        : '';
    })()}
    ${[...groups.entries()]
      .map(
        ([group, items]) => `
      <h3 class="debt-group">${escapeHtml(group)}</h3>
      <div class="debt-grid">${items.map(debtCard).join('')}</div>`
      )
      .join('')}
    <p class="hint note">“Drawn” is new borrowing since the balance was last confirmed — on a revolving line that pushes the balance <em>up</em>, which is why repayments alone never tell you where you stand.</p>`;

  // One-click add for a lender seen in the statements. opening 0 + asOf far in the
  // past: every draw and repayment in the data replays, so the balance is computed
  // rather than guessed. Match on the lender's name so future statements keep it
  // current.
  el.querySelectorAll('button[data-add-lender]').forEach((b) =>
    b.addEventListener('click', () => {
      const name = b.dataset.addLender;
      store.addPayable({
        name,
        group: 'Loans — revolving',
        kind: 'revolving',
        match: name.toLowerCase(),
        opening: 0,
        asOf: '2020-01-01',
        note: 'Added from statement activity',
        due: null,
      });
      render();
      toast(`Tracking ${name} — its balance now counts in the total.`);
    })
  );

  const st = $('#show-settled');
  if (st)
    st.addEventListener('change', (e) => {
      state.showSettled = e.target.checked;
      render();
    });

  // Remove a debt. There was no way to undo adding one, so a line added by mistake
  // (or a suggestion that turned out not to be a lender at all) sat in the total
  // forever. Confirmed, because manual payments recorded against it go with it.
  // Edit a debt. A lender restates the balance (interest, fees, an early-settlement
  // quote) and the figure here has to be able to follow — without a way to change it,
  // a debt was frozen at whatever it was first entered as.
  el.querySelectorAll('button[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const form = el.querySelector(`form[data-editform="${CSS.escape(b.dataset.edit)}"]`);
      const opening = form.hidden;
      el.querySelectorAll('form.pay-form').forEach((f) => (f.hidden = true));
      form.hidden = !opening;
      if (opening) form.querySelector('input').focus();
    })
  );

  el.querySelectorAll('button[data-cancel-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelector(`form[data-editform="${CSS.escape(b.dataset.cancelEdit)}"]`).hidden = true;
    })
  );

  el.querySelectorAll('form[data-editform]').forEach((form) =>
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = form.dataset.editform;
      const q = (sel) => form.querySelector(sel);
      const name = q(`#ed-name-${CSS.escape(id)}`).value.trim();
      const opening = Number(q(`#ed-open-${CSS.escape(id)}`).value);
      const asOf = q(`#ed-asof-${CSS.escape(id)}`).value;
      const match = q(`#ed-match-${CSS.escape(id)}`).value.trim();
      const kind = q(`#ed-kind-${CSS.escape(id)}`).value;
      const due = q(`#ed-due-${CSS.escape(id)}`).value.trim();
      if (!name) return toast('Give it a name.');
      if (!Number.isFinite(opening) || opening < 0) return toast('Enter the balance owed.');
      // The restated balance already accounts for everything paid up to its date, so
      // the old payment records must go or they'd be subtracted a second time.
      store.updatePayable(id, { name, opening, asOf: asOf || null, match, kind, due, manualPaid: 0, linkedIds: [] });
      render();
      toast(`${name} updated — ${viz.fmt(opening)} owed.`);
    })
  );

  el.querySelectorAll('button[data-rmdebt]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = list.find((x) => x.id === b.dataset.rmdebt);
      if (!p) return;
      const c = computePayable(p, txns);
      const extra = p.manualPaid > 0 ? `\n\n${viz.fmt(p.manualPaid)} you recorded by hand will be lost.` : '';
      if (!confirm(`Remove “${p.name}”? It's showing ${viz.fmt(c.owed)} owed.${extra}`)) return;
      store.removePayable(p.id);
      render();
      toast(`Removed “${p.name}”.`);
    })
  );

  // Inline form rather than prompt(): a browser dialog can't be styled, blocks the
  // page, and gives no room to say what the field is for.
  el.querySelectorAll('button[data-pay]').forEach((b) =>
    b.addEventListener('click', () => {
      const form = el.querySelector(`form[data-form="${b.dataset.pay}"]`);
      const opening = form.hidden;
      el.querySelectorAll('form.pay-form').forEach((f) => (f.hidden = true));
      el.querySelectorAll('button[data-pay]').forEach((o) => o.classList.remove('is-open'));
      form.hidden = !opening;
      b.classList.toggle('is-open', opening);
      if (opening) form.querySelector('input').focus();
    })
  );

  el.querySelectorAll('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelector(`form[data-form="${b.dataset.cancel}"]`).hidden = true;
      el.querySelector(`button[data-pay="${b.dataset.cancel}"]`).classList.remove('is-open');
    })
  );

  // --- link an existing transaction to a debt
  const drawList = (id) => {
    const p = list.find((x) => x.id === id);
    const c = computePayable(p, txns);
    const q = el.querySelector(`input[data-search="${id}"]`).value;
    const hits = store.paymentCandidates(id, { query: q, owed: c.owed });
    const linked = new Set(p.linkedIds || []);
    const box = el.querySelector(`div[data-list="${id}"]`);
    box.innerHTML = hits.length
      ? hits
          .map(
            (t) => `<button type="button" class="pick-row${linked.has(t.id) ? ' is-linked' : ''}" data-link="${id}|${t.id}"${
              linked.has(t.id) ? ' disabled' : ''
            }>
          <span class="dim small">${shortDate(t.date)}</span>
          <strong>${viz.fmt(t.amount)}</strong>
          <span class="ellip">${escapeHtml(String(t.counterparty || '—').slice(0, 30))}</span>
          <span class="dim small">${linked.has(t.id) ? 'linked' : t.receipt || ''}</span>
        </button>`
          )
          .join('')
      : '<p class="hint">Nothing matches that search.</p>';

    box.querySelectorAll('button[data-link]').forEach((b) =>
      b.addEventListener('click', () => {
        const [pid, tid] = b.dataset.link.split('|');
        const res = store.linkPayment(pid, tid);
        if (!res.ok) {
          toast(res.error, 'warn');
          return;
        }
        render();
        toast(`Linked ${viz.fmt(res.txn.amount)} to ${list.find((x) => x.id === pid).name}.`);
      })
    );
  };

  el.querySelectorAll('button[data-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.pick;
      const box = el.querySelector(`div[data-pick-box="${id}"]`);
      const opening = box.hidden;
      el.querySelectorAll('.pick-box').forEach((x) => (x.hidden = true));
      el.querySelectorAll('button[data-pick]').forEach((o) => o.classList.remove('is-open'));
      box.hidden = !opening;
      b.classList.toggle('is-open', opening);
      if (opening) {
        drawList(id);
        box.querySelector('input').focus();
      }
    })
  );

  el.querySelectorAll('input[data-search]').forEach((inp) => {
    let t;
    inp.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => drawList(inp.dataset.search), 140);
    });
  });

  el.querySelectorAll('button[data-cancel-pick]').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelector(`div[data-pick-box="${b.dataset.cancelPick}"]`).hidden = true;
      el.querySelector(`button[data-pick="${b.dataset.cancelPick}"]`).classList.remove('is-open');
    })
  );

  el.querySelectorAll('button[data-unlink]').forEach((b) =>
    b.addEventListener('click', () => {
      const [pid, tid] = b.dataset.unlink.split('|');
      store.unlinkPayment(pid, tid);
      render();
      toast('Unlinked.');
    })
  );

  el.querySelectorAll('form.pay-form').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const id = f.dataset.form;
      const p = list.find((x) => x.id === id);
      const res = store.recordManualPayment(id, parseFloat(f.querySelector('input').value));
      if (!res.ok) {
        toast(res.error, 'warn');
        return;
      }
      render();
      toast(`Recorded against ${p.name}. ${viz.fmt(res.manualPaid)} paid by hand in total.`);
    })
  );
}

function prettyDue(due) {
  if (!due) return '';
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return due; // free text like "Target Jan 2027"
  const overdue = d.getTime() < Date.now();
  return (overdue ? '⚠ ' : '') + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

function renderSettings() {
  const s = store.settings();
  $('#set-name').value = s.name || '';
  $('#set-phones').value = (s.phones || []).join(', ');
  $('#set-accounts').value = (s.accounts || []).join(', ');
  $('#set-limit').value = s.smallSendLimit ?? 200;

  // An unset identity is not a cosmetic gap: internal transfers stop being detected
  // and the same money counts twice. Say so where it can't be missed.
  const ok = isConfigured();
  setBadge('#settings-badge', ok ? `${(s.phones || []).length + (s.accounts || []).length} identifiers` : '⚠ not set up', !ok);
  $('#settings-card').classList.toggle('needs-setup', !ok);

  const cats = Object.keys(CATEGORIES);
  $('#ppl-cat').innerHTML = cats.map((c) => `<option${c === 'Family' ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');

  const people = s.people || [];
  $('#ppl-list').innerHTML = people.length
    ? `<table class="mini"><tbody>${people
        .map(
          (p, i) => `<tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td class="dim">${escapeHtml(p.number)}</td>
        <td class="dim">${escapeHtml(p.category || '')}</td>
        <td class="num"><button class="link-btn" data-rmppl="${i}" title="Remove">✕</button></td>
      </tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="hint">Nobody added yet.</p>';

  $('#ppl-list')
    .querySelectorAll('button[data-rmppl]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        const next = [...people];
        next.splice(+b.dataset.rmppl, 1);
        store.saveSettings({ people: next });
        render();
        renderSettings();
      })
    );
}

function wireSettings() {
  const save = () => {
    const split = (v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    store.saveSettings({
      name: $('#set-name').value.trim(),
      phones: split($('#set-phones').value),
      accounts: split($('#set-accounts').value),
      smallSendLimit: parseFloat($('#set-limit').value) || 0,
    });
    render();
    renderSettings();
    toast('Settings saved. They stay in this browser.');
  };
  ['#set-name', '#set-phones', '#set-accounts', '#set-limit'].forEach((sel) =>
    $(sel).addEventListener('change', save)
  );

  $('#ppl-add').addEventListener('click', () => {
    const name = $('#ppl-name').value.trim();
    const number = $('#ppl-num').value.trim();
    if (!name || !number) {
      toast('A name and a number, please.', 'warn');
      return;
    }
    const people = [...(store.settings().people || []), { name, number: normNumber(number), category: $('#ppl-cat').value }];
    store.saveSettings({ people });
    // Their name is also how their transactions get categorised.
    store.addNameRule(name, $('#ppl-cat').value);
    $('#ppl-name').value = '';
    $('#ppl-num').value = '';
    render();
    renderSettings();
    renderNameRules();
    toast(`${name} added — their bank rows will be named too.`);
  });
}

function renderCategories() {
  const custom = store.getState().customCategories;
  const el = $('#cat-list');
  if (!custom.length) {
    el.innerHTML = '<p class="hint">No custom categories yet — the built-in ones are always available.</p>';
    return;
  }
  const HOW = { spending: 'spending', transfer: 'moved, not spent', income: 'money in', fee: 'a fee' };
  el.innerHTML = `<table class="mini"><tbody>${custom
    .map((c) => {
      const u = store.categoryUsage(c.name);
      return `<tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td class="dim">${HOW[c.class] || c.class}</td>
        <td class="num dim">${u.rules ? `${u.rules} rule${u.rules === 1 ? '' : 's'}` : ''}</td>
        <td class="num"><button class="link-btn" data-rmcat="${escapeHtml(c.name)}" title="Remove category">✕</button></td>
      </tr>`;
    })
    .join('')}</tbody></table>`;

  el.querySelectorAll('button[data-rmcat]').forEach((b) =>
    b.addEventListener('click', () => {
      const name = b.dataset.rmcat;
      const u = store.categoryUsage(name);
      const warn = u.rules || u.overrides
        ? `\n\n${u.rules} name rule(s) and ${u.overrides} manual assignment(s) use it. They will be removed and those transactions go back to Uncategorised.`
        : '';
      if (!confirm(`Remove the category “${name}”?${warn}`)) return;
      store.removeCategory(name);
      applyCustomCategories();
      render();
      renderNameRules();
      renderCategories();
      toast(`Removed “${name}”.`);
    })
  );
}

// Push the user's categories into the live registry every time they change, so the
// dropdowns and class lookups stay in step without a reload.
function applyCustomCategories() {
  registerCustomCategories(store.getState().customCategories);
  const sel = $('#nr-cat');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = Object.keys(CATEGORIES)
      .map((c) => `<option${c === cur ? ' selected' : ''}>${escapeHtml(c)}</option>`)
      .join('');
  }
}

const TRIAGE_LIMIT = 25;

// Selection lives outside render(): setting a rule re-renders the whole panel, and
// losing your ticks every time would make bulk work impossible.
const selected = new Set();
let lastTicked = null; // for shift-click ranges

/**
 * Which account(s) a name's transactions came from. Someone can appear in both —
 * paid by M-PESA sometimes, by bank transfer other times — and seeing "Both" is a
 * hint about the relationship (and about which statement to go looking in).
 */
function acctChips({ mpesa, bank }) {
  const chips = [];
  if (mpesa) chips.push(`<span class="acct acct-mpesa">M-PESA${bank ? ` ${mpesa}` : ''}</span>`);
  if (bank) chips.push(`<span class="acct acct-bank">Bank${mpesa ? ` ${bank}` : ''}</span>`);
  return chips.join('');
}

/** "13 Jun" — or "13 Jun 25" once the year stops being obvious. */
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: '2-digit' }),
  });
}

/**
 * How the transactions sit in time — a one-off reads differently from someone you've
 * paid across six months, and that's often what identifies them.
 */
function span(first, last) {
  if (!first || !last) return '';
  if (first.slice(0, 10) === last.slice(0, 10)) return `on ${shortDate(first)}`;
  return `${shortDate(first)} → ${shortDate(last)}`;
}

// Everything the app has no rule for, grouped by the person/merchant name rather
// than the raw counterparty — the same name arrives under several masked numbers,
// and asking you to categorise the same person three times would be absurd.
function renderTriage(txns) {
  const groups = new Map();
  for (const t of txns) {
    if (t.category !== 'Uncategorised') continue;
    const name = personName(t.counterparty);
    if (!name) continue;
    const g = groups.get(name) || { name, count: 0, variants: new Set() };
    g.count++;
    g.variants.add(t.counterparty);
    groups.set(name, g);
  }

  // Totals come from the FULL ledger for each name, not just its uncategorised rows.
  // Money coming back from someone is typed "Receive Money" and lands in Income, so
  // counting only uncategorised rows would hide every repayment — and "money came
  // back" is exactly the signal that says this is lending rather than spending.
  const all = [...groups.values()]
    .map((g) => {
      const l = store.ledgerFor(g.name);
      return { ...g, out: l.out, in: l.in, total: l.count, first: l.first, last: l.last, mpesa: l.mpesa, bank: l.bank };
    })
    .sort((a, b) => b.out - a.out);
  const card = $('#triage-card');
  card.hidden = all.length === 0;
  if (!all.length) return;

  const shown = all.slice(0, TRIAGE_LIMIT);
  const rest = all.length - shown.length;
  const totalOut = all.reduce((a, g) => a + g.out, 0);
  setBadge('#triage-badge', `${all.length} names · ${viz.fmt(totalOut)} unassigned`, true);
  const shownOut = shown.reduce((a, g) => a + g.out, 0);
  const opts = Object.keys(CATEGORIES).filter((c) => c !== 'Uncategorised');

  // Where the unassigned money actually sits, counted over the uncategorised rows
  // themselves rather than each name's whole ledger.
  let uncatMpesa = 0;
  let uncatBank = 0;
  for (const t of txns) {
    if (t.category !== 'Uncategorised') continue;
    if ((t.accountSource || 'mpesa') === 'bank') uncatBank++;
    else uncatMpesa++;
  }
  const split = uncatBank
    ? ` · <span class="acct acct-mpesa">M-PESA ${uncatMpesa}</span><span class="acct acct-bank">Bank ${uncatBank}</span>`
    : ' · all from M-PESA';

  // Drop ticks for names that are gone (just categorised, or filtered out).
  const present = new Set(shown.map((g) => g.name));
  for (const n of [...selected]) if (!present.has(n)) selected.delete(n);

  const opts2 = opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('');

  $('#triage').innerHTML = `
    <p class="hint note"><strong>${all.length} name${all.length === 1 ? '' : 's'}</strong> ·
      ${viz.fmt(totalOut)} unassigned${rest > 0 ? ` · showing the top ${shown.length} (${viz.fmt(shownOut)} of it)` : ''}${split}</p>
    <div id="bulk-bar" class="bulk-bar" ${selected.size ? '' : 'hidden'}>
      <strong id="bulk-count"></strong>
      <select id="bulk-cat" aria-label="Category for selected names">${opts2}</select>
      <button id="bulk-apply" class="primary">Apply to selected</button>
      <button id="bulk-clear" class="ghost">Clear</button>
    </div>
    <table class="mini triage-table">
      <thead><tr>
        <th class="tick"><input type="checkbox" id="tick-all" aria-label="Select all shown"></th>
        <th>Name</th><th class="num">Sent</th><th class="num">Back</th><th class="num">Last</th><th>Category</th>
      </tr></thead>
      <tbody>${shown
        .map(
          (g) => `<tr${selected.has(g.name) ? ' class="picked"' : ''}>
          <td class="tick"><input type="checkbox" class="tick-row" data-name="${escapeHtml(g.name)}"${
            selected.has(g.name) ? ' checked' : ''
          } aria-label="Select ${escapeHtml(g.name)}"></td>
          <td>
            <strong>${escapeHtml(g.name)}</strong>
            <div class="dim small">
              ${acctChips(g)}${g.total} txn${g.total === 1 ? '' : 's'}${
                span(g.first, g.last) ? ` · ${span(g.first, g.last)}` : ''
              }${g.variants.size > 1 ? ` · ${g.variants.size} number variants` : ''}${
                g.in > 0.5 ? ' · <span class="in">money came back — lending?</span>' : ''
              }
            </div>
          </td>
          <td class="num">${g.out ? viz.fmt(g.out) : '—'}</td>
          <td class="num ${g.in > 0.5 ? 'in' : 'dim'}">${g.in ? viz.fmt(g.in) : '—'}</td>
          <td class="num nowrap" title="${g.last ? new Date(g.last).toLocaleString('en-GB') : ''}">${shortDate(g.last)}</td>
          <td>
            <select class="cat triage-cat" data-name="${escapeHtml(g.name)}">
              <option value="">— pick —</option>
              ${opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}
            </select>
          </td>
        </tr>`
        )
        .join('')}</tbody>
    </table>
    ${rest > 0 ? `<p class="hint">${rest} smaller name${rest === 1 ? '' : 's'} not shown — assign these and they'll move up.</p>` : ''}`;

  $('#triage').querySelectorAll('select.triage-cat').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const name = sel.dataset.name;
      store.addNameRule(name, sel.value);
      const l = store.ledgerFor(name);
      render();
      renderNameRules();
      toast(`“${name}” → ${sel.value}. ${l.count} transaction${l.count === 1 ? '' : 's'} moved.`);
    });
  });

  wireBulk(shown);
}

function wireBulk(shown) {
  const order = shown.map((g) => g.name);
  const bar = $('#bulk-bar');
  const count = $('#bulk-count');

  const refresh = () => {
    bar.hidden = selected.size === 0;
    const value = [...selected].reduce((a, n) => a + store.ledgerFor(n).out, 0);
    count.textContent = `${selected.size} selected · ${viz.fmt(value)}`;
    $('#triage')
      .querySelectorAll('tr')
      .forEach((tr) => {
        const cb = tr.querySelector('.tick-row');
        if (cb) tr.classList.toggle('picked', selected.has(cb.dataset.name));
      });
    const allOn = order.length > 0 && order.every((n) => selected.has(n));
    const someOn = order.some((n) => selected.has(n));
    const head = $('#tick-all');
    head.checked = allOn;
    head.indeterminate = someOn && !allOn;
  };

  $('#triage')
    .querySelectorAll('.tick-row')
    .forEach((cb) => {
      cb.addEventListener('click', (e) => {
        const name = cb.dataset.name;
        const i = order.indexOf(name);
        // Shift-click fills the range — the point of bulk is not clicking 25 times.
        if (e.shiftKey && lastTicked !== null) {
          const [a, b] = [Math.min(lastTicked, i), Math.max(lastTicked, i)];
          for (let k = a; k <= b; k++) {
            if (cb.checked) selected.add(order[k]);
            else selected.delete(order[k]);
          }
          $('#triage')
            .querySelectorAll('.tick-row')
            .forEach((o) => (o.checked = selected.has(o.dataset.name)));
        } else if (cb.checked) selected.add(name);
        else selected.delete(name);
        lastTicked = i;
        refresh();
      });
    });

  $('#tick-all').addEventListener('change', (e) => {
    if (e.target.checked) order.forEach((n) => selected.add(n));
    else order.forEach((n) => selected.delete(n));
    $('#triage')
      .querySelectorAll('.tick-row')
      .forEach((o) => (o.checked = selected.has(o.dataset.name)));
    lastTicked = null;
    refresh();
  });

  $('#bulk-clear').addEventListener('click', () => {
    selected.clear();
    $('#triage')
      .querySelectorAll('.tick-row')
      .forEach((o) => (o.checked = false));
    refresh();
  });

  $('#bulk-apply').addEventListener('click', () => {
    const cat = $('#bulk-cat').value;
    const names = [...selected];
    if (!names.length) return;
    let moved = 0;
    for (const n of names) {
      store.addNameRule(n, cat);
      moved += store.ledgerFor(n).count;
    }
    selected.clear();
    lastTicked = null;
    render();
    renderNameRules();
    toast(`${names.length} name${names.length === 1 ? '' : 's'} → ${cat}. ${moved} transaction${moved === 1 ? '' : 's'} moved.`);
  });

  refresh();
}

function renderNameRules() {
  const { nameRules } = store.getState();
  const el = $('#nr-list');
  const owed = nameRules
    .filter((r) => r.category === 'Money Lent')
    .reduce((a, r) => a + Math.max(0, store.ledgerFor(r.match).net), 0);
  setBadge(
    '#people-badge',
    nameRules.length ? `${nameRules.length} rule${nameRules.length === 1 ? '' : 's'}${owed > 0.5 ? ` · ${viz.fmt(owed)} owed to you` : ''}` : '',
    owed > 0.5
  );

  if (!nameRules.length) {
    el.innerHTML = '<p class="hint">No name rules yet.</p>';
    return;
  }
  el.innerHTML = `<table class="mini">
      <thead><tr>
        <th>Name</th><th>Category</th>
        <th class="num">Sent</th><th class="num">Back</th><th class="num">Net</th><th class="num">Last</th><th></th>
      </tr></thead>
      <tbody>${nameRules
        .map((r) => {
          const l = store.ledgerFor(r.match);
          // A rule whose name contains another rule's name is narrower, so it wins.
          // The reverse — a broad rule that no longer catches anything because more
          // specific rules cover all of it — is worth saying out loud rather than
          // leaving someone to wonder why their rule "did nothing".
          const covers = nameRules.filter(
            (o) => o !== r && o.match.toLowerCase().includes(r.match.toLowerCase())
          );
          // For a lending relationship the net is the point: positive means still
          // owed to you, negative means they've returned more than you sent.
          const owed = l.net > 0.5;
          const settled = Math.abs(l.net) <= 0.5;
          const netCls = l.net > 0.5 ? 'owed' : l.net < -0.5 ? 'in' : 'dim';
          return `<tr>
          <td>
            <strong>${escapeHtml(r.match)}</strong>
            <div class="dim small">${l.count} txns${
              covers.length
                ? ` · <span class="shadow" title="More specific rules take priority">${covers
                    .map((c) => escapeHtml(c.match))
                    .join(', ')} overrides this</span>`
                : ''
            }</div>
          </td>
          <td class="dim">${escapeHtml(r.category)}</td>
          <td class="num dim">${l.out ? viz.fmt(l.out) : '—'}</td>
          <td class="num dim">${l.in ? viz.fmt(l.in) : '—'}</td>
          <td class="num ${netCls}">${
            settled && l.count ? 'settled' : l.net > 0.5 ? viz.fmt(l.net) : l.net < -0.5 ? '+' + viz.fmt(-l.net) : '—'
          }</td>
          <td class="num nowrap dim" title="${l.last ? new Date(l.last).toLocaleString('en-GB') : ''}">${shortDate(l.last)}</td>
          <td class="num"><button class="link-btn" data-rm="${escapeHtml(r.match)}" title="Remove rule">✕</button></td>
        </tr>`;
        })
        .join('')}</tbody></table>
      <p class="hint">“Net” is what's still out: a figure means they owe you that much, <span class="in">+n</span> means they've sent back more than you sent, “settled” means square. Tag someone <strong>Money Lent</strong> and neither direction counts as spending or income.</p>`;

  el.querySelectorAll('button[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      store.removeNameRule(b.dataset.rm);
      render();
      renderNameRules();
    })
  );
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function applyFilters(txns) {
  const q = state.search.trim().toLowerCase();
  // The SAME rule every report uses to decide which month a transaction belongs to.
  // Filtering by calendar date instead was why clicking a row in the monthly report
  // could return nothing: the report counts by pay cycle, so a 29 July payment sits in
  // August — and a calendar-month filter looked for it in July and found nothing.
  const monthOfTxn = monthResolver(txns);
  return txns.filter((t) => {
    // Category + month together, so a split payment assigned to another budget month
    // shows up when you drill THAT month. A slice matches if its category fits the
    // filter AND its month is the drilled one — its own if the slice was assigned one,
    // otherwise the transaction's.
    if (state.drillMonth || state.catFilter !== 'all') {
      const parts =
        t.splits && t.splits.length ? t.splits : [{ category: t.category, month: null }];
      const monthOf = (p) => p.month || monthOfTxn(t);
      const hit = parts.some(
        (p) =>
          (state.catFilter === 'all' || p.category === state.catFilter) &&
          (!state.drillMonth || monthOf(p) === state.drillMonth)
      );
      if (!hit) return false;
    }
    if (state.dirFilter !== 'all' && t.direction !== state.dirFilter) return false;
    // Anything without an explicit source predates the bank importer and is M-PESA.
    if (state.acctFilter !== 'all' && (t.accountSource || 'mpesa') !== state.acctFilter) return false;
    if (!q) return true;
    return `${t.counterparty} ${t.receipt} ${t.account || ''} ${t.type}`.toLowerCase().includes(q);
  });
}

// Only offer categories that are actually present, so the filter never lands on
// an empty list.
function refreshCategoryFilter(txns) {
  const sel = $('#cat-filter');
  const present = [...new Set(txns.map((t) => t.category))].sort();
  const cur = state.catFilter;
  sel.innerHTML =
    '<option value="all">All categories</option>' +
    present.map((c) => `<option${c === cur ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  if (cur !== 'all' && !present.includes(cur)) {
    state.catFilter = 'all';
    sel.value = 'all';
  }
}

// Built from what's actually imported — the list of banks isn't fixed, and hard-coding
// it meant a new one arrived invisible.
function refreshAccountFilter(txns) {
  const sel = $('#acct-filter');
  const present = [...new Set(txns.map((t) => t.accountSource || 'mpesa'))].sort();
  const cur = state.acctFilter;
  sel.innerHTML =
    '<option value="all">All accounts</option>' +
    present
      .map((a) => `<option value="${a}"${a === cur ? ' selected' : ''}>${escapeHtml(ACCOUNT_LABELS[a] || a)}</option>`)
      .join('');
  if (cur !== 'all' && !present.includes(cur)) {
    state.acctFilter = 'all';
    sel.value = 'all';
  }
}

/**
 * Make anything carrying data-drill-cat / data-drill-name filter the table to it.
 * A chart that shows one big "Groceries" bar and can't tell you what's inside is a
 * dead end — every number should be a question you can follow.
 */
function wireDrill(root, scopeMonth) {
  root.querySelectorAll('[data-drill-cat], [data-drill-name]').forEach((el) => {
    const go = () => {
      const cat = el.dataset.drillCat;
      const name = el.dataset.drillName;
      if (cat) {
        state.catFilter = cat;
        state.search = '';
      }
      if (name) {
        state.search = name;
        state.catFilter = 'all';
      }
      // Drilling from the monthly report or the budget means "in that month" —
      // otherwise you'd click June's Groceries and get every month's.
      state.drillMonth =
        scopeMonth !== undefined ? scopeMonth : root.id === 'month-report' ? state.month : null;
      state.dirFilter = 'all';
      render();
      const table = $('#table-txns');
      $('details[data-panel="txns"]').open = true;
      table.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(`Showing ${cat || name}${state.drillMonth ? ` in ${monthLabel(state.drillMonth)}` : ''}. Clear the filters to go back.`);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
}

const PANEL_KEY = 'mpesa-tracker.panels';
/* The two pages are one app at one origin; these are how they hand figures to
   each other without either having to recompute the other's work. */
const TRACKER_GLANCE = 'mpesa-tracker.glance';
const BASKET_GLANCE = 'basket.glance';
const BASKET_RECEIPTS = 'basket-receipts-v1';
const BASKET_PULLED = 'mpesa-tracker.basket-pulled';

// Remember which panels are open. Without this, every rule you set re-renders and
// the page springs back to its defaults, which is maddening mid-triage.
function wirePanels() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}');
  } catch {
    saved = {};
  }

  document.querySelectorAll('details.card[data-panel]').forEach((d) => {
    const key = d.dataset.panel;
    if (key in saved) d.open = saved[key];
    // An empty app is all intake and nothing else, so that one panel opens itself
    // the first time. Once there is anything on file it closes, because reaching
    // the figures should not mean scrolling past a textarea and a file picker.
    else if (key === 'intake' && !store.allTransactions().length) d.open = true;
    d.addEventListener('toggle', () => {
      saved[key] = d.open;
      try {
        localStorage.setItem(PANEL_KEY, JSON.stringify(saved));
      } catch {
        // Not worth interrupting anyone over; the panel still opened.
      }
    });
  });
}

/** A summary line for panels that are closed — collapsed shouldn't mean invisible. */
function setBadge(id, text, alert = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('alert', !!alert && !!text);
}

function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  setTimeout(() => (el.className = 'toast'), 4000);
}

/**
 * Shows what could not be read, grouped by wording.
 *
 * It used to print every failed message in full, one after another. With an inbox
 * behind it that is several hundred blocks of monospace on the home page, which
 * tells you nothing you can act on and buries everything below it. The same
 * failures grouped by shape are five or six lines, and the count is the part that
 * matters: it says which wording is worth teaching the parser next.
 */
function showUnparsed(list, ignored = 0) {
  const box = $('#unparsed');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = ignored
      ? `<p class="hint">${ignored} message${ignored === 1 ? ' was a notice' : 's were notices'} &mdash; balance checks and the like, not transactions.</p>`
      : '';
    return;
  }
  const esc = (t) => String(t).replace(/[<>&]/g, '');
  box.innerHTML = `
    <details class="unread">
      <summary><b>${list.length} message${list.length === 1 ? '' : 's'} not recognised</b> &mdash; nothing was dropped silently</summary>
      <p class="hint">Grouped by wording. The counts say which one is worth teaching the app next.</p>
      <ul class="unread-list">
        ${groupUnparsed(list)
          .map((g) => `<li><span class="unread-n">${g.count}&times;</span><pre>${esc(g.sample).slice(0, 220)}</pre></li>`)
          .join('')}
      </ul>
      ${ignored ? `<p class="hint">${ignored} more ${ignored === 1 ? 'was a notice' : 'were notices'} &mdash; balance checks and the like, not transactions.</p>` : ''}
    </details>`;
}

function handlePaste() {
  const raw = $('#sms-input').value;
  if (!raw.trim()) return;

  const { transactions, unparsed, ignored } = parseMessages(raw);
  if (!transactions.length) {
    toast('Could not read any M-PESA messages in that text.', 'warn');
    showUnparsed(unparsed, ignored);
    return;
  }
  const { added, duplicate } = store.addTransactions(transactions);
  $('#sms-input').value = '';
  render();

  let msg = `Added ${added} transaction${added === 1 ? '' : 's'}.`;
  if (duplicate) msg += ` ${duplicate} already on file, skipped.`;
  if (unparsed.length) msg += ` ${unparsed.length} message(s) not recognised.`;
  toast(msg, unparsed.length ? 'warn' : 'ok');

  showUnparsed(unparsed, ignored);
}

async function handlePDF(file) {
  const pw = $('#pdf-password').value;
  if (!pw) {
    toast('Statement PDFs are password-protected — enter yours first.', 'warn');
    return;
  }
  toast('Reading statement…');
  try {
    const { importPDF } = await import('./import.js');
    const buf = await file.arrayBuffer();
    const { transactions, text, pages, kind, label, unresolved, reconciled } = await importPDF(buf, pw);
    let named = 0;

    if (!transactions.length) {
      // Decrypted fine but matched no rows: the layout differs from what's expected.
      // Show what the parser actually saw — a bare "0 rows" is impossible to act on.
      $('#unparsed').innerHTML =
        `<strong>Opened ${pages} page(s) but matched no transaction rows.</strong>
         <p>This is what the parser read — the row format must differ from the expected
         <code>Receipt · Time · Details · Status · Amount · Balance</code>:</p>
         <pre>${text.slice(0, 700).replace(/[<>&]/g, '')}</pre>`;
      toast('No transaction rows found — see the diagnostic panel above.', 'warn');
      return;
    }

    $('#unparsed').innerHTML = '';
    const res = store.addTransactions(transactions);
    const { added, duplicate } = res;
    named = res.named;
    render();

    let msg = `${label} statement imported: ${added} new, ${duplicate} already on file.`;
    if (named) msg += ` Named ${named} row(s) from your M-PESA contacts.`;
    // Most bank layouts carry no +/- sign; direction comes from the running balance.
    // `reconciled === null` means the statement declares nothing to check against
    // (the KCB mini statement) — that's different from failing, and saying "checked"
    // when nothing was checked would be a lie.
    if (reconciled === false) {
      msg += ` ⚠ ${unresolved} row(s) didn't reconcile against the running balance — check their direction.`;
      toast(msg, 'warn');
    } else if (reconciled === true) {
      toast(`${msg} Balance reconciled.`);
    } else {
      toast(`${msg} (This statement prints no totals, so there's nothing to check it against.)`);
    }
  } catch (err) {
    const msg = /password/i.test(err.message) ? 'Wrong statement password.' : `Could not read that PDF: ${err.message}`;
    toast(msg, 'warn');
  } finally {
    $('#pdf-password').value = '';
  }
}

function wire() {
  $('#btn-add').addEventListener('click', handlePaste);
  $('#sms-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePaste();
  });

  $('#pdf-file').addEventListener('change', (e) => {
    if (e.target.files[0]) handlePDF(e.target.files[0]);
    e.target.value = '';
  });

  $('#range').addEventListener('change', (e) => {
    state.range = e.target.value;
    render();
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    // Debounced: re-rendering ~1,100 rows on every keystroke is visibly janky.
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.search = v;
      render();
    }, 120);
  });

  $('#cat-filter').addEventListener('change', (e) => {
    state.catFilter = e.target.value;
    render();
  });

  $('#dir-filter').addEventListener('change', (e) => {
    state.dirFilter = e.target.value;
    render();
  });

  $('#acct-filter').addEventListener('change', (e) => {
    state.acctFilter = e.target.value;
    render();
  });

  // A CSV of the selected month: totals, categories, then every transaction. Excel
  // opens it directly, which is where this data came from.
  $('#btn-export-month').addEventListener('click', () => {
    const all = decorate(store.allTransactions());
    const m = state.month;
    const { now } = compareMonths(all, m);
    // Same month rule as the header totals above (pay cycle, not calendar) — otherwise
    // the file's own summary says 135 transactions and then lists 60 of them.
    const monthOf = monthResolver(all);
    const rows = all.filter((t) => t.date && monthOf(t) === m).sort((a, b) => (a.date < b.date ? -1 : 1));
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csv = [
      [q(`M-PESA Tracker — ${monthLabel(m)}`)],
      [],
      [q('Spent'), now.spent.toFixed(2)],
      [q('Received'), now.income.toFixed(2)],
      [q('Net'), now.net.toFixed(2)],
      [q('Fees'), now.fees.toFixed(2)],
      [q('Moved / repaid'), now.transfers.toFixed(2)],
      [],
      [q('Category'), q('Total'), q('Transactions')],
      ...now.categories.map((c) => [q(c.category), c.total.toFixed(2), c.count]),
      [],
      [q('Date'), q('Account'), q('Direction'), q('Amount'), q('Category'), q('Counterparty'), q('Type'), q('Receipt'), q('Balance')],
      ...rows.map((t) => [
        q(t.date ? new Date(t.date).toLocaleString('en-GB') : ''),
        q(t.accountSource || 'mpesa'),
        q(t.direction),
        t.amount.toFixed(2),
        q(t.category),
        q(t.counterparty),
        q(t.type),
        q(t.receipt || ''),
        t.balance != null ? t.balance.toFixed(2) : '',
      ]),
    ]
      .map((r) => r.join(','))
      .join('\n');

    // BOM so Excel reads UTF-8 and doesn't mangle the names.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mpesa-${m}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${monthLabel(m)} — ${rows.length} transactions.`);
  });

  $('#btn-print').addEventListener('click', () => {
    // Open every panel first: print CSS can't reveal a collapsed <details>.
    document.querySelectorAll('details.card').forEach((d) => (d.open = true));
    setTimeout(() => window.print(), 60);
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mpesa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Sharing a file beats downloading one on a phone: a download lands in a folder you
  // then have to find and move. The share sheet puts it straight into WhatsApp, Drive
  // or email, which is how it reaches the laptop.
  const shareBtn = $('#btn-share');
  const backupFile = () =>
    new File([store.exportJSON()], `mpesa-backup-${new Date().toISOString().slice(0, 10)}.json`, {
      type: 'application/json',
    });
  if (navigator.canShare && navigator.canShare({ files: [backupFile()] })) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [backupFile()], title: 'M-PESA Tracker backup' });
      } catch (err) {
        // AbortError just means they closed the sheet — not worth a message.
        if (err.name !== 'AbortError') toast(`Couldn't share: ${err.message}`, 'warn');
      }
    });
  }

  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = store.importJSON(await f.text());
      store.applySettings();
      applyCustomCategories();
      render();
      renderNameRules();
      renderCategories();
      renderSettings();

      // Say what actually happened. "Backup restored" hides whether it brought in
      // anything at all — and merging is exactly when you want to know.
      const bits = [];
      if (r.added) bits.push(`${r.added} new transaction${r.added === 1 ? '' : 's'}`);
      if (r.duplicate) bits.push(`${r.duplicate} already here`);
      if (r.nameRules) bits.push(`${r.nameRules} name rule${r.nameRules === 1 ? '' : 's'}`);
      if (r.categories) bits.push(`${r.categories} categor${r.categories === 1 ? 'y' : 'ies'}`);
      if (r.payables) bits.push('debts merged');
      if (r.settingsMerged) bits.push('settings merged');
      toast(bits.length ? `Merged: ${bits.join(', ')}.` : 'Nothing new in that file — everything was already here.');
    } catch (err) {
      toast(err.message, 'warn');
    }
    e.target.value = '';
  });

  // Categories
  const addCat = () => {
    const name = $('#cat-name').value.trim();
    const res = store.addCategory(name, $('#cat-class').value);
    if (!res.ok) {
      toast(res.error, 'warn');
      return;
    }
    $('#cat-name').value = '';
    applyCustomCategories();
    render();
    renderCategories();
    toast(`Added “${res.name}” — it's in every dropdown now.`);
  };
  $('#cat-add').addEventListener('click', addCat);
  $('#cat-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addCat();
  });

  // Name rules
  $('#nr-cat').innerHTML = Object.keys(CATEGORIES)
    .map((c) => `<option${c === 'Family' ? ' selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');

  const preview = () => {
    const v = $('#nr-name').value.trim();
    const el = $('#nr-preview');
    if (!v) {
      el.textContent = '';
      return;
    }
    // Show the reach before committing — a fragment like "an" would silently swallow
    // half the ledger, and the count makes that obvious rather than surprising.
    const l = store.ledgerFor(v);
    if (!l.count) {
      el.textContent = `“${v}” matches nothing yet — the rule will still apply to future transactions.`;
      return;
    }
    // Surface the two-way picture up front: if money has come back, this is probably
    // a lending relationship rather than plain spending.
    const back = l.in > 0.5 ? ` — you sent ${viz.fmt(l.out)}, ${viz.fmt(l.in)} came back` : '';
    el.textContent = `“${v}” matches ${l.count} transaction${l.count === 1 ? '' : 's'}${back}.`;
  };
  $('#nr-name').addEventListener('input', preview);

  const addRule = () => {
    const name = $('#nr-name').value.trim();
    const cat = $('#nr-cat').value;
    const res = store.addNameRule(name, cat);
    if (!res.ok) {
      toast(res.error, 'warn');
      return;
    }
    const n = store.countMatching(name);
    $('#nr-name').value = '';
    $('#nr-preview').textContent = '';
    render();
    renderNameRules();
    toast(`“${name}” → ${cat}. ${n} transaction${n === 1 ? '' : 's'} recategorised.`);
  };
  $('#nr-add').addEventListener('click', addRule);
  $('#nr-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addRule();
  });

  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    render(); // charts pick colors per-mode, so they must be redrawn
  });

  $('#btn-reset').addEventListener('click', () => {
    if (confirm('Delete all transactions and rules from this browser? Export a backup first if you want to keep them.')) {
      store.reset();
      location.reload();
    }
  });
}

/**
 * An SMS shared into the app from the phone's share sheet arrives as ./?text=…
 *
 * A browser can't read your inbox — no web API exists for it — so this is as close
 * as it gets: the message arrives by your choosing rather than being harvested.
 */
function handleShared() {
  const p = new URLSearchParams(location.search);
  const shared = [p.get('text'), p.get('title'), p.get('url')].filter(Boolean).join('\n');
  if (!shared.trim()) return;

  // Strip it from the address bar so a reload doesn't add the same thing twice.
  // (Dedupe would catch it anyway, but the toast lying "added 1" would not.)
  history.replaceState(null, '', location.pathname);

  const { transactions, unparsed } = parseMessages(shared);
  if (!transactions.length) {
    $('#sms-input').value = shared;
    $('details[data-panel="intake"]').open = true;
    toast("Shared, but I couldn't read an M-PESA message in it. It's in the box above.", 'warn');
    return;
  }
  const { added, duplicate } = store.addTransactions(transactions);
  render();
  toast(
    added
      ? `Added ${added} transaction${added === 1 ? '' : 's'} from the shared message.${
          unparsed.length ? ` ${unparsed.length} bit(s) not recognised.` : ''
        }`
      : `Already had that one — nothing double-counted.`
  );
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // In the Android app every asset is already local, so a worker would only be
  // a second cache standing between an update and the page.
  if (window.Android) return;
  // Needs a secure context: https, or localhost. Over a plain LAN IP the browser
  // refuses, which is also why the app can't be installed that way.
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err.message));
}

async function init() {
  startTheme();

  store.load();
  // Identity must reach config before anything parses or categorises — isSelf() and
  // the small-send limit are consulted during the very first render.
  store.applySettings();
  // Catch data imported before this existed, and any pairing a later import enabled.
  store.resolveIdentities();
  // Custom categories must land in the registry before the first render, or the
  // dropdowns build without them and a stored rule would point at a missing option.
  registerCustomCategories(store.getState().customCategories);
  // No seed data. It used to ship the 89 rows from the original xlsx, but those are
  // a strict subset of the real statement — and its charge ids used a different
  // suffix scheme, so one row survived dedupe as a phantom. Statements are the
  // source of truth; the app starts empty and you import.
  wirePanels();
  wire();
  wireSettings();
  wireSms();
  wireUpdates();
  // Basket's receipts live at this same origin now, so they are simply read.
  pullBasketReceipts();
  render();
  renderNameRules();
  renderCategories();
  renderSettings();
  wireBasket();
  renderBasket();

  handleShared();
  registerSW();

  // First run: the identity panel is the one thing that must be filled in, so open it.
  if (!isConfigured()) {
    $('#settings-card').open = true;
    $('#settings-card').scrollIntoView({ block: 'center' });
  }
}


/* ---- The home screen ----------------------------------------------------- */
/*
 * One card, answering the only question that matters on opening the app: how
 * much of this month's money is left. Every figure is budgetReport's, the same
 * one the Budget panel uses - a home screen that disagreed with the panel
 * below it would be worse than no home screen.
 */

/* Pay lands on the 28th, so a month runs from the 28th to the 27th. salary.js
 * works the real boundary out from the statements; this is the fallback for a
 * device with no pay on file yet, and it matches how Basket counts. */
const PAY_DAY = 28;

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function shiftDay(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthOn(iso, step) {
  const [y, m] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1 + step, 1, 12));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${iso.slice(8)}`;
}

/** The cycle today sits in, by the 28th rule. */
function cycleFromDay(todayIso) {
  const start = todayIso.slice(0, 8) + String(PAY_DAY).padStart(2, '0');
  return +todayIso.slice(8) < PAY_DAY ? monthOn(start, -1) : start;
}

/**
 * The days a budget month covers: payday to the day before the next payday.
 * Shown because a figure for "this month" you can't see the edges of is one
 * you can't check.
 */
function cycleBounds(all, cycleStart, todayIso) {
  const from = (cycleStart || cycleFromDay(todayIso)).slice(0, 10);
  const later = payCycles(all)
    .map((c) => String(c.start || '').slice(0, 10))
    .filter((d) => d > from)
    .sort()[0];
  return { from, to: shiftDay(later || monthOn(from, 1), -1) };
}

function renderHome(all) {
  const now = new Date();
  const todayIso = isoDay(now);
  // Which month today belongs to - the same question the reports ask of every
  // transaction, so the answer is the same resolver.
  const month = monthResolver(all)({ date: `${todayIso}T12:00:00` }) || todayIso.slice(0, 7);
  const { report, budgeted, spent, outside, cycleStart } = budgetReport(store.budgets(), all, month);
  const { from, to } = cycleBounds(all, cycleStart, todayIso);

  const name = (store.settings().name || '').trim();
  const hour = now.getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#home-greet').textContent = name ? `${part}, ${name}` : part;
  $('#home-today').textContent = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const days = Math.max(0, Math.round((Date.parse(to) - Date.parse(todayIso)) / 86400000));
  $('#hero-cycle').textContent = `${monthLabel(month)} · ${shortDate(from)} – ${shortDate(to)}`;
  $('#hero-days').textContent = days === 0 ? 'last day' : `${days} day${days === 1 ? '' : 's'} left`;

  if (budgeted > 0) {
    const left = budgeted - spent;
    $('#hero-left').textContent = viz.fmt(Math.abs(left));
    $('#hero-sub').textContent =
      left >= 0
        ? `left of your ${viz.fmt(budgeted)} across every category`
        : `over your ${viz.fmt(budgeted)} for this month`;
    $('#hero-fill').style.width = `${Math.min(100, (spent / budgeted) * 100)}%`;
  } else {
    // No budget yet. Showing "0 left of 0" would be a confident lie, so the
    // card answers the question it still can: what has gone out this month.
    $('#hero-left').textContent = viz.fmt(spent + outside);
    $('#hero-sub').textContent = 'spent this month — set a budget below to see what is left';
    $('#hero-fill').style.width = '0%';
  }

  renderBasketRow();
  publishGlance(month, from, to, budgeted, spent, report.find((r) => r.id === 'food'));
}

/** What Basket itself says is in the trolley. It writes this; here it is read. */
function basketGlance() {
  try {
    return JSON.parse(localStorage.getItem(BASKET_GLANCE) || 'null');
  } catch (e) {
    return null;
  }
}

function renderBasketRow() {
  const glance = basketGlance();
  const kept = store.receipts().length;
  const bits = [];
  if (glance && glance.items) bits.push(`${glance.items} in the trolley`);
  bits.push(kept ? `${kept} receipt${kept === 1 ? '' : 's'} kept` : 'scan a receipt');
  $('#bskt-sub').textContent = bits.join(' · ');
  $('#bskt-total').textContent = glance && glance.total > 0 ? viz.fmt(glance.total) : '';
}

/**
 * The Groceries line, written where Basket can read it.
 *
 * Basket shows what is left to spend on food this month, and that figure has
 * to count every shop M-PESA paid for - not only the slips that were scanned.
 * Working that out needs this page's whole pipeline, so it is computed once
 * here rather than approximated twice.
 */
function publishGlance(month, from, to, budgeted, spent, groceries) {
  try {
    localStorage.setItem(
      TRACKER_GLANCE,
      JSON.stringify({
        at: new Date().toISOString(),
        month,
        cycleFrom: from,
        cycleTo: to,
        totalBudget: budgeted,
        totalSpent: spent,
        groceriesBudget: groceries ? groceries.amount : 0,
        groceriesSpent: groceries ? groceries.spent : 0,
      })
    );
  } catch (e) {
    /* Private browsing, or a full quota. The page still works. */
  }
}

/**
 * Takes in the receipts Basket has saved on this device.
 *
 * Both pages are served from one origin now, which is the whole reason for
 * merging them: no clipboard, no "Copy everything", nothing to remember. Each
 * id is taken once, so a receipt deleted here does not come back on the next
 * load.
 */
function pullBasketReceipts() {
  let saved = null;
  let pulled = [];
  try {
    saved = JSON.parse(localStorage.getItem(BASKET_RECEIPTS) || 'null');
    pulled = JSON.parse(localStorage.getItem(BASKET_PULLED) || '[]');
  } catch (e) {
    return 0;
  }
  if (!Array.isArray(saved) || !saved.length) return 0;
  const already = new Set(Array.isArray(pulled) ? pulled : []);

  const fresh = saved
    .filter((r) => r && r.date && Array.isArray(r.items) && !already.has(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      date: String(r.date).slice(0, 10),
      slipTotal: r.slipTotal == null ? null : +r.slipTotal,
      items: r.items.map((i) => ({
        name: String(i.name || 'Item'),
        qty: Math.max(1, +i.qty || 1),
        price: +i.price || 0,
      })),
    }));
  if (!fresh.length) return 0;

  store.importReceipts(fresh);
  // Match each shop to the payment that settled it, as the paste route does.
  store.setReceiptLinks(basket.matchAll(store.receipts(), store.allTransactions()));
  try {
    localStorage.setItem(BASKET_PULLED, JSON.stringify([...already, ...fresh.map((r) => r.id)]));
  } catch (e) {
    /* Not fatal: at worst a deleted receipt reappears once. */
  }
  return fresh.length;
}

/* ---- Light or dark, for the whole app ------------------------------------ */
/*
 * One key for both pages. Switching the theme in Basket and finding the
 * tracker still light is exactly the sort of seam that gives away two apps
 * bolted together. The old per-page keys are read once so nothing resets.
 */
const THEME_KEY = 'budget-theme';

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  $('#btn-theme').textContent = mode === 'dark' ? '◑' : '◐';
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch (e) {
    /* private browsing */
  }
  // The status and navigation bars are Android's, so they have to be told.
  try {
    if (window.Android && window.Android.setChrome) {
      window.Android.setChrome(mode === 'dark' ? '#000000' : '#F2F2F7', mode === 'dark');
    }
  } catch (e) {
    /* older build without the bridge */
  }
}

function startTheme() {
  let mode = null;
  try {
    mode =
      localStorage.getItem(THEME_KEY) ||
      localStorage.getItem('mpesa-theme') ||
      localStorage.getItem('basket-theme');
  } catch (e) {
    mode = null;
  }
  if (mode !== 'light' && mode !== 'dark') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(mode);
}

/* ---- Updating the app itself --------------------------------------------- */
/*
 * Only in the Android app, and only when asked: this is the one thing here that
 * touches the network. It lived on the Basket page alone, which stopped making
 * sense the moment the tracker became the page the app opens on.
 */
function wireUpdates() {
  let bridge = null;
  try {
    bridge = window.Android && window.Android.appVersion ? window.Android : null;
  } catch (e) {
    bridge = null;
  }
  $('#update-box').hidden = !bridge;
  if (!bridge) return;

  const msg = $('#update-msg');
  const install = $('#btn-install');
  try {
    msg.textContent = `Version ${bridge.appVersion()}.`;
  } catch (e) {
    msg.textContent = '';
  }

  // A bridge call that throws must say so. Swallowing one is how the install
  // button spent a release looking like it did nothing.
  $('#btn-update').addEventListener('click', () => {
    msg.textContent = 'Checking…';
    try {
      bridge.checkUpdate();
    } catch (e) {
      msg.textContent = `Could not check: ${e.message}`;
    }
  });
  install.addEventListener('click', () => {
    try {
      bridge.installUpdate();
    } catch (e) {
      msg.textContent = `Could not start the download: ${e.message}`;
    }
  });

  window.onUpdateStatus = (text, canInstall) => {
    msg.textContent = String(text);
    install.hidden = !canInstall;
  };
}

/* ---- M-PESA's own messages, off the phone -------------------------------- */
/*
 * The app has always been able to read these - they are what the paste box is
 * for. On a phone there is no need to paste: the inbox is right there, and
 * Android will hand it over once. Categorising then happens exactly as it
 * does for a statement, by the rules, with anything unknown landing in
 * "Needs categorising" rather than being guessed at.
 */
function wireSms() {
  let bridge = null;
  try {
    bridge = window.Android && window.Android.canReadSms && window.Android.canReadSms() ? window.Android : null;
  } catch (e) {
    bridge = null;
  }
  $('#sms-col').hidden = !bridge;
  if (!bridge) return;

  const note = $('#sms-note');
  const ask = (everything) => {
    note.textContent = 'Asking Android for the messages…';
    try {
      bridge.readSms(everything);
    } catch (e) {
      note.textContent = 'This build cannot read messages.';
    }
  };
  $('#btn-sms').addEventListener('click', () => ask(false));
  $('#btn-sms-all').addEventListener('click', () => ask(true));

  window.onSmsStatus = (message) => {
    note.textContent = String(message);
  };

  // The inbox arrives in batches, so the tally is kept across them and the
  // page is only re-rendered once at the end.
  let tally = { added: 0, duplicate: 0, unparsed: [], ignored: 0 };
  window.onSmsBatch = (text, done, found) => {
    if (text) {
      const { transactions, unparsed, ignored } = parseMessages(text);
      const counts = store.addTransactions(transactions);
      tally.added += counts.added;
      tally.duplicate += counts.duplicate;
      tally.unparsed.push(...unparsed);
      tally.ignored += ignored;
    }
    if (!done) {
      note.textContent = `Reading ${found} messages… ${tally.added} new so far.`;
      return;
    }

    if (!found) {
      note.textContent = 'No new M-PESA messages in this phone\'s inbox.';
      tally = { added: 0, duplicate: 0, unparsed: [], ignored: 0 };
      return;
    }
    render();
    renderNameRules();
    let msg = `${tally.added} new transaction${tally.added === 1 ? '' : 's'} from ${found} message${found === 1 ? '' : 's'}.`;
    if (tally.duplicate) msg += ` ${tally.duplicate} already on file.`;
    if (tally.unparsed.length) msg += ` ${tally.unparsed.length} not recognised.`;
    note.textContent = msg;
    toast(msg, tally.unparsed.length ? 'warn' : 'ok');
    // Nothing is dropped silently, same as the paste box.
    showUnparsed(tally.unparsed, tally.ignored);
    tally = { added: 0, duplicate: 0, unparsed: [], ignored: 0 };
  };
}

/* ---- Shopping receipts from the phone app -------------------------------- */

function renderBasket() {
  const card = $('#basket-card');
  if (!card) return;
  const receipts = store.receipts();
  const links = store.receiptLinks();
  const txns = store.allTransactions();
  const byId = new Map(txns.map((t) => [t.id, t]));

  $('#basket-badge').textContent = receipts.length
    ? `${receipts.length} shop${receipts.length === 1 ? '' : 's'}`
    : '';

  const box = $('#basket');
  if (!receipts.length) {
    box.innerHTML =
      '<p class="hint">Nothing yet. In Basket Budget, open <em>Move your list</em> and tap <strong>Copy everything</strong>.</p>';
    renderBasketSearch();
    return;
  }

  const top = basket.itemTotals(receipts).slice(0, 8);
  box.innerHTML = `
    <h3 class="small">What your shopping actually goes on</h3>
    <table class="tight"><tbody>
      ${top
        .map(
          (t) => `<tr>
            <td>${escapeHtml(t.name)}<span class="dim small"> · ${t.qty} over ${t.times} shop${t.times === 1 ? '' : 's'}</span></td>
            <td class="num"><strong>${viz.fmt(t.total)}</strong></td>
          </tr>`,
        )
        .join('')}
    </tbody></table>
    <h3 class="small">Each shop</h3>
    ${receipts
      .map((r) => {
        const total = r.slipTotal != null ? r.slipTotal : basket.receiptTotal(r);
        const txn = byId.get(links[r.id]);
        const where = txn
          ? `<span class="good">matched ${escapeHtml(String(txn.counterparty || '—'))}</span>`
          : '<span class="dim">no payment matched</span>';
        return `<details class="sub">
          <summary>
            <strong>${shortDate(r.date + 'T12:00:00Z')}</strong>
            · ${r.items.length} item${r.items.length === 1 ? '' : 's'}
            · <strong>${viz.fmt(total)}</strong> · ${where}
          </summary>
          <table class="tight"><tbody>
            ${r.items
              .map(
                (i) => `<tr>
                  <td>${escapeHtml(i.name)}${i.qty > 1 ? `<span class="dim small"> · ${i.qty} @ ${viz.fmt(i.price)}</span>` : ''}</td>
                  <td class="num">${viz.fmt(i.price * i.qty)}</td>
                </tr>`,
              )
              .join('')}
          </tbody></table>
          <button type="button" class="link" data-drop-receipt="${escapeHtml(r.id)}">Remove this receipt</button>
        </details>`;
      })
      .join('')}`;

  box.querySelectorAll('[data-drop-receipt]').forEach((b) =>
    b.addEventListener('click', () => {
      store.removeReceipt(b.dataset.dropReceipt);
      renderBasket();
    }),
  );
  renderBasketSearch();
}

function renderBasketSearch() {
  const out = $('#basket-search-out');
  if (!out) return;
  const hits = basket.findItems(store.receipts(), $('#basket-search').value);
  if (!$('#basket-search').value.trim()) {
    out.innerHTML = '';
    return;
  }
  if (!hits.length) {
    out.innerHTML = '<p class="hint">Nothing by that name in your receipts.</p>';
    return;
  }
  const total = hits.reduce((s, h) => s + h.item.price * h.item.qty, 0);
  out.innerHTML = `
    <p class="hint"><strong>${viz.fmt(total)}</strong> across ${hits.length} line${hits.length === 1 ? '' : 's'}.</p>
    <table class="tight"><tbody>
      ${hits
        .map(
          (h) => `<tr>
            <td>${escapeHtml(h.item.name)}<span class="dim small"> · ${shortDate(h.date + 'T12:00:00Z')} · ${h.item.qty} @ ${viz.fmt(h.item.price)}</span></td>
            <td class="num">${viz.fmt(h.item.price * h.item.qty)}</td>
          </tr>`,
        )
        .join('')}
    </tbody></table>`;
}

function wireBasket() {
  const paste = $('#basket-paste');
  if (!paste) return;
  $('#basket-import').addEventListener('click', () => {
    const note = $('#basket-note');
    let parsed;
    try {
      parsed = basket.parseBasket(paste.value);
    } catch (e) {
      note.textContent = e.message;
      return;
    }
    if (!parsed.receipts.length) {
      note.textContent =
        'That list has no receipts in it. Use "Copy everything", not "Copy my list".';
      return;
    }
    const counts = store.importReceipts(parsed.receipts);
    // Match against the statement now, so a shop lands on the payment that
    // settled it rather than floating loose.
    const links = basket.matchAll(store.receipts(), store.allTransactions());
    store.setReceiptLinks(links);
    const matched = Object.keys(links).length;
    note.textContent =
      `${counts.added} new, ${counts.replaced} updated. ` +
      `${matched} of ${counts.total} matched to a payment.`;
    paste.value = '';
    renderBasket();
  });
  $('#basket-search').addEventListener('input', renderBasketSearch);
}

init();
