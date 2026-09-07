const assert=require('node:assert/strict');
const {PDFDocument}=require('pdf-lib');
const {createFixture}=require('./helpers/pa-contract-fixture.cjs');
const {paymentDeadline,nextBankDay,cancellationBands}=require('../api/_pa-contract-calendar.cjs');
const {sha}=require('../api/_pa-contract-pdf.cjs');
global.fetch=async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');};
async function main(){
 assert.equal(paymentDeadline('2026-10-18').payment_due_date,'2026-11-02');
 assert.equal(paymentDeadline('2026-10-20').payment_due_date,'2026-11-04');
 assert.equal(nextBankDay('2026-09-19'),'2026-09-24');
 assert.equal(nextBankDay('2026-12-31'),'2027-01-04');
 assert.equal(paymentDeadline('2026-10-18','2026-11-30').payment_due_date,'2026-11-30');
 assert.throws(()=>paymentDeadline('2028-02-01'),/payment_calendar_unavailable/);
 assert.throws(()=>paymentDeadline('2026-10-18','2026-02-30'),/invalid_payment_date/);
 assert.throws(()=>paymentDeadline('2026-10-18','2026-10-01'),/invalid_payment_date/);
 assert.deepEqual(cancellationBands('2026-10-18').map(b=>[b.from,b.to,b.rate]),[[null,'2026-09-17',0],['2026-09-18','2026-10-10',30],['2026-10-11','2026-10-16',50],['2026-10-17','2026-10-18',100]]);
 console.log('PASS actual payment date, bank holidays, leap validation, approved date and cancellation boundaries');
 const f=await createFixture();
 try{
  const relatedPdf=await PDFDocument.create();relatedPdf.addPage().drawText('CONTROLLED FIXTURE - LAYOUT');f.state.related=Buffer.from(await relatedPdf.save());
  await f.db.query("update pa_gmail_message_index set attachment_metadata=attachment_metadata || '[{\"id\":\"attachment_2\",\"filename\":\"layout.pdf\",\"mime_type\":\"application/pdf\"}]'::jsonb where gmail_message_id='direct_sent_001'");
  const input={action:'issue',case_id:f.inquiryId,gmail_message_id:'direct_sent_001',gmail_attachment_id:'attachment_1',quote_sha256:sha(f.quote),customer_name:'管理下テスト担当者',amount:170500,request_summary:'管理下テストPA'};
  const conditions=await f.call({action:'preview_conditions',case_id:f.inquiryId});assert.equal(conditions.statusCode,200);assert.equal(conditions.body.result.payment_due_date,'2026-11-02');
  assert.equal(Number((await f.db.query('select count(*) n from pa_contract_offers')).rows[0].n),0);
  const listed=await f.service.offers(f.inquiryId);assert(listed.related_candidates.some(d=>d.gmail_attachment_id==='attachment_2'));
  const inspect=await f.call({action:'inspect_related',case_id:f.inquiryId,gmail_message_id:'direct_sent_001',gmail_attachment_id:'attachment_2'});assert.equal(inspect.statusCode,200);const identity=inspect.body.result.identity;
  assert.equal(identity.sha256,sha(f.state.related));assert.equal(identity.role,'related');
  const wrongCase=await f.call({action:'inspect_related',case_id:f.otherId,gmail_message_id:'direct_sent_001',gmail_attachment_id:'attachment_2'});assert.notEqual(wrongCase.statusCode,200);
  for(const related_documents of [[{...identity,sha256:'0'.repeat(64)}],[identity,identity],[{...identity,gmail_attachment_id:'attachment_1',sha256:sha(f.quote)}],Array(6).fill(identity)]){
   const bad=await f.call({...input,related_documents});assert.notEqual(bad.statusCode,200);
  }
  const first=await f.call(input);assert.equal(first.statusCode,200);const firstToken=new URL(first.body.result.url).hash.slice(1);
  const initial=(await f.db.query('select snapshot,snapshot_sha256 from pa_contract_offers where id=$1',[first.body.result.id])).rows[0];
  assert.equal(initial.snapshot.related_documents.length,0);assert.equal(initial.snapshot.payment_due_date,'2026-11-02');
  // List, source inspection and conditions preview must not touch an issued snapshot/token.
  await f.service.offers(f.inquiryId);await f.service.previewConditions({case_id:f.inquiryId});
  assert.equal((await f.service.view(firstToken)).state,'active');
  assert.deepEqual((await f.db.query('select snapshot,snapshot_sha256 from pa_contract_offers where id=$1',[first.body.result.id])).rows[0],initial);
  const issued=await f.call({...input,related_documents:[identity]});assert.equal(issued.statusCode,200);const token=new URL(issued.body.result.url).hash.slice(1);
  const view=await f.service.view(token),snapshot=view.snapshot;assert.equal(snapshot.presentation_version,3);assert.equal(snapshot.amount,170500);assert.equal(snapshot.quote.sha256,sha(f.quote));assert.equal(snapshot.related_documents.length,1);
  assert(!JSON.stringify(view).includes('content_base64'));assert(!JSON.stringify(await f.service.offers(f.inquiryId)).includes('content_base64'));
  const frozen=(await f.db.query('select snapshot from pa_contract_offers where id=$1',[issued.body.result.id])).rows[0].snapshot;
  assert.equal(frozen.related_documents[0].content_base64,f.state.related.toString('base64'));
  const original=Buffer.from(f.state.related);f.state.related=Buffer.from('replaced externally');
  assert.deepEqual((await f.service.customerRelated(token,0)).bytes,original);
  for(const index of [-1,1,'0',0.5])await assert.rejects(f.service.customerRelated(token,index),/related_document_invalid/);
  await assert.rejects(f.db.query("update pa_contract_offers set snapshot=jsonb_set(snapshot,'{payment_due_date}','\"2026-11-30\"') where id=$1",[issued.body.result.id]));
  const accepted=await f.call({action:'accept',token,offer_id:view.offer_id,snapshot_sha256:view.snapshot_sha256,confirmer_name:'管理下テスト',agree:true},{admin:false});assert.equal(accepted.statusCode,200);
  const saved=(await f.db.query('select snapshot from pa_contracts where id=$1',[issued.body.result.id])).rows[0].snapshot;
  assert.equal(accepted.body.result.receipt_status,'ready');
  if(process.env.PA_CONTRACT_OUTPUT_DIR){const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.PA_CONTRACT_OUTPUT_DIR,{recursive:true});const receipt=await f.service.ensureReceipt(f.inquiryId,issued.body.result.id);fs.writeFileSync(path.join(process.env.PA_CONTRACT_OUTPUT_DIR,'controlled-v3-receipt.pdf'),receipt.bytes);}
  assert.equal(saved.related_documents[0].sha256,identity.sha256);assert.equal(saved.payment_due_date,'2026-11-02');assert.equal(saved.terms_text,snapshot.terms_text);
  await assert.rejects(f.service.customerRelated(token,0),/invalid_link/);
  assert.equal(f.state.sendCount,0);
  console.log('PASS explicit selection, case isolation, frozen related bytes/hash, immutable snapshot, accept and no transport');
 }finally{await f.db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
