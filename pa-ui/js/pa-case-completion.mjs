import {isClosedCase,caseTitle,statusText} from './model.mjs';
import {recordOwnerPaidCompletion} from '../../js/pa-owner-paid-completion.mjs';

export const closeChoices=Object.freeze({declined:['見送り','未受注の相談を見送ります。受注・入金の完了にはしません。'],cancelled:['取消','未受注の依頼が取り消された場合に選びます。契約の取消・精算は行いません。'],closed:['対応終了','未受注の対応を終了します。入金確認済みの完了とは別です。']});
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v||'');
const valid=c=>uuid(c?.id)&&c.case_type==='PA_EVENT'&&!c.deleted_at&&!isClosedCase(c)&&!!c.updated_at&&Number.isSafeInteger(c.revision)&&c.revision>0;
const same=(a,b)=>a?.id===b?.id&&a.case_type===b.case_type&&a.status===b.status&&a.updated_at===b.updated_at&&a.revision===b.revision;
const fingerprint=a=>JSON.stringify([a.inquiry.status,a.inquiry.updated_at,a.inquiry.revision,a.progress,a.commercial]);
export function paClosePolicy(a){
 const {inquiry:c,progress:p,commercial:s}=a||{};
 if(!valid(c)||!p||p.inquiry_id!==c.id||!s?.state||s.state.inquiry_id!==c.id||s.case_status!==c.status||!['offers','billings','payments','adjustments','outbox','change_orders'].every(k=>Array.isArray(s[k])))throw Error('completion_unavailable');
 const ordered=!!(p.formal_contract_id||p.booking_confirmed_on||p.estimate_approved_on||s.offers.some(o=>o.state==='accepted'));
 const unresolved=!!s.state.unresolved_changes||s.outbox.some(j=>['queued','processing','unknown','failed'].includes(j.state)||j.delivery_state==='unknown_after_provider_start')||s.change_orders.some(o=>!['agreed','withdrawn'].includes(o.state));
 const protectedBusiness=ordered||s.offers.length>0||s.billings.length>0||s.payments.length>0||s.adjustments.length>0||unresolved||!!(p.invoice_issued_on||p.invoice_sent);
 const open=s.billings.filter(b=>b.state==='open');let billing=null;
 if(open.length===1&&s.billings.every(b=>b.state==='open'||b.state==='paid')){
  const b=open[0],payments=s.payments.filter(p=>p.billing_id===b.id),adjustments=s.adjustments.filter(x=>x.billing_id===b.id||!x.billing_id&&payments.some(p=>p.id===x.payment_id));
  const nums=payments.map(p=>Number(p.amount)).concat(adjustments.map(x=>Number(x.delta_minor)));
  const paid=nums.reduce((sum,n)=>sum+n,0);
  if(nums.every(Number.isSafeInteger)&&b.amount_minor!=null&&s.state.final_settlement_minor!=null&&Number.isSafeInteger(Number(b.amount_minor))&&paid===Number(b.amount_minor)&&paid===Number(s.state.final_settlement_minor)&&s.state.fulfillment_state==='confirmed'&&s.state.settlement_state==='confirmed'&&(b.invoice_policy!=='separate_pdf'||b.invoice_delivery_state==='sent'))billing=b;
 }
 // Historical delivery UNKNOWN is evidence to retain, not an unpaid balance.
 const deliveryUnknown=s.outbox.some(j=>j.state==='unknown'||j.delivery_state==='unknown_after_provider_start');
 const paidUnresolved=!!s.state.unresolved_changes||s.outbox.some(j=>['queued','processing'].includes(j.state)||j.state==='failed'&&j.delivery_state!=='unknown_after_provider_start')||s.change_orders.some(o=>!['agreed','withdrawn'].includes(o.state));
 const canPaid=ordered&&!paidUnresolved&&(s.billings.length?!!billing:!s.payments.length&&!s.adjustments.length);
 return {canOrdinary:!protectedBusiness,canPaid,billing,paidRoute:s.billings.length?'commercial':'owner_attestation',warning:deliveryUnknown?'過去のメール配送結果にUNKNOWNがあります。配送記録は未確定のまま保持し、再送しません。実入金の確認とは別に照合してください。':'',reason:protectedBusiness?'受注・正式確認・請求・入金または未処理の商務記録を保護しています。通常の終了では処理できません。':''};
}

export async function readPaCloseAuthority(client,auth,snapshot,commercialRequest){
 if(!valid(snapshot))throw Error('completion_stale');
 if(!await auth.restore())throw Error('login_required');
 const [{data:c,error:ce},{data:p,error:pe},s]=await Promise.all([
  client.from('pa_inquiries').select('*').eq('id',snapshot.id).single(),
  client.from('pa_case_progress').select('*').eq('inquiry_id',snapshot.id).single(),
  commercialRequest('snapshot',{case_id:snapshot.id})
 ]);
 if(ce||pe||!same(c,snapshot))throw Error('completion_stale');
 const a={inquiry:c,progress:p,commercial:s};paClosePolicy(a);return a;
}
export async function savePaClose(client,auth,snapshot,choice,authority,commercialRequest,ownerConfirmed=false){
 if(!Object.hasOwn(closeChoices,choice)&&choice!=='owner_payment_completed')throw Error('invalid_completion');
 const fresh=await readPaCloseAuthority(client,auth,snapshot,commercialRequest);
 if(fingerprint(fresh)!==fingerprint(authority))throw Error('completion_stale');
 const policy=paClosePolicy(fresh);
 if(choice==='owner_payment_completed'){
  if(!ownerConfirmed||!policy.canPaid)throw Error('commercial_completion_blocked');
  if(policy.paidRoute==='commercial'){
   const result=await commercialRequest('close_case',{case_id:snapshot.id,billing_id:policy.billing.id,expected_revision:fresh.commercial.state.revision,operation_id:crypto.randomUUID(),new_payment_minor:0,memo:'Ownerが実入金を確認して完了。新規入金記録なし。'});
   if(result?.state!=='closed')throw Error('completion_result_unknown');
  }else{
   const {error}=await recordOwnerPaidCompletion(client,snapshot.id);if(error)throw Error('completion_result_unknown');
  }
 }else{
  if(!policy.canOrdinary)throw Error('commercial_completion_blocked');
  const {error}=await client.rpc('update_pa_case_progress',{p_inquiry_id:snapshot.id,p_progress:{manual_close_status:choice,expected_status:snapshot.status,expected_revision:snapshot.revision,expected_updated_at:snapshot.updated_at,expected_progress_updated_at:fresh.progress.updated_at},p_note:'Ownerが対象と終了理由を確認。顧客メール・商務更新なし。'});
  if(error)throw Error('completion_result_unknown');
 }
 const [{data:c,error:ce},{data:p,error:pe}]=await Promise.all([client.from('pa_inquiries').select('*').eq('id',snapshot.id).single(),client.from('pa_case_progress').select('*').eq('inquiry_id',snapshot.id).single()]);
 const expected=choice==='owner_payment_completed'?'closed':choice,reason=choice==='owner_payment_completed'?'payment_received':choice==='closed'?'other_closed':choice;
 if(ce||pe||c?.id!==snapshot.id||c.case_type!=='PA_EVENT'||c.status!==expected||c.deleted_at||p?.inquiry_id!==c.id||p.close_reason!==reason||!p.closed_at)throw Error('completion_result_unknown');
 return {...c,progress:p};
}
export function lifecycleSections(c){
 const close=c.case_type==='PA_EVENT'?'<section class="group case-ending"><h2>案件の終了処理</h2><p class="hint">開催日では自動終了しません。メール・顧客情報・商務記録・監査を保持します。終了操作では顧客メールを送りません。</p>'+(isClosedCase(c)?'<p>終了状態は保存済みです。「完了等」から確認できます。</p>':'<button class="action quiet" data-pa-complete>終了方法を確認する</button>')+'</section>':'';
 return close+'<hr><section class="group case-cleanup"><h2>不要案件の整理</h2><p class="hint">ゴミ箱へ移動して通常一覧から除外します。記録を保持し、復元できます。</p><button class="action quiet" data-case-trash>ゴミ箱へ移動</button></section>';
}
const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function createPaCaseCompletion({getCase,isAuthenticated,read,save,onSaved,readBack}){
 let state=null;
 const current=s=>state===s&&isAuthenticated()&&same(getCase(),s.snapshot);
 function clear(){const s=state;state=null;if(s){clearInterval(s.guard);s.dialog.remove();}}
 function beforeLeave(){if(state?.busy)return false;clear();return true;}
 async function open(){
  if(!beforeLeave()||!isAuthenticated()||!valid(getCase()))return;
  const c={...getCase()},d=make('dialog');d.className='case-commercial-dialog';d.setAttribute('aria-label','PA案件の終了処理');d.addEventListener('click',e=>e.stopPropagation());
  const status=make('p','最新の案件・商務記録を確認中…');status.setAttribute('role','status');const body=make('div'),no=make('button','閉じる');
  const s={snapshot:c,dialog:d,busy:false,attempted:false};state=s;no.onclick=()=>{if(!s.busy)clear();};d.addEventListener('cancel',e=>{e.preventDefault();if(!s.busy)clear();});
  d.append(make('h2','案件の終了処理'),make('p',(c.inquiry_number||'受付番号未提供')+' / '+caseTitle(c)+' / '+(c.customer_name||'顧客名未提供')),status,body,no);document.body.append(d);d.showModal();
  s.guard=setInterval(()=>{if(state===s&&!current(s))clear();},500);
  try{
   const a=await read(c);if(!current(s))return;const policy=paClosePolicy(a);
   status.textContent=policy.reason||'未受注の案件です。終了理由を選び、対象を確認してください。';
   if(policy.warning){const warning=make('p',policy.warning);warning.className='notice';warning.setAttribute('role','note');body.append(warning);}
   const select=make('select');select.setAttribute('aria-label','終了方法');
   for(const [value,[label]]of Object.entries(closeChoices)){const o=new Option(label,value);o.disabled=!policy.canOrdinary;select.append(o);}
   const paid=new Option('入金確認済みで完了','owner_payment_completed');paid.disabled=!policy.canPaid;select.append(paid);
   select.value=policy.canOrdinary?'declined':policy.canPaid?'owner_payment_completed':'';
   const explanation=make('p'),check=make('input');check.type='checkbox';const label=make('label'),labelText=document.createTextNode('');label.append(check,labelText);
   const yes=make('button','終了状態を保存');yes.disabled=true;
   function update(){check.checked=false;yes.disabled=true;explanation.textContent=select.value==='owner_payment_completed'?'実際の入金を確認したOwnerだけが選択してください。金額・入金日・支払方法を推定・作成しません。':closeChoices[select.value]?.[1]||'通常終了は利用できません。請求・入金と未処理事項を確認してください。';labelText.textContent=select.value==='owner_payment_completed'?'対象案件の入金が完了した事実と、請求・商務の未処理がないことをOwnerとして確認しました':'対象案件と終了理由を確認しました';}
   select.onchange=update;check.onchange=()=>{yes.disabled=s.attempted||!check.checked||!select.value;};update();body.append(select,explanation,label,yes);
   yes.onclick=async()=>{
    if(!current(s)||s.busy||s.attempted||!check.checked||!select.value)return;
    s.attempted=true;s.busy=true;yes.disabled=true;check.disabled=true;select.disabled=true;no.disabled=true;status.textContent='保存結果を読戻し確認中…';
    try{const saved=await save(c,select.value,a,check.checked);if(!current(s))return;clear();await onSaved(saved);}
    catch{if(current(s)){status.textContent='保存結果は未確認です。再送せず、状態を読み直しています…';try{const saved=await readBack(c.id);if(current(s))status.textContent='再送停止。現在の保存状態：'+(saved?.status?statusText(saved):'未確認')+'。一覧を再取得して確認してください。';}catch{if(current(s))status.textContent='保存結果・現在の状態は未確認です。再送せず、一覧を再取得してください。';}}}
    finally{s.busy=false;if(state===s)no.disabled=false;}
   };
  }catch{if(current(s))status.textContent='最新の案件・商務状態を確認できません。終了せず、一覧を再取得してください。';}
 }
 return {open,clear,beforeLeave};
}
