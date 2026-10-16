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
  const result=input=>({case_id:input.case_id,contracts:[contract],estimates:[estimate],documents:[{id:D,original_filename:'change.pdf'}],messages:empty?[]:messages,outbox:[],history,current_agreement:history.find(e=>['adopted','revoked'].includes(e.event_kind))?.event_kind==='adopted'?history.find(e=>e.event_kind==='adopted'):null,storage_available:true,search_state:'searched',candidate_state:empty?'evidence_unidentified':'multiple_candidates',detected:input.detect&&!empty?[{contract_id:C,quote:{filename:'変更見積.pdf',message_id:'sent_1',attachment_id:'att_1',amount_minor:200000,tax_basis:'tax_included'},approval:{message_id:'reply_1',thread_id:'thread_2'}}]:[],detection_state:empty?'evidence_unidentified':'candidate_found'});
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
    const evidence={case_id:b.case_id,contract_id:C,contract_sha256:'a'.repeat(64),quote:{filename:b.quote.filename||'変更見積.pdf',sha256:hash,amount_minor:200000,registered_sha_match:true,revision_number:2},approval:{source:b.approval.source,message_id:b.approval.message_id,thread_id:b.approval.thread_id,reply_body:'こちらの内容でお願いいたします。',quoted_body:'> 過去の引用',body:'原文',status:'owner_reviewed'},warnings:['quote_reply_relation_requires_owner_confirmation']};
    v={evidence,fingerprint:'b'.repeat(64),previous_event_id:history[0]?.id||null,storage_available:true,can_adopt:b.owner_confirmed&&b.owner_case_relation_confirmed&&!!b.reason&&!!b.change_description,status:'owner_review_required'};
   }else if(['change_evidence_document','change_evidence_contract_pdf','change_evidence_mail_pdf'].includes(b.action))return r.fulfill({contentType:'application/pdf',body:bytes});
   else if(b.action==='change_evidence_append'){assert(['saved','adopted','revoked'].includes(b.event_kind));assert(b.operation_id);const prior=history[0];v={id:'event-'+(++sequence),event_kind:b.event_kind};history.unshift({...v,contract_id:C,created_at:'2026-10-16',reason:b.reason,evidence:b.event_kind==='revoked'?prior.evidence:{quote:{filename:'変更見積.pdf',amount_minor:200000,sha256:hash}}});}
   else throw Error('UNEXPECTED_BUSINESS_ACTION '+b.action);
   return r.fulfill({json:{ok:true,result:v}});
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html?case='+A);await page.getByRole('button',{name:'見積・受注',exact:true}).click();
  const summary=page.getByRole('region',{name:'受注後の変更見積・顧客承認証拠'});await summary.waitFor();assert.equal(await summary.locator('.change-evidence-column').count(),3);
  await page.getByRole('button',{name:'変更見積・承認証拠を検索・確認',exact:true}).click();let d=page.getByRole('dialog',{name:'変更見積・顧客承認証拠',exact:true});await d.getByText('候補複数。自動的に1件へ絞りません。',{exact:true}).waitFor();
  await d.getByRole('button',{name:'既存メールから3点セット候補を自動検出',exact:true}).click();await d.getByRole('button',{name:/検出候補を選択:/}).click();
  await d.getByLabel('変更内容',{exact:true}).fill('機材構成変更');await d.getByLabel('Owner採用・訂正理由と根拠',{exact:true}).fill('送信者と変更内容を確認');await d.getByLabel('元契約・変更見積・顧客承認を確認し採用します',{exact:true}).check();await d.getByLabel('不足証拠・別thread・顧客と案件の対応を確認しました',{exact:true}).check();
  await d.getByRole('button',{name:'3点の原本を照合（保存しない）',exact:true}).click();await d.getByText('原本照合のみ完了。保存・採用・送信は行っていません。',{exact:true}).waitFor();assert.equal(calls.filter(c=>c.action==='change_evidence_append').length,0);
  assert.equal(await d.getByRole('button',{name:'確認済みの3点を現行合意見積へ採用',exact:true}).isEnabled(),true);
  await d.getByLabel('変更内容',{exact:true}).fill('変更した下書き');assert.equal(await d.getByRole('button',{name:'確認済みの3点を現行合意見積へ採用',exact:true}).isDisabled(),true);
  failOriginal=true;await d.getByRole('button',{name:'3点の原本を照合（保存しない）',exact:true}).click();await d.getByText('案件・メール・PDF原本の不一致です。採用できません。',{exact:true}).waitFor();assert.equal(await d.getByRole('button',{name:'確認済みの3点を現行合意見積へ採用',exact:true}).isDisabled(),true);failOriginal=false;
  await d.getByRole('button',{name:'3点の原本を照合（保存しない）',exact:true}).click();await d.getByRole('button',{name:'確認済みの3点を現行合意見積へ採用',exact:true}).click();await d.getByText('Owner採用済み・現行合意見積',{exact:true}).waitFor();assert.equal(calls.filter(c=>c.action==='change_evidence_append').length,1);
  await d.getByText('変更・見積発行・Gmail送信済み履歴',{exact:true}).click();
  await d.getByRole('button',{name:'現行採用を取り消す・監査を残す',exact:true}).click();await d.getByText('revoked / 2026-10-16 / 送信者と変更内容を確認',{exact:true}).waitFor();assert.equal(history.length,2);
  await d.getByLabel('変更見積の取得元',{exact:true}).selectOption('local');await d.getByLabel('手動提出の変更見積PDF',{exact:true}).setInputFiles({name:'local-change.pdf',mimeType:'application/pdf',buffer:bytes});await d.getByLabel('顧客承認メール',{exact:true}).selectOption('manual_pdf');await d.getByLabel('Gmail取得不能時のメール控えPDF',{exact:true}).setInputFiles({name:'manual-copy.pdf',mimeType:'application/pdf',buffer:bytes});await d.getByRole('button',{name:'3点の原本を照合（保存しない）',exact:true}).click();await d.getByText('原本照合のみ完了。保存・採用・送信は行っていません。',{exact:true}).waitFor();assert(calls.at(-1).quote.content_base64);assert(calls.at(-1).approval.content_base64);
  for(const name of ['元の正式受注確認PDFを表示','選択見積PDFを表示','承認メール控えPDFを表示・取得']){
   await d.getByRole('button',{name,exact:true}).click();const viewer=page.locator('.pa-material-preview-dialog');
   await viewer.getByText('1 / 1ページ · 100%',{exact:true}).waitFor();assert(await viewer.locator('canvas').evaluate(n=>n.width>0&&n.height>0));
   await viewer.getByRole('button',{name:'拡大',exact:true}).click();await viewer.getByText('1 / 1ページ · 125%',{exact:true}).waitFor();
   await viewer.getByRole('button',{name:'閉じる',exact:true}).click();await viewer.waitFor({state:'detached'});
  }
  await d.getByRole('link',{name:'メール控えPDFを保存',exact:true}).waitFor();
  await page.setViewportSize({width:700,height:1000});assert.equal(await d.locator('.change-evidence-grid').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);await page.setViewportSize({width:1440,height:1000});
  await d.getByRole('button',{name:'閉じる',exact:true}).click();await page.getByRole('dialog',{name:'見積下書きの確認',exact:true}).getByRole('button',{name:'下書きを破棄して移動',exact:true}).click();await d.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'変更見積・承認証拠を検索・確認',exact:true}).click();d=page.getByRole('dialog',{name:'変更見積・顧客承認証拠',exact:true});await d.waitFor();
  // Simulate an external case-selection event while a modal is open; real pointer input is intentionally modal-blocked.
  await page.getByRole('button',{name:/隔離変更案件B/}).evaluate(b=>b.click());await d.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'見積・受注',exact:true}).click();await page.getByRole('button',{name:'変更見積・承認証拠を検索・確認',exact:true}).click();d=page.getByRole('dialog',{name:'変更見積・顧客承認証拠',exact:true});await d.waitFor();await page.evaluate(()=>window.fixtureAuth('SIGNED_OUT',null));await d.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);assert(!calls.some(c=>/send|issue|record_payment|create_billing/.test(c.action)));console.log(JSON.stringify({status:'PASS',actual_case_desk_three_columns:true,automatic_candidate_and_manual_fallback:true,no_auto_adoption:true,edited_preview_invalidated:true,mismatch_rejected:true,owner_adoption_revoke_history:true,manual_files_and_copy_pdf:true,responsive:true,case_switch_auth_cleanup:true,real_provider_sends:0}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
