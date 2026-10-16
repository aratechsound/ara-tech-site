import {mailRow} from './mail-row.mjs';
import {createMailBodyView} from './mail-body-view.mjs';
import {privateText} from './pa-workspace-privacy.mjs';
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=privateText(String(text));return n;};
const button=(text,fn)=>{const b=el('button',text);b.type='button';b.className='lightbtn';b.onclick=fn;return b;};
const STATES={ESTIMATE_REGISTRATION_UNCONFIRMED:'Owner採用証拠と正式見積履歴への登録は別です。正式見積登録が未確認のため、正式採用を完了できません。',CHANGE_LEDGER_UNCONFIRMED:'見積履歴はありますが、正式受注後の変更合意台帳が未確認です。元契約を維持し、再送・自動登録を行いません。',CONTRACT_SELECTION_UNCONFIRMED:'対応する元契約を一意に確認できません。',REGISTERED_CHANGE_AGREED:'正式見積履歴と変更合意台帳の対応を確認しました。'};
export function createReplyDocumentView({getCase,requestReply,requestCommercial,readBody}){
 let epoch=0,caseId=null,loadPromise=null;const dialogs=new Set();
 const valid=(id,g)=>getCase()?.id===id&&caseId===id&&epoch===g;
 const bodies=createMailBodyView({request:readBody,isAuthenticated:()=>!!getCase(),excerptText:text=>String(text).split('\n').slice(0,3).join('\n')});
 function clear(){epoch++;caseId=null;loadPromise=null;bodies.clear();for(const d of dialogs){d.close();d.remove();}dialogs.clear();}
 function load(id){if(caseId!==id){clear();caseId=id;}const g=epoch;
  return loadPromise ||= requestReply('reply_document_list',{inquiry_id:id}).then(r=>{if(!valid(id,g)||r.result?.inquiry_id!==id)throw Error('case_changed');return r.result;});
 }
 function dialog(title){const d=el('dialog');d.className='case-commercial-dialog';d.setAttribute('aria-label',title);d.dataset.replyDocumentReview='';d.dataset.externalMoneyGuard='true';d.append(el('h2',title));dialogs.add(d);d.addEventListener('close',()=>{dialogs.delete(d);d.remove();},{once:true});document.body.append(d);return d;}
 function card(host,id,row,g){
  const holder=el('div');holder.innerHTML=mailRow(row,{actions:false,dateText:row.received_at?new Date(row.received_at).toLocaleString('ja-JP'):'日時未取得'});host.append(holder);
  bodies.mount(holder.firstElementChild,id,row,()=>valid(id,g)&&holder.isConnected);
 }
 async function review(item,operation){
  const id=getCase()?.id,g=epoch;if(!id||!valid(id,g))return;
  const d=dialog(item.document_kind==='invoice'?'請求書と送信記録の確認':'この見積書を正式採用しますか？');
  const status=el('p','Gmail原本・MIME part・PDF SHA256・正式登録を照合中…');status.setAttribute('role','status');
  const content=el('section'),no=button('いいえ',()=>d.close());d.append(content,status,no);d.showModal();
  let input={case_id:id,operation_id:operation.operation_id,gmail_message_id:item.message_id,part_id:item.part_id,sha256:item.sha256},model,working=false,attempted=false;
  const current=()=>valid(id,g)&&d.open;d.addEventListener('cancel',e=>{if(working)e.preventDefault();});no.onclick=()=>{if(!working)d.close();};
  async function refresh(){
   if(!current())return;content.replaceChildren();status.textContent='原本と業務記録を確認中…';no.disabled=true;
   try{
    model=await requestCommercial('reply_document_review',input);if(!current()||model.case_id!==id)return;
    if(model.verified?.verification!=='VERIFIED'||model.part?.sha256!==item.sha256||model.part?.document_kind!==item.document_kind)throw Error('identity_mismatch');
    content.append(el('p',model.part.filename),el('p','送信操作に固定した区分: '+(item.document_kind==='estimate'?'見積書':'請求書')),el('p','PDF SHA256: '+model.part.sha256));
    if(item.document_kind==='invoice'){
      status.textContent=model.invoice_state==='REGISTERED_IDENTITY_MATCH'?'既存請求書の原本と送信記録が一致しました。請求状態・金額・期限・入金状態は変更しません。':model.invoice_state==='AMBIGUOUS'?'対応する請求記録が複数あり未確定です。':'送信済み資料・請求登録未確認。請求の発行・確定は行いません。';no.textContent='閉じる';return;
    }
    status.textContent=STATES[model.registration_state]||'正式登録の対応は未確認です。';
    if(model.existing_adoption)content.append(el('p','保存済みのOwner採用証拠があります。重複作成しません。'));
    const selection=model.selection;
    if(selection){const a=selection.preview.evidence.approval;card(content,id,{inquiry_id:id,gmail_message_id:a.message_id,gmail_thread_id:a.thread_id,direction:'inbound',from_address:a.from,to_addresses:a.to,received_at:a.occurred_at,subject:a.subject,body_text:a.body},g);}
    else content.append(el('p',model.approval_matches>1?'了承メール候補が複数あります。Ownerが原本を選択してください。':'対応する了承メールは一意に確認できません。'));
    if(model.automatic_search_incomplete)content.append(el('p','自動照合は取得上限または原本取得失敗により未完了です。'));
    content.append(button('別のメールを選ぶ',()=>{
      const picker=dialog('同じ案件の了承メールを選択');picker.append(el('p','受信メールの原文を確認して選択してください。'));
      for(const m of model.approval_candidates||[]){const host=el('section');card(host,id,m,g);host.append(button('このメールを選ぶ',()=>{if(!current())return;input={...input,approval_message_id:m.gmail_message_id,approval_thread_id:m.gmail_thread_id};picker.close();refresh();}));picker.append(host);}
      if(model.approval_list_truncated)picker.append(el('p','最新20通までの表示です。残りは未検証です。'));
      picker.append(button('選択をやめる',()=>picker.close()));picker.showModal();
    }));
    const yes=button('はい',async()=>{
      if(!current()||working||attempted||!model.can_complete)return;working=true;attempted=true;yes.disabled=true;no.disabled=true;
      try{
        const selected=model.selection.preview,approval=selected.evidence.approval;
        const result=await requestCommercial('reply_document_adopt',{...input,approval_message_id:approval.message_id,approval_thread_id:approval.thread_id,adoption_operation_id:crypto.randomUUID(),fingerprint:selected.fingerprint,previous_event_id:selected.previous_event_id});
        if(!current())return;
        status.textContent=result.complete&&result.registration_state==='REGISTERED_CHANGE_AGREED'?'正式見積履歴・変更合意・Owner採用証拠を確認しました。':'部分完了または未確認です。正式採用の完了とは扱いません。';
      }catch{if(current())status.textContent='操作結果は未確認です。再採用せず保存履歴を確認してください。';}
      finally{working=false;if(current())no.disabled=false;}
    });yes.disabled=!model.can_complete||attempted||!!model.existing_adoption;content.append(yes);
   }catch{if(current())status.textContent='原本・権限・登録状態を確認できません。採用・請求処理は行っていません。';}
   finally{if(current())no.disabled=false;}
  }await refresh();
 }
 function previewActions(item,controls){
  if(item.source_direction!=='outbound'||item.mime_type!=='application/pdf')return;
  const id=getCase()?.id;if(!id)return;
  const task=load(id),g=epoch;
  task.then(data=>{
   if(!valid(id,g)||!controls.isConnected)return;
   const matches=data.operations.filter(o=>o.state==='SENT'&&o.gmail_message_id===item.message_id&&o.gmail_thread_id===item.gmail_thread_id&&o.attachments[item.index]?.filename===item.filename&&o.attachments[item.index]?.mime_type===item.mime_type&&o.attachments[item.index]?.size===Number(item.size));
   if(matches.length!==1)return;
   const op=matches[0],a=op.attachments[item.index];if(!['estimate','invoice'].includes(a.document_kind))return;
   const b=button(a.document_kind==='estimate'?'この見積書を正式採用':'請求管理との対応を確認',()=>review({...item,document_kind:a.document_kind,sha256:a.sha256},op));controls.append(b);
  }).catch(()=>{if(valid(id,g)&&controls.isConnected)controls.append(el('p','添付区分は未確認です。専用読取経路・認証・権限の確認が必要です。'));});
 }
 return {previewActions,clear};
}
