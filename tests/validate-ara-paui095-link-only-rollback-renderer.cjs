'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'pa-contract.html'), 'utf8');
const script = '/js/pa-contract-renderer.js';
assert(html.includes(`src="${script}"`));
const renderer = new vm.Script(readFileSync(path.join(root, script.slice(1)), 'utf8'));

function render(mode) {
  const nodes = new Map();
  const node = () => ({ textContent: '', children: [], append(...items) { this.children.push(...items); }, replaceChildren() { this.children.length = 0; } });
  const getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const checkbox = getElementById('agree');
  checkbox.nextElementSibling = { textContent: '旧形式で表示する同意文' };
  const window = {};
  renderer.runInNewContext({ window, document: { getElementById, createElement: node } });
  window.PAContractRenderer.fill({
    confirmation_mode: mode,
    case: { event_name: '隔離試験', event_date: '2026-11-18', service_scope: '会場音響' },
    customer: { display_name: '隔離試験の確認者' },
    estimate: { revision_number: 2, original_filename: '見積書 原本.pdf', amount_minor: 10000, currency: 'JPY' },
    terms: { cancellation_terms: '合意した取消条件', payment_summary: '合意した支払条件' }
  });
  assert.equal(getElementById('quote-version').textContent, '見積 第2版');
  assert.equal(getElementById('quote-filename').textContent, '見積書 原本.pdf');
  assert.equal(getElementById('cancel-text').textContent, '合意した取消条件');
  assert.equal(getElementById('payment-summary').textContent, '合意した支払条件');
  return checkbox.nextElementSibling.textContent;
}

const direct = render('DIRECT_CONFIRM_WITH_ESTIMATE');
assert.match(direct, /同意したうえで正式に依頼します/u);
assert.equal(render('DIRECT_CONFIRM_LINK_ONLY'), direct);
assert.equal(render('LEGACY'), '旧形式で表示する同意文');
console.log('PASS rollback contract renderer preserves both direct consent modes, stored quote labels, terms and the legacy label');
