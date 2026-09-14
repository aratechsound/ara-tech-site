const assert=require('node:assert/strict');
const {customerServiceSummary,normalizeDisplayText}=require('../api/_pa-contract-pdf.cjs');

const expected='PA・音響・電源対応';
assert.equal(customerServiceSummary({requested_services:['PA・音響','電源・発電機']}),expected);
assert.equal(customerServiceSummary({service_scope:'希望業務：PA・音響、電源・発電機\n開催概要：ダンス、神楽など\n神楽：切替指示あり'}),expected);
assert.equal(customerServiceSummary({service_scope:'PA・音響・電源対応'}),expected);
assert.equal(customerServiceSummary({service_scope:'希望業務：PA・音響\r\n開催概要：長い内部メモ'}),'PA・音響');
assert.equal(customerServiceSummary({service_scope:'開催概要：内部情報\n質問：詳細'}),'対象見積書記載の業務');
assert.equal(normalizeDisplayText('PA・音響\u000b□\ufffd\u2028電源対応'),'PA・音響 電源対応');

for(const value of [
 customerServiceSummary({requested_services:['PA・音響','電源・発電機']}),
 customerServiceSummary({service_scope:'希望業務：PA・音響、電源・発電機\n開催概要：ダンス、神楽など'})
]){
 assert(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd\u25a0\u25a1]/u.test(value));
 assert(!value.includes('開催概要'));
}

console.log('PA-EST-005A receipt service summary checks passed');
