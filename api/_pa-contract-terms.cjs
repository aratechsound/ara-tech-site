const TERMS_VERSION = 'PA-FORMAL-20260907-v1';
const PAYMENT = 'イベント終了後14日以内に銀行振込。振込手数料は顧客負担。行政機関、法人、団体等で所定の会計処理により14日以内が困難な場合は、正式受注前にARA-TECHへ相談し、ARA-TECHが承認した場合のみ別条件を設定できます。請求書は原則PDFをメール添付。原本郵送や指定様式等が必要な場合は後日対応可能です。';
const BUSINESS = [
 'ARA-TECHの業務担当者は荒殿本人に固定せず、必要に応じてARA-TECHが適切な代替PA担当者を割り当てられます。',
 '機材は故障・在庫・現場条件等により、ARA-TECHの技術判断で同等以上の代替機種を使用できます。軽微な運用変更は再契約不要です。価格・契約内容へ影響する重要変更は新versionとして再確認します。',
 '主催者側は、会場使用許可、行政上必要な許認可、騒音・近隣調整、著作権等、会場側電源の安全・容量、主催者側管理下の人員等によるARA-TECH機材の破損・盗難、必要な屋外テント等について責任を負います。ただし見積内でARA-TECHが請け負っているものは除きます。',
 '雷、強風、大雨等、安全上危険な場合、ARA-TECHは専門判断で作業・公演対応を停止または撤収できます。',
 '持込メディア・持込機材の完全動作は保証しません。出演者には再生素材のバックアップ持参を推奨します。ARA-TECH機材は許可なく操作・移動できません。',
 '責任制限は法令上許される範囲で、間接損害・逸失利益等を除外し、ARA-TECHの直接損害責任上限は原則として当該案件の最終確定契約金額とします。ただし、故意・重過失、身体損害、強行法規等、法令上除外できないものはその限りではありません。'
].join('\n\n');
function cancellation(eventDate) {
 const at = new Date(`${eventDate}T00:00:00Z`);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isFinite(+at) || at.toISOString().slice(0,10)!==eventDate) throw Error('invalid_event_date');
 const day=n=>new Date(+at+n*86400000).toISOString().slice(0,10);
 return `${day(-31)}まで：0％\n${day(-30)}～${day(-8)}：30％\n${day(-7)}～${day(-2)}：50％\n${day(-1)}～${day(0)}：100％\n\n天候、台風等による中止も原則として同じ標準キャンセル条件を適用します。ただし、キャンセル不能な外注費等の不可避な実費が標準キャンセル料を上回る場合は、その不可避実費を下回らない扱いとします。`;
}
function terms(eventDate, customPayment='') {
 const payment=customPayment ? `${PAYMENT}\n\nARA-TECH承認済みの本契約の支払条件：${customPayment}` : PAYMENT;
 const cancel=cancellation(eventDate);
 return {terms_version:TERMS_VERSION,payment_terms:payment,cancellation_terms:cancel,business_terms:BUSINESS,terms_text:`キャンセル条件\n${cancel}\n\n支払条件\n${payment}\n\n業務・責任条件\n${BUSINESS}`};
}
module.exports={terms,TERMS_VERSION};
