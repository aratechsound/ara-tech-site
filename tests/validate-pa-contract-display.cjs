const assert=require('node:assert/strict');
const {honorific,japaneseDate,receiptBody}=require('../api/_pa-contract-display.cjs');
const {createFixture}=require('./helpers/pa-contract-fixture.cjs');
const {sha}=require('../api/_pa-contract-pdf.cjs');
const {normalizeCustomerBody}=require('../api/_pa-mail.cjs');
global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
async function main(){
 for(const [input,expected] of [['竹林 智也','竹林 智也 様'],['竹林 智也 様','竹林 智也 様'],['竹林 智也　様　','竹林 智也　様'],['安芸太田町 ○○課 御中','安芸太田町 ○○課 御中'],['ご担当者各位','ご担当者各位'],['山田先生','山田先生']])assert.equal(honorific(input),expected);
 assert.equal(japaneseDate('2026-10-18'),'2026年10月18日（日）');assert.equal(japaneseDate('2026-11-02'),'2026年11月2日（月）');
 const f=await createFixture();try{
 const customer='竹林 智也 様';const r=await f.call({action:'issue',case_id:f.inquiryId,gmail_message_id:'direct_sent_001',gmail_attachment_id:'attachment_1',quote_sha256:sha(f.quote),customer_name:customer,amount:170500,order_scope:{performance_time:'10:00〜15:00',venue:'管理下テスト会場',services:'管理下PA'}});assert.equal(r.statusCode,200);
 const id=r.body.result.id,token=new URL(r.body.result.url).hash.slice(1),v=await f.service.view(token);const a=await f.call({action:'accept',token,offer_id:id,snapshot_sha256:v.snapshot_sha256,confirmer_name:'管理下テスト確認者',agree:true},{admin:false});assert.equal(a.body.result.receipt_status,'ready');
 const before=(await f.db.query('select snapshot from pa_contracts where id=$1',[id])).rows[0].snapshot;
 const p=await f.service.mailPreview({case_id:f.inquiryId,contract_id:id},{id:f.actorId});assert.equal(p.body,normalizeCustomerBody(receiptBody(before)));assert(p.body.startsWith(customer+'\n'));assert(!p.body.includes('様 様'));assert(!/version|契約ID|SHA-256|UTC/.test(p.body));for(const s of ['2026年10月18日（日）','2026年11月2日（月）','170,500円（税込）','荒殿 竜一'])assert(p.body.includes(s));assert(p.html.includes('#007bff'));assert(p.html.includes('ara-tech-logo-horizontal-white.png'));assert.equal(p.attachments.length,1);assert.equal(p.attachments[0].mime_type,'application/pdf');
 const first=await f.service.ensureReceipt(f.inquiryId,id),second=await f.service.ensureReceipt(f.inquiryId,id);assert.deepEqual(first.bytes,second.bytes);assert.deepEqual((await f.db.query('select snapshot from pa_contracts where id=$1',[id])).rows[0].snapshot,before);assert.equal(before.customer_name,customer);assert.equal(f.state.sendCount,0);
 console.log('PASS honorifics, Japanese dates, final branded email body, one PDF, immutable snapshot/stored receipt, zero transport');
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
