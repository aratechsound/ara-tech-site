import {mailRow} from './mail-row.mjs';
import {createMailBodyView} from './mail-body-view.mjs';
import {privateText,setPrivateAmount,readPrivateAmount,revealPrivacy} from './pa-workspace-privacy.mjs';
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=privateText(String(text));return e;};
const button=(text,run)=>{const b=el('button',text);b.type='button';b.className='lightbtn';b.onclick=run;return b;};
const REASONS={STORAGE_UNAVAILABLE:'専用DB契約は未適用です。登録は実行できません。',CONTRACT_OR_CHRONOLOGY_UNCONFIRMED:'契約または送付時刻が一意に確認できません。',APPROVAL_UNCONFIRMED:'了承メールが一意・完全には確認できません。',AMOUNT_OR_TAX_REQUIRED:'PDF記載額と税区分を確認してください。受注後の税別・外貨はこの経路の対象外です。',TOTAL_AND_ADDITIONAL_AMOUNT_REQUIRED:'PDF金額の意味・改訂後総額・追加変更額が一致していません。減額・ゼロ変更はこの経路の対象外です。',OWNER_AMOUNT_CONFIRMATION_REQUIRED:'原本と金額の意味を確認してください。',MANUAL_APPROVAL_CONFIRMATION_REQUIRED:'返信参照が一致しないメールは、OwnerによるPDFとの対応確認と理由が必要です。',COMMERCIAL_STATE_HOLD:'請求・精算または未解決変更があるため停止しました。',EXISTING_REGISTRATION_REQUIRES_REVIEW:'同じ原本の正式登録が既にあります。上書きせず履歴を確認してください。',EXISTING_ADOPTION_IDENTITY_MISMATCH:'既存の採用証拠と原本・了承・金額の対応が一致しません。',ALREADY_REGISTERED_READ_STATUS:'この原本は既に登録されています。結果を読取り確認してください。'};
export function createSentQuoteRegistration({getCase,request,readBody}){
 let generation=0;const dialogs=new Set();
 const bodyView=createMailBodyView({request:readBody,isAuthenticated:()=>!!getCase(),excerptText:t=>String(t).split('\n').slice(0,3).join('\n')});
 function clear(){generation++;bodyView.clear();for(const d of dialogs){d.close();d.remove();}dialogs.clear();}
 function dialog(title){const d=el('dialog');d.className='case-commercial-dialog';d.setAttribute('aria-label',title);d.dataset.sentQuoteRegistration='';d.dataset.externalMoneyGuard='true';dialogs.add(d);d.addEventListener('close',()=>{dialogs.delete(d);d.remove();},{once:true});document.body.append(d);return d;}
 function open(original,onComplete=()=>{}){
  const id=getCase()?.id,g=generation;if(!id||original.case_id!==id)return;
  const d=dialog('送信済み見積と了承メールの正式登録'),status=el('p','原本と登録状態を読取り確認中…');status.setAttribute('role','status');
  const header=el('section'),form=el('section'),approvalHost=el('section'),reasons=el('section'),actions=el('section');
  d.append(el('h2','この見積書を正式採用しますか？'),header,form,approvalHost,reasons,status,actions);d.showModal();
  let input={...original,values:{}},model=null,working=false,attempted=false,operationId=null,phase=null;const fields=new Map();
  const current=()=>g===generation&&getCase()?.id===id&&d.open;
  const yes=button('はい',commit),no=button('いいえ',()=>{if(!working)d.close();}),check=button('内容を照合',()=>refresh());yes.disabled=true;actions.append(check,yes,no);
  d.addEventListener('cancel',e=>{if(working)e.preventDefault();});
  function invalidate(){
   yes.disabled=true;model=null;
   // The existing privacy listener saves the value during document bubbling.
   // A synchronous text mutation can make its observer restore the old value.
   setTimeout(()=>{if(current()&&!model)status.textContent='内容が変わりました。「内容を照合」で再確認してください。';},0);
  }
  function field(key,label,choices){const row=el('label',label),f=el(choices?'select':'input');f.setAttribute('aria-label',label);
   if(choices)for(const [value,text]of choices)f.append(new Option(text,value));
   else{f.inputMode='numeric';setPrivateAmount(f,'');f.addEventListener('pointerdown',()=>revealPrivacy(d));f.addEventListener('focus',()=>revealPrivacy(d));}
   f.addEventListener('input',invalidate);f.addEventListener('change',invalidate);fields.set(key,f);row.append(f);form.append(row);return f;
  }
  function values(){return Object.fromEntries([...fields].map(([k,f])=>[k,f.type==='checkbox'?f.checked:k.endsWith('_minor')?Number(readPrivateAmount(f))||null:f.value]));}
  function showApproval(a){approvalHost.replaceChildren();if(!a){approvalHost.append(el('p','対応する了承メールを選択してください。'));return;}
   const holder=el('section');holder.innerHTML=mailRow({inquiry_id:id,gmail_message_id:a.message_id,gmail_thread_id:a.thread_id,direction:'inbound',from_address:a.from,to_addresses:a.to,subject:a.subject,received_at:a.occurred_at,body_text:a.body},{actions:false,dateText:new Date(a.occurred_at).toLocaleString('ja-JP')});approvalHost.append(holder);bodyView.mount(holder.firstElementChild,id,{gmail_message_id:a.message_id,gmail_thread_id:a.thread_id,body_text:a.body},current);
  }
  function pick(){if(!model||!current()||attempted)return;const p=dialog('同じ案件の了承メールを選択');p.append(el('h2','同じ案件の了承メールを選択'));
   for(const m of model.approval_candidates||[]){const row=el('section');row.innerHTML=mailRow(m,{actions:false,dateText:m.received_at?new Date(m.received_at).toLocaleString('ja-JP'):'日時未取得'});p.append(row);bodyView.mount(row.firstElementChild,id,m,()=>current()&&p.open);row.append(button('このメールを選ぶ',()=>{input={...input,approval_message_id:m.gmail_message_id,approval_thread_id:m.gmail_thread_id};if(fields.has('owner_approval_confirmed')){fields.get('owner_approval_confirmed').checked=false;fields.get('owner_approval_reason').value='';}p.close();refresh();}));}
   if(model.approval_list_truncated)p.append(el('p','最新20通まで。残りのメールは未検証です。'));p.append(button('選択をやめる',()=>p.close()));p.showModal();
  }
  async function refresh(initial=false){if(!current()||working||attempted)return;working=true;yes.disabled=true;check.disabled=true;no.disabled=true;
   try{
    const r=await request('sent_quote_preview',{...input,values:initial?{}:values()});if(!current())return;
    if(r.case_id!==id||r.quote?.sha256!==original.quote.sha256||r.quote.message_id!==original.quote.message_id||r.quote.part_id!==original.quote.part_id)throw Error('identity_mismatch');
    if(!phase){phase=r.phase;header.append(el('p',r.quote.filename),el('p',phase==='PRE_CONTRACT'?'正式受注前：正式見積と了承証拠を登録します。受注確定ではありません。':'正式受注済み：元契約を保持し、既送付原本を変更見積履歴へ登録します。'),el('p','PDF SHA256: '+r.quote.sha256));
     const amount=field('document_amount_minor','PDF記載額');if(r.quote.amount_minor)setPrivateAmount(amount,String(r.quote.amount_minor));
     field('tax_basis','税区分',[['','選択してください'],['tax_included','税込'],...(phase==='PRE_CONTRACT'?[['tax_excluded','税別']]:[]),['tax_exempt','非課税']]);
     if(phase==='POST_CONTRACT'){
      header.append(el('p','現在の合意総額: '+String(r.base_amount_minor??'未確認')+'円'));
      field('amount_basis','PDF金額の意味',[['','選択してください'],['revised_total','改訂後の総額']]);
      form.append(el('p','追加額のみのPDF、減額・ゼロ変更はこの経路では登録せず、個別確認が必要です。'));
      field('revised_total_minor','改訂後総額');field('additional_amount_minor','追加変更額');
     }
     const label=el('label','PDF原本・了承メール・金額の意味を確認しました'),box=el('input');box.type='checkbox';box.setAttribute('aria-label','PDF原本・了承メール・金額の意味を確認しました');box.onchange=invalidate;fields.set('owner_amounts_confirmed',box);label.prepend(box);form.append(label);
     actions.prepend(button('別のメールを選ぶ',pick));
    }else if(phase!==r.phase)throw Error('commercial_state_changed');
    if(r.approval?.status==='owner_reviewed'&&!fields.has('owner_approval_confirmed')){
     const label=el('label','このメールが当該PDFの顧客了承であると原文で確認しました'),box=el('input');box.type='checkbox';box.setAttribute('aria-label','このメールが当該PDFの顧客了承であると原文で確認しました');box.onchange=invalidate;fields.set('owner_approval_confirmed',box);label.prepend(box);
     const reason=el('textarea');reason.setAttribute('aria-label','PDFと了承メールの対応を確認した理由');reason.maxLength=2000;reason.oninput=invalidate;fields.set('owner_approval_reason',reason);form.append(label,el('label','PDFと了承メールの対応を確認した理由（10文字以上）'),reason);
    }
    model=r;showApproval(r.approval);reasons.replaceChildren(...(r.reasons||[]).map(x=>el('p',REASONS[x]||'登録条件は未確認です。')));
    if(r.existing_adoption_id)reasons.append(el('p','原本と一致する既存Owner採用証拠を再利用します。重複作成しません。'));
    if(r.automatic_search_incomplete)reasons.append(el('p','自動照合は未完了です。原文を確認し、了承メールを明示選択してください。'));
    if(r.existing_registration_operation_id){operationId=r.existing_registration_operation_id;actions.append(button('正式登録の結果を確認',readStatus));}
    yes.disabled=!r.can_complete;status.textContent=r.can_complete?'原本・了承・正式登録内容が一致しました。「はい」で登録します。メールは送信しません。':'未確認項目があります。登録は実行していません。';
   }catch{if(current()){model=null;status.textContent='原本・登録状態を取得できません。登録は実行していません。';}}
   finally{working=false;if(current()){check.disabled=false;no.disabled=false;}}
  }
  function showResult(r){if(r.case_id!==id||!r.complete||r.quote_sha256!==original.quote.sha256||r.gmail_message_id!==original.quote.message_id||r.part_id!==original.quote.part_id)throw Error('result_unconfirmed');status.textContent=r.change_order_id?'正式見積履歴・変更合意・Owner採用証拠の登録を確認しました。元契約は保持されています。':'正式見積と顧客了承証拠の登録を確認しました。受注確定は行っていません。';onComplete(r);}
  async function readStatus(){if(!current()||working||!operationId)return;working=true;try{const r=await request('sent_quote_status',{case_id:id,adoption_operation_id:operationId});if(current())showResult(r);}catch{if(current())status.textContent='登録結果は未確定です。再登録せず、保存履歴を確認してください。';}finally{working=false;}}
  async function commit(){if(!current()||working||attempted||!model?.can_complete)return;attempted=true;working=true;operationId=crypto.randomUUID();yes.disabled=true;check.disabled=true;no.disabled=true;
   for(const f of fields.values())f.disabled=true;
   try{const r=await request('sent_quote_adopt',{...input,values:values(),fingerprint:model.fingerprint,adoption_operation_id:operationId,owner_confirmed:true});if(current())showResult(r);}
   catch{if(current()){status.textContent='登録結果は未確定です。再実行せず、結果を読取り確認してください。';actions.append(button('正式登録の結果を確認',readStatus));}}
   finally{working=false;if(current())no.disabled=false;}
  }
  void refresh(true);
 }
 function previewActions(item,controls){
  if(item.source_direction!=='outbound'||item.mime_type!=='application/pdf'||item.asset_kind!=='mail'||!item.message_id||!item.part_id)return;
  const sha=item.verified_sha256||item.sha256;if(!/^[a-f0-9]{64}$/u.test(sha||''))return;
  const id=getCase()?.id;if(!id)return;
  controls.append(button('見積の正式登録・了承メールを確認',()=>open({case_id:id,owner_original_selected:true,quote:{source:'gmail',message_id:item.message_id,thread_id:item.gmail_thread_id,attachment_id:item.asset_id,part_id:item.part_id,sha256:sha}})));
 }
 return {open,previewActions,clear};
}
