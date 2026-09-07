const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createFixture}=require('./helpers/pa-contract-fixture.cjs');
const {sha}=require('../api/_pa-contract-pdf.cjs');
const {issuanceTerms,issuanceTermsV4}=require('../api/_pa-contract-terms.cjs');
global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
async function main(){
 const f=await createFixture();
 try{
  const quote=(await f.service.quoteSource(f.inquiryId,'direct_sent_001','attachment_1')).identity;
  const legacy={event_name:'龍姫湖まつり2026（検証用）',event_date:'2026-10-18',recipient:'customer@example.invalid',customer_name:'旧顧客',confirmer_name:'旧確認者',amount:170500,request_summary:'旧問い合わせ原文',quote,...issuanceTerms('2026-10-18')};
  const oldId=crypto.randomUUID(),oldToken='f'.repeat(64);
  await f.db.query('select pa_contract_issue($1,$2,$3,$4,$5,$6)',[f.actorId,oldId,f.inquiryId,sha(oldToken),JSON.stringify(legacy),f.quote.toString('base64')]);
  const before=(await f.db.query('select snapshot,snapshot_sha256 from pa_contract_offers where id=$1',[oldId])).rows[0];
  const input={case_id:f.inquiryId,gmail_message_id:'direct_sent_001',gmail_attachment_id:'attachment_1',quote_sha256:sha(f.quote),customer_name:'竹林 智也 様（検証用）',amount:170500,order_scope:{performance_time:'10:00〜15:00',venue:'検証用会場',services:'音響機材・設営・PAオペレート・電源／発電機対応'},request_summary:'問い合わせ原文は採用しない'};
  for(const order_scope of [null,{},[],{...input.order_scope,services:''},{...input.order_scope,venue:'x'.repeat(1001)}])assert.notEqual((await f.call({...input,action:'issue',order_scope})).statusCode,200);
  const preview=await f.service.previewConditions(input);assert(preview.preview_text.includes('10:00〜15:00'));assert(preview.preview_text.includes(input.order_scope.services));
  assert.equal((await f.service.view(oldToken)).snapshot.presentation_version,3);
  assert.deepEqual((await f.db.query('select snapshot,snapshot_sha256 from pa_contract_offers where id=$1',[oldId])).rows[0],before);
  const r=await f.call({...input,action:'issue'});assert.equal(r.statusCode,200);const token=new URL(r.body.result.url).hash.slice(1),view=await f.service.view(token),s=view.snapshot;
  assert.equal(s.presentation_version,4);assert.deepEqual(s.order_scope,input.order_scope);assert(!s.request_summary.includes('問い合わせ原文'));
  assert.equal(s.terms_text,preview.terms_text);assert.equal(s.payment_due_date,'2026-11-02');assert.equal(s.other_terms_sections.length,6);
  assert(!/外注費|実費|いずれか高い方|ご依頼にあたっての確認事項/.test(s.terms_text));
  assert(!/キャンセル条件|支払条件/.test(s.business_terms));assert(s.business_terms.includes('重大な過失'));assert(s.business_terms.includes('身体への損害'));
  assert.equal(s.quote.sha256,quote.sha256);assert.deepEqual((await f.db.query('select snapshot,snapshot_sha256 from pa_contract_offers where id=$1',[oldId])).rows[0],before);
  await assert.rejects(f.service.view(oldToken),/invalid_link/);
  const accepted=await f.call({action:'accept',token,offer_id:view.offer_id,snapshot_sha256:view.snapshot_sha256,confirmer_name:'顧客が編集した最終確認者',agree:true},{admin:false});assert.equal(accepted.statusCode,200);
  const saved=(await f.db.query('select snapshot from pa_contracts where id=$1',[view.offer_id])).rows[0].snapshot;
  assert.equal(saved.confirmer_name,'顧客が編集した最終確認者');assert.deepEqual(saved.order_scope,s.order_scope);assert.equal(saved.terms_text,s.terms_text);assert.equal(f.state.sendCount,0);
  assert.equal(issuanceTermsV4('2026-10-18','承認済み翌月末払い','2026-11-30').payment_due_date,'2026-11-30');
  console.log('PASS v4 explicit scope, stale form rejection, exact preview/snapshot, standard cancellation, six sections, immutable v3, edited confirmer, no live transport');
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
