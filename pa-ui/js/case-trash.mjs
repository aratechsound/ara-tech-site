const make=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const reasons=[['test_case','テスト案件'],['duplicate','重複登録'],['input_error','入力ミス'],['other','その他']];
export function createCaseTrashRequest(getSession,onAuthFailure=()=>{}){return async input=>{
 const session=await getSession();if(!session?.access_token)throw Error('login_required');
 const response=await fetch('/api/pa-case-trash',{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+session.access_token,'content-type':'application/json'},body:JSON.stringify(input)});
 let result;try{result=await response.json();}catch{throw Error('trash_result_unknown');}
 if(response.status===401)onAuthFailure();if(!response.ok||result.ok!==true)throw Error(result.code||'trash_unavailable');return result;
};}
export function createCaseTrash({getCase,request,onTrashed}){
 let state=null;
 const current=s=>state===s&&getCase()?.id===s.id&&getCase()?.inquiry_number===s.number;
 function clear(){const s=state;state=null;if(s){clearInterval(s.guard);s.dialog.remove();}}
 function beforeLeave(){if(state?.busy){state.status.textContent='結果を確認中です。再実行せずお待ちください。';return false;}clear();return true;}
 function open(){
  if(!beforeLeave())return;const c=getCase();if(!c?.id||!c.inquiry_number||c.deleted_at)return;
  const d=make('dialog');d.className='case-commercial-dialog';d.setAttribute('aria-label','案件をゴミ箱へ移動');
  const reason=make('select');reason.setAttribute('aria-label','削除理由');for(const [v,t]of reasons)reason.append(new Option(t,v));
  const confirm=make('input');confirm.type='checkbox';const label=make('label','受付番号・対象案件・削除理由を確認しました');label.prepend(confirm);
  const status=make('p');status.setAttribute('role','status');const yes=make('button','ゴミ箱へ移動する'),no=make('button','キャンセル');yes.disabled=true;
  const s={id:c.id,number:c.inquiry_number,dialog:d,status,busy:false,attempted:false};state=s;
  confirm.onchange=()=>{yes.disabled=!confirm.checked||s.attempted;};no.onclick=()=>{if(!s.busy)clear();};d.addEventListener('cancel',e=>{e.preventDefault();if(!s.busy)clear();});
  d.append(make('h2','案件をゴミ箱へ移動'),make('p',c.inquiry_number+' / '+(c.event_name||'イベント名未設定')),make('p','案件ID: '+c.id),make('p','通常一覧から除外し、記録は保持します。完全削除は行いません。'),reason,label,status,yes,no);document.body.append(d);d.showModal();
  s.guard=setInterval(()=>{if(state===s&&!current(s))clear();},500);
  yes.onclick=async()=>{
   if(!current(s)||s.busy||s.attempted||!confirm.checked)return;
   if(!window.confirm(s.number+' を「'+reasons.find(([v])=>v===reason.value)?.[1]+'」としてゴミ箱へ移動します。対象を確認しましたか？'))return;
   if(!current(s))return;s.busy=true;s.attempted=true;yes.disabled=true;reason.disabled=true;confirm.disabled=true;no.disabled=true;status.textContent='保存結果を確認中…';
   try{const result=await request({action:'trash',inquiry_id:s.id,reason:reason.value});
    if(!current(s))return;const saved=result.case;
    if(!['trashed','already_trashed'].includes(saved?.result)||saved.inquiry_id!==s.id||saved.inquiry_number!==s.number||saved.delete_reason!==reason.value||!Number.isFinite(Date.parse(saved.deleted_at)))throw Error('trash_result_unknown');
    clear();await onTrashed(saved);
   }catch{if(current(s)){status.textContent='保存結果は未確認です。再実行せず、一覧の再読取りで状態を確認してください。';no.textContent='閉じる';}}
   finally{s.busy=false;if(state===s)no.disabled=false;}
  };
 }
 return {open,clear,beforeLeave};
}
