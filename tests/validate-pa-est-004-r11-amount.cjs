const assert = require('node:assert/strict');
const amount = require('../api/_pa-estimate-amount.cjs');

const ryuhiko = amount.extractEstimateAmountFromText('税抜小計 180,500円\n消費税 18,050円\n御見積額 198,550円');
assert.equal(ryuhiko.status, 'HIGH_CONFIDENCE');
assert.equal(ryuhiko.amount_minor, 198550);
assert.equal(ryuhiko.subtotal_minor, 180500);
assert.equal(ryuhiko.tax_minor, 18050);
assert.equal(ryuhiko.total_tax_included_minor, 198550);
assert.equal(ryuhiko.candidates.some((item) => item.amount_minor === 180500), false, 'subtotal is never a total candidate');

for (const text of ['合計（税込） 198,550円', '税込総額 ￥198,550', 'GRAND TOTAL JPY 198,550']) {
  const result = amount.extractEstimateAmountFromText(text);
  assert.equal(result.status, 'HIGH_CONFIDENCE', text);
  assert.equal(result.amount_minor, 198550, text);
}
assert.equal(amount.extractEstimateAmountFromText('SUBTOTAL 180,500 JPY\nTAX 18,050 JPY').status, 'NOT_FOUND');
assert.equal(amount.extractEstimateAmountFromText('御見積額 198,550円\n税込総額 200,000円').status, 'AMBIGUOUS');

const multiColumnEstimate = amount.extractEstimateAmountFromText([
  '                        小計          消費税10％      合計(税込)                                                   御見積額',
  '                    ¥180,500          ¥18,050        ¥198,550                                                   ¥198,550'
].join('\n'));
assert.equal(multiColumnEstimate.status, 'HIGH_CONFIDENCE');
assert.equal(multiColumnEstimate.amount_minor, 198550);
assert.equal(multiColumnEstimate.subtotal_minor, 180500);
assert.equal(multiColumnEstimate.tax_minor, 18050);
assert.equal(multiColumnEstimate.matched_label, '御見積額');
console.log('PASS PA-EST-004R11 amount: final-total semantics, subtotal exclusion, arithmetic diagnostics and Tier-A ambiguity');
