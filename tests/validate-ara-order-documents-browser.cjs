'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{PDFDocument}=require('pdf-lib');
const root=path.resolve(__dirname,'..'),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',E='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444',C='55555555-5555-4555-8555-555555555555';
async function main(){
 const pdf=await PDFDocument.create();pdf.addPage().drawText('ISOLATED CHANGE EVIDENCE');const bytes=Buffer.from(await pdf.save()),hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const server=http.createServer((req,res)=>{const f=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1));if(!f.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('Content-Type',/\.(mjs|js)$/.test(f)?'text/javascript':f.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(f));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
  const estimate={id:E,inquiry_id:A,document_id:D,revision_number:2,amount_minor:200000,tax_basis:'tax_included',issued_at:'2026-10-15',currency:'JPY'},contract={id:C,version:1,confirmed_at:'2026-09-15',snapshot:{estimate:{estimate_id:E},explicit_consent:{cancellation:true,payment:true}}};
  const data=id=>({state:{inquiry_id:id,revision:1,current_estimate_revision_id:E,estimate_change_state:'ready'},estimates:[estimate],documents:[{id:D,inquiry_id:id,original_filename:'change.pdf',mime_type:'application/pdf'}],offers:[{...contract,state:'accepted'}],outbox:[],billings:[],payments:[],adjustments:[]});
  let history=[],sequence=0,failOriginal=false,delay=null,empty=false;
  const messages=[{gmail_message_id:'sent_1',gmail_thread_id:'thread_1',direction:'outbound',sent_at:'2026-10-15',subject:'変更見積',attachment_metadata:[{id:'att_1',part_id:'1',filename:'変更見積.pdf',mime_type:'application/pdf'}]},{gmail_message_id:'reply_1',gmail_thread_id:'thread_2',direction:'inbound',received_at:'2026-10-16',subject:'変更承認',attachment_metadata:[]}];
  const result=input=>({case_id:input.case_id,contracts:[contract],estimates:[estimate],documents:[{id:D,original_filename:'change.pdf'}],messages:empty?[]:messages,outbox:[],history,current_agreement:history.find(e=>['adopted','revoked'].includes(e.event_kind))?.event_kind==='adopted'?history.find(e=>e.event_kind==='adopted'):null,storage_available:true,search_state:'searched',candidate_state:empty?'evidence_unidentified':'multiple_candidates',detected:input.detect&&!empty?[{contract_id:C,quote:{filename:'変更見積.pdf',message_id:'sent_1',attachment_id:'att_1',amount_minor:200000,tax_basis:'tax_included',source:'gmail',sha256:hash,thread_id:'thread_1',part_id:'1'},approval:{message_id:'reply_1',thread_id:'thread_2'}}]:[],detection_state:empty?'evidence_unidentified':'candidate_found'});
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const s={access_token:'fixture',user:{id:'owner'},expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,logout:async()=>{},subscribe:fn=>window.fixtureAuth=fn};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('LEGACY_FORBIDDEN')};"}));
  await page.route('**/api/pa-workspace-read?**',r=>{const p=new URL(r.request().url()).searchParams.get('path');let v=[];if(p==='/data/cases')v={cases:[{id:A,event_name:'隔離変更案件A',inquiry_number:'FIXTURE-A',case_type:'PA_EVENT',status:'new'},{id:B,event_name:'隔離変更案件B',inquiry_number:'FIXTURE-B',case_type:'PA_EVENT',status:'new'}],progress:[]};else if(p.startsWith('/data/commercial/'))v=data(p.split('/').at(-1));else if(p.startsWith('/data/materials/'))v={cards:[],photos:[]};else if(p.startsWith('/data/sent-estimates/'))v={messages:[],unknown:[]};return r.fulfill({json:{ok:true,result:v}});});
  await page.route('**/api/pa-mail?surface=commercial',async r=>{
   const b=r.request().postDataJSON();calls.push(b);let v;
   if(b.action==='snapshot')v=data(b.case_id);
   else if(b.action==='change_evidence_candidates')v=result(b);
   else if(b.action==='change_evidence_preview'){
    if(delay){const p=delay;delay=null;await p;}
    if(failOriginal)return r.fulfill({status:400,json:{ok:false,code:'change_evidence_mismatch'}});
    const evidence={case_id:b.case_id,contract_id:C,contract_sha256:'a'.repeat(64),quote:{filename:'変更見積（改訂2）.pdf',sha256:hash,amount_minor:200000,registered_sha_match:true,revision_number:2},approval:{source:b.approval.source,message_id:b.approval.message_id,thread_id:b.approval.thread_id,exact_quote_reference:true,linked:true,reply_body:'こちらの内容でお願いいたします。',quoted_body:'> 過去の引用',body:'原文',status:'verified'},warnings:['quote_reply_relation_requires_owner_confirmation']};
    v={evidence,fingerprint:'b'.repeat(64),previous_event_id:history[0]?.id||null,storage_available:true,can_adopt:b.owner_confirmed&&b.owner_case_relation_confirmed&&!!b.reason&&!!b.change_description,status:'owner_review_required'};
   }else if(['change_evidence_document','change_evidence_contract_pdf','change_evidence_mail_pdf'].includes(b.action))return r.fulfill({contentType:'application/pdf',body:bytes});
   else if(b.action==='change_evidence_append'){assert(['saved','adopted','revoked'].includes(b.event_kind));assert(b.operation_id);const prior=history[0];v={id:'event-'+(++sequence),event_kind:b.event_kind};history.unshift({...v,contract_id:C,created_at:'2026-10-16',reason:b.reason,evidence:b.event_kind==='revoked'?prior.evidence:{quote:{filename:'変更見積.pdf',amount_minor:200000,sha256:hash}}});}
   else throw Error('UNEXPECTED_BUSINESS_ACTION '+b.action);
   return r.fulfill({json:{ok:true,result:v}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html?case='+A);await page.getByRole('button',{name:'見積・受注',exact:true}).click();

  const region=page.getByRole('region',{name:'受注後の変更見積・顧客承認証拠'});
  await region.getByText('送信済み・Owner未採用',{exact:true}).waitFor();
  assert.equal(await region.locator('.order-document').count(),3);
  assert.equal(await page.locator('.change-evidence:not(.order-documents)').count(),0);
  assert.equal(await page.locator('#formal-document-grid').count(),1);assert.equal(await page.locator('#current-estimate-grid').count(),1);
  await region.locator('canvas').nth(2).waitFor();
  assert(await region.locator('.order-document-preview .material-card').evaluateAll(ns=>ns.every(n=>n.getBoundingClientRect().width>=n.parentElement.getBoundingClientRect().width*.98)),'Mail-carousel card widths must not shrink the document originals');
  const rects=await region.locator('.order-document').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width};}));
  assert(rects.every(r=>Math.abs(r.y-rects[0].y)<1));assert(rects[0].x<rects[1].x&&rects[1].x<rects[2].x);
  assert((await page.locator('#current-estimate-grid').innerText()).includes('改訂2'));
  assert(calls.some(c=>c.action==='change_evidence_preview'&&!c.owner_confirmed));
  for(let i=0;i<3;i++){
   await region.locator('.order-document').nth(i).getByRole('button',{name:'PDFを拡大',exact:true}).click();
   const viewer=page.locator('.pa-material-preview-dialog');await viewer.getByText('1 / 1ページ · 100%',{exact:true}).waitFor();
   await viewer.getByRole('button',{name:'拡大',exact:true}).click();await viewer.getByText('1 / 1ページ · 125%',{exact:true}).waitFor();
   await viewer.getByRole('button',{name:'閉じる',exact:true}).click();await viewer.waitFor({state:'detached'});
  }
  const before=calls.filter(c=>c.action==='change_evidence_candidates'&&c.detect).length;
  await page.getByRole('button',{name:'商務正本を再取得',exact:true}).click();
  await page.getByRole('button',{name:'変更見積・承認証拠を検索・確認',exact:true}).waitFor();assert.equal(calls.filter(c=>c.action==='change_evidence_candidates'&&c.detect).length,before);
  await region.getByRole('button',{name:'履歴を見る ↓',exact:true}).click();assert.equal(await page.locator('.order-document-history').evaluate(n=>n.open),true);
  assert.equal(await page.locator('.estimate-history').count(),1);assert.equal(await page.locator('.formal-history').count(),1);
  for(const width of [1440,1024,390]){await page.setViewportSize({width,height:1000});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await region.locator('.order-documents-grid').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),width>860?3:1);}
  await page.setViewportSize({width:1440,height:1000});
  await region.locator('.order-document').nth(1).getByRole('button',{name:'PDFを拡大',exact:true}).click();await page.locator('.pa-material-preview-dialog canvas').waitFor();
  await page.getByRole('button',{name:/隔離変更案件B/}).evaluate(b=>b.click());await page.locator('.pa-material-preview-dialog').waitFor({state:'detached'});
  await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.getByRole('button',{name:'変更見積・承認証拠を検索・確認',exact:true}).waitFor();
  await page.evaluate(()=>window.fixtureAuth('SIGNED_OUT',null));assert.equal(await page.locator('.pa-material-preview-dialog').count(),0);
  assert.deepEqual(errors,[]);assert(!calls.some(c=>/append|send|issue|record_payment|create_billing/.test(c.action)));
  console.log(JSON.stringify({status:'PASS',single_document_region:true,horizontal_three_real_pdf_previews:true,candidate_unadopted_label:true,existing_management_history:true,responsive:true,case_auth_disposal:true,bounded_detection:true,real_provider_sends:0,production_business_writes:0}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
