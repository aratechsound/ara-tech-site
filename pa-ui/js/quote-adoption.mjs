import {privateText,setPrivateAmount,readPrivateAmount,revealPrivacy,resetPrivacy} from './pa-workspace-privacy.mjs';
const pick=q=>Object.fromEntries(['source','estimate_id','message_id','thread_id','attachment_id','part_id','sha256'].filter(k=>q?.[k]!=null).map(k=>[k,q[k]]));
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new window.TextEncoder().encode(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x))))].map(n=>n.toString(16).padStart(2,'0')).join('');
// A confirmation is one operation. A lost response is never an automatic retry.
export async function openQuoteAdoption({candidate,request,dialog,valid,setBusy,onChanged,details}){
 const e=candidate?.evidence;if(!e||candidate.stale||candidate.origins?.length>1||e.approval?.status!=='verified'||!e.approval.exact_quote_reference||!e.approval.linked)return details(candidate);
 const input={simple_adoption:true,contract_id:e.contract_id,quote:pick(e.quote),approval:{source:'gmail',message_id:e.approval.message_id,thread_id:e.approval.thread_id}};
 resetPrivacy();const d=dialog('この見積書を正式採用しますか？');d.dataset.quoteAdoption='';d.dataset.externalMoneyGuard='true';const name=document.createElement('p');name.textContent=privateText(e.quote.filename);const status=document.createElement('p');status.setAttribute('role','status');status.textContent='原本と承認を確認中…';
 const yes=document.createElement('button'),no=document.createElement('button');yes.textContent='はい';no.textContent='いいえ';yes.disabled=true;d.append(name,status,yes,no);d.showModal();
 let prepared=null,working=false,attempted=false,required=[];const fields=new Map();
 no.onclick=()=>{if(!working){d.close();d.remove();}};d.addEventListener('cancel',event=>{if(working)event.preventDefault();else{d.close();d.remove();}});
 function fail(){status.textContent='採用を確定できません。再実行せず、詳しく確認で保存履歴を確認してください。';yes.disabled=true;const b=document.createElement('button');b.textContent=attempted?'採用履歴を読み取り確認':'詳しく確認';b.onclick=async()=>{if(!attempted){d.close();d.remove();details(candidate);return;}b.disabled=true;try{const state=await request('change_evidence_candidates');if(!valid()||!d.open)return;const current=state.current_agreement?.evidence;status.textContent=current?.case_id===e.case_id&&current.contract_id===e.contract_id&&current.quote.sha256===e.quote.sha256&&current.approval.message_id===e.approval.message_id?'同じ見積と承認の採用済み記録があります。操作結果は履歴で確認し、再採用しないでください。':'操作結果は未確定です。再採用せず、Ownerが履歴を確認してください。';}catch{if(valid()&&d.open)status.textContent='採用履歴を取得できません。結果未確定のまま再採用しないでください。';}finally{b.disabled=false;}};d.append(b);}
 try{
  prepared=await request('change_evidence_preview',input);if(!valid()||!d.open)return;
  if(prepared.evidence?.case_id!==e.case_id||prepared.evidence.quote.sha256!==e.quote.sha256||prepared.evidence.approval.message_id!==e.approval.message_id)throw Error('change_evidence_mismatch');
  required=prepared.required_fields||[];for(const key of required){const label=document.createElement('label'),field=document.createElement(key==='tax_basis'?'select':'input');field.setAttribute('aria-label',key==='tax_basis'?'税区分':'見積金額');label.textContent=key==='tax_basis'?'税区分':'見積金額';if(key==='tax_basis'){for(const [v,t]of [['','選択してください'],['tax_included','税込'],['tax_excluded','税別'],['tax_exempt','非課税']])field.append(new Option(t,v));}else{field.inputMode='numeric';setPrivateAmount(field,'');field.addEventListener('pointerdown',()=>revealPrivacy(d));field.addEventListener('focus',()=>revealPrivacy(d));}label.append(field);d.insertBefore(label,yes);fields.set(key,field);}
  if(!prepared.can_adopt&&!required.length)throw Error('change_evidence_incomplete');status.textContent=required.length?'不足している項目だけ確認してください。':'原本と対応する顧客承認を確認しました。';yes.disabled=false;
 }catch{if(valid()&&d.open)fail();}
 yes.onclick=async()=>{if(working||attempted||!valid()||!prepared||!d.open)return;if(required.some(key=>key==='amount_minor'?!(Number(readPrivateAmount(fields.get(key)))>0&&Number.isSafeInteger(Number(readPrivateAmount(fields.get(key))))):!fields.get(key).value)){status.textContent='不足している項目を確認してください。';return;}working=true;setBusy(true);yes.disabled=true;no.disabled=true;
  try{
   if(required.length){const filled={...input,quote:{...input.quote}};for(const [key,field]of fields)filled.quote[key]=key==='amount_minor'?Number(readPrivateAmount(field)):field.value;prepared=await request('change_evidence_preview',filled);Object.assign(input,filled);if(!valid()||!prepared.can_adopt||prepared.required_fields?.length)throw Error('change_evidence_incomplete');}
   if(!valid())return;attempted=true;const operation=crypto.randomUUID();const result=await request('change_evidence_append',{...input,event_kind:'adopted',operation_id:operation,fingerprint:prepared.fingerprint,previous_event_id:prepared.previous_event_id,evidence_sha256:await digest(prepared.evidence)});
   if(!valid())return;const read=await request('change_evidence_candidates');if(!valid())return;
   if(!result.id||read.current_agreement?.id!==result.id||read.current_agreement.evidence?.quote.sha256!==e.quote.sha256)throw Error('change_evidence_changed');status.textContent='現行合意見積として採用済み';await onChanged();if(d.open)d.close();d.remove();
  }catch{if(valid()&&d.open)fail();}finally{working=false;no.disabled=false;setBusy(false);}
 };
}
