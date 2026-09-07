const assert=require('node:assert/strict');
const {parseBankFooter,bankFromQuote}=require('../api/_pa-contract-bank.cjs');
const {postAcceptanceTerms}=require('../api/_pa-contract-display.cjs');
const {issuanceTermsV4}=require('../api/_pa-contract-terms.cjs');
const {createFixture}=require('./helpers/pa-contract-fixture.cjs');
global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
async function main(){
 const line='<<お振込先 >> テスト銀行 本店営業部 普通 0000000 テスト メイギ',bank=parseBankFooter([line]);
 assert.deepEqual(bank,{bank:'テスト銀行',branch:'本店営業部',type:'普通',number:'0000000',holder:'テスト メイギ'});
 assert.deepEqual(parseBankFooter([line,line]),bank);assert.equal(parseBankFooter(['not bank data']),null);
 assert.throws(()=>parseBankFooter([line.replace('0000000','000')]),/quote_bank_unreadable/);
 assert.throws(()=>parseBankFooter([line,line.replace('0000000','1111111')]),/quote_bank_ambiguous/);
 const s=issuanceTermsV4('2026-10-18'),before=JSON.stringify(s),text=postAcceptanceTerms(s,bank);
 for(const value of ['お支払いについて','2026年11月2日（月）','お支払方法：銀行振込','振込手数料：お客様負担',...Object.values(bank)])assert(text.includes(value));
 assert(!/正式に依頼する|新しい確認URL|14日以内のお支払いが難しい/.test(text));assert(text.includes(s.cancellation_terms));assert(text.endsWith(s.business_terms));assert.equal(JSON.stringify(s),before);
 const custom=issuanceTermsV4('2026-10-18','承認済み：翌月末払い','2026-11-30');assert(postAcceptanceTerms(custom,bank).includes('承認済み：翌月末払い'));assert(postAcceptanceTerms(custom,bank).includes('2026年11月30日（月）'));
 const f=await createFixture();try{assert.equal(await bankFromQuote(f.quote),null);assert.equal(f.state.sendCount,0);}finally{await f.db.close();}
 console.log('PASS exact footer fields, zero preservation, missing/ambiguous/malformed handling, post-acceptance facts, custom terms and immutable source');
}
main().catch(()=>{console.error('FAIL bank receipt tests (details suppressed)');process.exitCode=1;});
