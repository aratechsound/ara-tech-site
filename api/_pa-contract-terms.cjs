const TERMS_VERSION = 'PA-FORMAL-20260908-v2';
const INVOICE = '請求書は原則としてPDFをメール添付でお送りします。原本の郵送や指定様式が必要な場合は、別途ご相談ください。';
const PAYMENT = 'イベント終了後14日以内に銀行振込でお支払いください。振込手数料はお客様のご負担となります。\n\n行政機関、法人、団体等で所定の会計手続きにより14日以内のお支払いが難しい場合は、「この内容で正式に依頼する」ボタンを押す前にARA-TECHへご相談ください。別の支払条件を承認した場合は、その条件を反映した新しい確認URLをご案内します。新しい確認ページの内容をご確認のうえ、お手続きください。';
const BUSINESS = [
 '業務はARA-TECHが責任をもって実施します。必要に応じて、ARA-TECHが適切な担当者を配置する場合があります。',
 '見積書に機材名や仕様を記載している場合でも、故障・在庫状況・現場条件などにより、同等以上の性能・用途を満たす機材へ変更する場合があります。',
 '見積金額や業務範囲に影響しない進行・機材配置などの調整は、ARA-TECHの判断で対応します。料金や業務内容に影響する変更がある場合は、事前に内容をご案内し、必要に応じてあらためてご確認いただきます。',
 '会場使用に必要な許可・届出、近隣への騒音対応、音楽著作権に関する手続きなどは、ARA-TECHが別途請け負う場合を除き、主催者様にてご対応ください。',
 '会場側から供給される電源の安全性と必要な容量の確保は、主催者様・会場側の責任でご対応ください。ただし、ARA-TECHが発電機等の電源設備を提供する範囲は除きます。',
 '主催者様の管理下にある方によるARA-TECH機材の破損・盗難については、主催者様に責任を負っていただきます。また、必要な屋外テント等は、見積書にARA-TECHが請け負う旨を記載している場合を除き、主催者様にてご用意ください。',
 '雷・強風・大雨などにより安全確保が難しいとARA-TECHが判断した場合、設営・本番対応を一時中断、中止または撤収する場合があります。',
 '主催者様・出演者様がお持ち込みになる音源・機材については、すべての機器との動作を保証するものではありません。重要な再生素材は予備をご用意ください。ARA-TECHの機材を操作・移動される際は、必ず事前に担当者へご相談いただき、了承を得てください。',
 '法令で認められる範囲において、ARA-TECHは間接的な損害や逸失利益（本来得られるはずだった利益）等について責任を負いません。ARA-TECHが負担する直接的な損害の賠償額は、原則として当該案件の最終確定契約金額を上限とします。ただし、ARA-TECHの故意・重過失による損害、身体への損害、および強行法規などにより免除・制限できない責任には、この制限は適用しません。'
].join('\n\n');
function cancellation(eventDate) {
 const at = new Date(`${eventDate}T00:00:00Z`);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(+at) || at.toISOString().slice(0,10)!==eventDate) throw Error('invalid_event_date');
 const day=n=>{const d=new Date(+at+n*86400000);return `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;};
 return `開催31日前まで\n（${day(-31)}まで）\nキャンセル料：無料\n\n開催30日前～8日前\n（${day(-30)}～${day(-8)}）\nキャンセル料：30％\n\n開催7日前～2日前\n（${day(-7)}～${day(-2)}）\nキャンセル料：50％\n\n前日・当日\n（${day(-1)}～${day(0)}）\nキャンセル料：100％\n\n天候・台風等による中止も、原則として上記と同じキャンセル条件を適用します。\n\nすでに発注済みで取消できない外注費などの実費が、上記のキャンセル料を上回る場合は、その実費額をご負担いただきます。\n\nキャンセル料と実費を二重に加算するものではなく、いずれか高い方の金額となります。`;
}
function terms(eventDate, customPayment='') {
 const approved=String(customPayment||'').trim();
 const payment=(approved ? `ARA-TECHが承認した今回の支払条件\n${approved}\n\n振込手数料はお客様のご負担となります。` : PAYMENT)+`\n\n${INVOICE}`;
 const cancel=cancellation(eventDate);
 return {terms_version:TERMS_VERSION,payment_terms:payment,cancellation_terms:cancel,business_terms:BUSINESS,terms_text:`キャンセル条件\n${cancel}\n\n支払条件\n${payment}\n\nご依頼にあたっての確認事項\n${BUSINESS}`};
}
module.exports={terms,TERMS_VERSION};
