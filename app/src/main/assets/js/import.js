// One entry point for any statement PDF: extract the text, work out which
// institution produced it, and route to the right parser. The two layouts share
// nothing, so guessing wrong is loud (zero rows) rather than quiet.

import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { parseStatementText } from './statement.js';
import { parseBankText, looksLikeBank } from './bank.js';
import { parseKcbText, looksLikeKcb } from './kcb.js';
import { parseNcbaText, looksLikeNcba } from './ncba.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../vendor/pdf.worker.min.mjs';

export async function extractText(buf, password) {
  const doc = await pdfjsLib.getDocument({ data: buf, password }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
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

// Each institution's own layout, with the detector that recognises it. Ordered
// most-specific first: NCBA and KCB carry unmistakable markers, so they're tested
// before the more general shapes.
const INSTITUTIONS = [
  { account: 'ncba', label: 'NCBA', detect: looksLikeNcba, parse: parseNcbaText },
  { account: 'kcb', label: 'KCB', detect: looksLikeKcb, parse: parseKcbText },
  { account: 'stanchart', label: 'Standard Chartered', detect: looksLikeBank, parse: parseBankText },
  { account: 'mpesa', label: 'M-PESA', detect: () => true, parse: parseStatementText }, // fallback
];

export const ACCOUNT_LABELS = Object.fromEntries(INSTITUTIONS.map((i) => [i.account, i.label]));

/**
 * @returns {{transactions, kind, label, pages, text, unresolved?, reconciled?, declared?, computed?}}
 */
export async function importPDF(buf, password) {
  const { text, pages } = await extractText(buf, password);

  const inst = INSTITUTIONS.find((i) => i.detect(text));
  const res = inst.parse(text);
  res.transactions.forEach((t) => (t.accountSource = inst.account));

  return { ...res, kind: inst.account, label: inst.label, pages, text };
}
