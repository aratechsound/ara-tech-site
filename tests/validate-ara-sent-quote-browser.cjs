'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{PDFDocument}=require('pdf-lib');
async function main(){
 const root=path.resolve(__dirname,'..'),A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',OP='33333333-3333-4333-8333-333333333333';
 const pdf=await PDFDocument.create();pdf.addPage().drawText('Synthetic revised total quote');const bytes=Buffer.from(await pdf.save()),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const attachment={id:'att',part_id:'1',filename:'estimate.pdf',mime_type:'application/pdf',size:bytes.length},op={operation_id:OP,inquiry_id:A,state:'SENT',gmail_message_id:'sent',gmail_thread_id:'thread',history_sync:'COMPLETE',attachments:[{...attachment,index:0,sha256:sha,document_kind:'estimate'}]};
 const inbound=n=>({inquiry_id:A,gmail_message_id:'approval_'+n,gmail_thread_id:'thread',direction:'inbound',from_address:'fixture@example.invalid',to_addresses:['aratechsound@gmail.com'],subject:'了承原文 '+n,received_at:'2026-10-17T02:00:00Z',body_text:'見積を確認しました。\n第二行\n第三行\n第四行\n> 引用原文',attachment_metadata:[]});
 const messages=[{inquiry_id:A,gmail_message_id:'sent',gmail_thread_id:'thread',direction:'outbound',from_address:'aratechsound@gmail.com',to_addresses:['fixture@example.invalid'],subject:'見積送付',sent_at:'2026-10-17T01:00:00Z',body_text:'見積原本を送付しました。',attachment_metadata:[attachment]},inbound(1),inbound(2)];
 const cases=[{id:A,event_name:'隔離登録案件A',inquiry_number:'FIXTURE-A',case_type:'PA_EVENT',status:'new'},{id:B,event_name:'隔離登録案件B',inquiry_number:'FIXTURE-B',case_type:'PA_EVENT',status:'new'}];
 const snapshot=id=>({state:{inquiry_id:id,revision:1,estimate_change_state:'ready'},estimates:[],documents:[],offers:[],outbox:[],billings:[],payments:[],adjustments:[],change_orders:[]});
 let post=true,registered=null,adopts=0,loseResponse=false,storage=true,wrongIdentity=false,manualApproval=false;const calls=[],errors=[];
 const server=http.createServer((req,res)=>{const p=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1));if(!p.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('Content-Type',/\.(mjs|js)$/.test(p)?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.wasm')?'application/wasm':'text/html; charset=utf-8');res.end(fs.readFileSync(p));}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());
  await page.route('**/pa-ui/js/integration.mjs',r=>r.fulfill({contentType:'text/javascript',body:"const s={access_token:'isolated',user:{id:'owner'},expires_at:9999999999};export const workspaceAuth={restore:async()=>s,current:async()=>s,logout:async()=>{},subscribe:fn=>window.fixtureAuth=fn};export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);export const legacyUrl=()=>{throw Error('LEGACY_FORBIDDEN')};"}));
  await page.route('**/api/pa-workspace-read?**',r=>{const p=new URL(r.request().url()).searchParams.get('path');let v=[];
   if(p.startsWith('/data/mail-attachment/'))return r.fulfill({contentType:'application/pdf',body:bytes});
   if(p==='/data/cases')v={quote_monitor:false,quote_adoption_simple:false,cases,progress:[]};
   else if(p.startsWith('/data/commercial/'))v=snapshot(p.split('/').at(-1));
   else if(p.startsWith('/data/materials/'))v={cards:[],photos:[]};
   else if(p.startsWith('/data/mail-discovery/'))v={enabled:false,candidates:[]};
   else if(p==='/data/mail/'+A)v=messages;
   else if(p.startsWith('/data/mail-body/'))v={inquiry_id:A,...inbound(Number(p.split('_').at(-1)))};
   else if(p.startsWith('/data/sent-estimates/'))v={messages:[],unknown:[]};
   return r.fulfill({json:{ok:true,result:v}});
  });
  await page.route('**/api/pa-gmail',r=>{const b=r.request().postDataJSON();calls.push(b);assert.equal(b.action,'case_discovery_sync');return r.fulfill({json:{ok:true,result:{complete:true,has_more:false}}});});
  await page.route('**/api/pa-mail?surface=commercial',async r=>{const b=r.request().postDataJSON();calls.push(b);let result;
   if(b.action==='snapshot')result=snapshot(b.case_id);
   else if(b.action==='reply_document_list')result={inquiry_id:b.case_id,operations:b.case_id===A?[op]:[],truncated:false};
   else if(b.action==='reply_document_review')result={case_id:A,document_kind:'estimate',verified:{verification:'VERIFIED'},part:{...op.attachments[0],attachment_id:'att'},registration_state:post?'ESTIMATE_REGISTRATION_UNCONFIRMED':'CONTRACT_SELECTION_UNCONFIRMED',can_complete:false,approval_candidates:[inbound(1),inbound(2)],approval_matches:0};
   else if(b.action==='sent_quote_preview'){
    const a=inbound(b.approval_message_id==='approval_2'?2:1),v=b.values||{},reasons=[];
    if(!storage)reasons.push('STORAGE_UNAVAILABLE');if(!v.tax_basis)reasons.push('AMOUNT_OR_TAX_REQUIRED');if(!v.owner_amounts_confirmed)reasons.push('OWNER_AMOUNT_CONFIRMATION_REQUIRED');
    if(manualApproval&&(!v.owner_approval_confirmed||String(v.owner_approval_reason||'').length<10))reasons.push('MANUAL_APPROVAL_CONFIRMATION_REQUIRED');
    if(post&&(v.document_amount_minor!==200000||v.revised_total_minor!==200000||v.additional_amount_minor!==90000||v.amount_basis!=='revised_total'))reasons.push('TOTAL_AND_ADDITIONAL_AMOUNT_REQUIRED');
    result={case_id:A,phase:post?'POST_CONTRACT':'PRE_CONTRACT',quote:{source:'gmail',message_id:'sent',thread_id:'thread',part_id:'1',sha256:wrongIdentity?'0'.repeat(64):sha,filename:'estimate.pdf',amount_minor:200000},base_amount_minor:110000,approval:{status:manualApproval?'owner_reviewed':'verified',message_id:a.gmail_message_id,thread_id:'thread',from:a.from_address,to:a.to_addresses,subject:a.subject,occurred_at:a.received_at,body:a.body_text},approval_candidates:[inbound(1),inbound(2)],can_complete:!reasons.length&&!registered,reasons,storage_available:storage,existing_adoption_id:post?'preserved-adoption':null,existing_registration_operation_id:registered?.operation_id||null,fingerprint:'fixed-preview'};
   }else if(b.action==='sent_quote_adopt'){
    assert.equal(b.owner_confirmed,true);assert.equal(b.fingerprint,'fixed-preview');adopts++;
    registered={id:'registration',case_id:A,operation_id:b.adoption_operation_id,complete:true,estimate_revision_id:'registered-estimate',change_order_id:post?'registered-change':null,adoption_event_id:post?'preserved-adoption':null,quote_sha256:sha,gmail_message_id:'sent',part_id:'1'};
    if(loseResponse){loseResponse=false;return r.abort('failed');}result=registered;
   }else if(b.action==='sent_quote_status'){assert.equal(b.adoption_operation_id,registered.operation_id);result=registered;}
   else throw Error('UNAUTHORIZED_FIXTURE_ACTION '+b.action);
   return r.fulfill({json:{ok:true,result}});
  });
  const go=async()=>{await page.goto('http://127.0.0.1:'+server.address().port+'/pa-admin.html');await page.locator('[data-case="'+A+'"]').click();await page.getByRole('button',{name:'やり取り',exact:true}).click();await page.locator('[data-message="sent"]').getByRole('button',{name:'estimate.pdf の拡大プレビュー',exact:true}).click();await page.getByRole('button',{name:'この見積書を正式採用',exact:true}).click();await page.getByRole('button',{name:'正式登録の内容を確認',exact:true}).click();return page.getByRole('dialog',{name:'送信済み見積と了承メールの正式登録',exact:true});};
  let d=await go();await d.getByText('元契約を保持し',{exact:false}).waitFor();
  await d.getByRole('button',{name:'別のメールを選ぶ',exact:true}).click();const picker=page.getByRole('dialog',{name:'同じ案件の了承メールを選択',exact:true});await picker.locator('.mail-row').nth(1).getByRole('button',{name:'全文を表示',exact:true}).click();await picker.getByText('第四行',{exact:false}).waitFor();await picker.getByRole('button',{name:'このメールを選ぶ',exact:true}).nth(1).click();await d.getByText('了承原文 2',{exact:false}).waitFor();assert.equal(adopts,0);
  const fill=async()=>{await d.getByRole('combobox',{name:'税区分',exact:true}).selectOption('tax_included');
   if(post){await d.getByRole('combobox',{name:'PDF金額の意味',exact:true}).selectOption('revised_total');for(const [label,value]of [['改訂後総額','200000'],['追加変更額','90000']]){await d.getByRole('textbox',{name:label,exact:true}).click();await d.getByRole('textbox',{name:label,exact:true}).fill(value);}}
   await d.getByRole('checkbox',{name:'PDF原本・了承メール・金額の意味を確認しました',exact:true}).check();await d.getByRole('button',{name:'内容を照合',exact:true}).click();
  };
  await fill();await d.getByText('原本・了承・正式登録内容が一致しました。「はい」で登録します。メールは送信しません。',{exact:true}).waitFor();assert.equal(await d.getByRole('button',{name:'はい',exact:true}).isEnabled(),true);assert.equal(adopts,0);
  manualApproval=true;await d.getByRole('button',{name:'内容を照合',exact:true}).click();await d.getByRole('checkbox',{name:'このメールが当該PDFの顧客了承であると原文で確認しました',exact:true}).waitFor();assert.equal(await d.getByRole('button',{name:'はい',exact:true}).isEnabled(),false);await d.getByRole('checkbox',{name:'このメールが当該PDFの顧客了承であると原文で確認しました',exact:true}).check();await d.getByRole('textbox',{name:'PDFと了承メールの対応を確認した理由',exact:true}).fill('隔離原本PDFと同じ案件の顧客了承メールを確認しました。');await d.getByRole('button',{name:'内容を照合',exact:true}).click();await d.getByText('原本・了承・正式登録内容が一致しました。「はい」で登録します。メールは送信しません。',{exact:true}).waitFor();manualApproval=false;
  if(process.env.PAUI057_SCREENSHOT_DIR){fs.mkdirSync(process.env.PAUI057_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PAUI057_SCREENSHOT_DIR,'PAUI057_READY_DESKTOP.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(process.env.PAUI057_SCREENSHOT_DIR,'PAUI057_READY_MOBILE.png')});await page.setViewportSize({width:1440,height:1000});}
  await d.getByRole('button',{name:'いいえ',exact:true}).click();assert.equal(adopts,0,'cancel leaves business state unchanged');
  d=await go();await fill();loseResponse=true;await d.getByRole('button',{name:'はい',exact:true}).click();await d.getByText('登録結果は未確定です。再実行せず、結果を読取り確認してください。',{exact:true}).waitFor();assert.equal(adopts,1);assert.equal(await d.getByRole('button',{name:'はい',exact:true}).isEnabled(),false);await d.getByRole('button',{name:'正式登録の結果を確認',exact:true}).click();await d.getByText('正式見積履歴・変更合意・Owner採用証拠の登録を確認しました。元契約は保持されています。',{exact:true}).waitFor();assert.equal(adopts,1);
  // Reload/relogin returns the persisted operation for read-only verification.
  d=await go();await d.getByRole('button',{name:'正式登録の結果を確認',exact:true}).click();await d.getByText('正式見積履歴・変更合意・Owner採用証拠の登録を確認しました。元契約は保持されています。',{exact:true}).waitFor();assert.equal(adopts,1);
  registered=null;post=false;d=await go();await d.getByText('正式受注前：',{exact:false}).waitFor();assert.equal(await d.getByRole('textbox',{name:'追加変更額',exact:true}).count(),0);await fill();await d.getByRole('button',{name:'はい',exact:true}).click();await d.getByText('正式見積と顧客了承証拠の登録を確認しました。受注確定は行っていません。',{exact:true}).waitFor();assert.equal(adopts,2);
  registered=null;post=true;storage=false;d=await go();await fill();assert.equal(await d.getByRole('button',{name:'はい',exact:true}).isEnabled(),false);await d.getByText('専用DB契約は未適用です。登録は実行できません。',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});assert(await d.evaluate(e=>e.getBoundingClientRect().right<=innerWidth+1));
  if(process.env.PAUI057_SCREENSHOT_DIR){fs.mkdirSync(process.env.PAUI057_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PAUI057_SCREENSHOT_DIR,'PAUI057_MOBILE.png')});}
  await page.setViewportSize({width:1440,height:1000});if(process.env.PAUI057_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PAUI057_SCREENSHOT_DIR,'PAUI057_DESKTOP.png')});
  await page.evaluate(()=>window.fixtureAuth(null));assert.equal(await page.getByRole('dialog').count(),0);assert(!calls.some(x=>['send_reply','recover_estimate','create_change_proposal','record_change_agreement','create_billing','dispatch_outbox'].includes(x.action)));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASS',actual_case_desk:true,pre_post_contract_distinct:true,approval_picker_and_full_body:true,explicit_amount_meaning:true,cancel_no_write:true,response_loss_read_only_recovery:true,reload_no_duplicate:true,missing_db_closed:true,pc_mobile:true,auth_clear:true,mocked_adoptions:adopts,real_sends:0,production_writes:0}));
 }catch(e){console.error({page_errors:errors,fixture_calls:calls.map(c=>c.action),last_preview:calls.filter(c=>c.action==='sent_quote_preview').at(-1)?.values});throw e;}finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
