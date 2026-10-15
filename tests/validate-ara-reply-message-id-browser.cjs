'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const html=`<!doctype html><meta charset="utf-8"><button id="open">返信を開く</button><script type="module">
import {createReplyComposer} from '/pa-ui/js/case-workflows.mjs';
const id='11111111-1111-4111-8111-111111111111',opid='33333333-3333-4333-8333-333333333333';
window.calls=[];window.mode='sent';window.active=true;
const operation=()=>({operation_id:opid,inquiry_id:id,state:window.mode==='sent'?'SENT':'UNKNOWN',gmail_message_id:window.mode==='sent'?'ack_message':null,history_sync:'COMPLETE',can_send:false,can_reconcile:true});
const request=async action=>{window.calls.push(action);if(action==='send_reply')throw Error('NO_SEND_ALLOWED');if(action==='reply_operation_status')return {result:{operation:operation()}};if(action!=='reply_reconcile')throw Error('UNEXPECTED_ACTION');
 if(window.mode==='expired')throw Error('login_required');
 if(window.mode==='pending')await new Promise(resolve=>window.release=resolve);
 return {result:{operation:operation(),matched:window.mode==='sent',verification:{status:window.mode==='sent'?'VERIFIED':'UNVERIFIED',basis:'PERSISTED_PROVIDER_ACK_GMAIL_ID',gmail_message_id:'ack_message',rfc_message_id:'<provider-generated@example.invalid>',generated_rfc_preserved:false},...(window.mode==='sent'?{}:{review:{candidates:[{gmail_message_id:'candidate_<script>',binding_matches:true,mismatches:[]}],automatic_sent:false,truncated:true}})}};};
const c=createReplyComposer({request,getCase:()=>window.active?{id,inquiry_number:'FIXTURE',event_name:'Synthetic test'}:null,onSent:async()=>{throw Error('NO_SEND_ALLOWED');}});
document.querySelector('#open').onclick=()=>c.open({inquiry_id:id,gmail_message_id:'source_fixture',gmail_thread_id:'thread_fixture',direction:'inbound',from_address:'recipient@example.invalid',subject:'Synthetic test',cc_addresses:[]});
</script>`;
(async()=>{
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}const file=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true});
 try{
  for(const mode of ['sent','unknown','expired','pending']){
   const context=await browser.newContext(),page=await context.newPage();await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/,r=>r.abort());await page.goto(url);await page.evaluate(v=>window.mode=v,mode);await page.locator('#open').click();const dialog=page.getByRole('dialog');
   await dialog.getByRole('region',{name:'永続送信操作',exact:true}).getByText(mode==='sent'?/SENT/:/UNKNOWN/).waitFor();
   const button=dialog.getByRole('button',{name:'Gmailの送信結果を照合（読取専用）',exact:true});await button.click();
   const proof=dialog.getByLabel('送信結果の照合根拠',{exact:true});
   if(mode==='sent'){await proof.getByText('保存済みProvider ACKのGmail IDと原本を照合しました。',{exact:true}).waitFor();assert((await proof.innerText()).includes('原本RFC IDは事前生成値と異なります'));}
   if(mode==='unknown'){await proof.getByText(/UNKNOWNを維持/).waitFor();assert((await proof.innerText()).includes('candidate_<script>'));assert.equal(await proof.locator('script').count(),0);assert.equal(await dialog.getByRole('button',{name:'返信プレビュー',exact:true}).isDisabled(),true);}
   if(mode==='expired')await dialog.getByText('結果照合は未確認です。UNKNOWNを解除せず、自動再送しません。',{exact:true}).waitFor();
   if(mode==='pending'){await page.waitForFunction(()=>typeof window.release==='function');await page.evaluate(()=>{window.active=false;window.release();});await page.waitForFunction(()=>window.calls.length===2);assert.equal(await proof.innerText(),'');}
   const calls=await page.evaluate(()=>window.calls);assert.deepEqual(calls,['reply_operation_status','reply_reconcile']);assert.equal(await dialog.getByRole('button',{name:'最終確認して送信',exact:true}).count(),0);await context.close();
  }
  console.log(JSON.stringify({status:'PASS',sent_ack_readonly_proof:true,unknown_manual_candidates_no_promotion:true,auth_failure_no_send:true,stale_case_result_discarded:true,candidate_text_inert:true,real_provider_sends:0}));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
