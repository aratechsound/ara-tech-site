import {caseTitle,isGeneralInquiry,isClosedCase} from './model.mjs';
const types=['OTHER','AUDIO_INSTALL','AV_INSTALL','LIGHTING_INSTALL','VIDEO_INSTALL','EQUIPMENT_RENTAL'];
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v||'');
// Reuse the legacy editor's authenticated Data API + existing RLS/audit trigger.
// Only status is written; no privileged RPC, contract or payment mutation.
export async function completeGeneralCase(client,auth,snapshot){
 if(!uuid(snapshot?.id)||!types.includes(snapshot.case_type)||isClosedCase(snapshot)||snapshot.deleted_at||!snapshot.updated_at)throw Error('general_completion_stale');
 if(!await auth.restore())throw Error('login_required');
 const fields='id,inquiry_number,case_type,status,updated_at,deleted_at';
 const {data:current,error:readError}=await client.from('pa_inquiries').select(fields).eq('id',snapshot.id).single();
 if(readError||!current||current.case_type!==snapshot.case_type||current.status!==snapshot.status||current.updated_at!==snapshot.updated_at||current.deleted_at)throw Error('general_completion_stale');
 const {data,error}=await client.from('pa_inquiries').update({status:'closed'})
  .eq('id',snapshot.id).eq('case_type',snapshot.case_type).eq('status',snapshot.status).eq('updated_at',snapshot.updated_at).is('deleted_at',null).select(fields).maybeSingle();
 if(error||data?.id!==snapshot.id||data.case_type!==snapshot.case_type||data.status!=='closed')throw Error('general_completion_result_unconfirmed');
 return data;
}
const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
export function createGeneralCaseCompletion({getCase,isAuthenticated,save,onSaved}){
 let state=null;
 const current=s=>state===s&&isAuthenticated()&&getCase()?.id===s.snapshot.id&&getCase()?.updated_at===s.snapshot.updated_at;
 function clear(){const s=state;state=null;if(s){clearInterval(s.guard);s.dialog.remove();}}
 function beforeLeave(){if(state?.busy)return false;clear();return true;}
 function open(){
  if(!beforeLeave())return;const c=getCase();if(!isAuthenticated()||!isGeneralInquiry(c)||isClosedCase(c)||c.deleted_at)return;
  const d=make('dialog');d.className='case-commercial-dialog';d.setAttribute('aria-label','一般問い合わせの対応完了');d.addEventListener('click',e=>e.stopPropagation());
  const status=make('p');status.setAttribute('role','status');const yes=make('button','対応完了を保存'),no=make('button','キャンセル');
  const check=make('input');check.type='checkbox';const label=make('label','対象の問い合わせと対応内容を確認しました');label.prepend(check);yes.disabled=true;
  const s={snapshot:{...c},dialog:d,busy:false,attempted:false};state=s;
  check.onchange=()=>{yes.disabled=!check.checked||s.attempted;};no.onclick=()=>{if(!s.busy)clear();};d.addEventListener('cancel',e=>{e.preventDefault();if(!s.busy)clear();});
  d.append(make('h2','この問い合わせを対応完了にしますか？'),make('p',(c.inquiry_number||'受付番号未提供')+' / '+caseTitle(c)),make('p','メールや記録は保持します。顧客への送信、請求・入金の更新は行いません。'),label,status,yes,no);document.body.append(d);d.showModal();
  s.guard=setInterval(()=>{if(state===s&&!current(s))clear();},500);
  yes.onclick=async()=>{
   if(!current(s)||s.busy||s.attempted||!check.checked)return;s.attempted=true;s.busy=true;yes.disabled=true;check.disabled=true;no.disabled=true;status.textContent='保存結果を確認中…';
   try{const saved=await save(s.snapshot);if(!current(s))return;clear();await onSaved(saved);}
   catch{if(current(s)){status.textContent='保存結果を確認できません。再実行せず、案件一覧を再取得して状態を確認してください。';no.textContent='閉じる';}}
   finally{s.busy=false;if(state===s)no.disabled=false;}
  };
 }
 return {open,clear,beforeLeave};
}
