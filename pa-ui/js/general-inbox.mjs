import {escape} from './model.mjs';
import {mailRow} from './mail-row.mjs';
import {createMailBodyView} from './mail-body-view.mjs';
const el=(tag,text)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;return e;};
const errors={inbox_review_stale:'本文やidentityが更新されたか、確認期限が切れました。再取得してください。',mail_link_conflict:'候補の状態またはスレッドの所属が変わりました。登録せず停止しています。',mail_identity_review_required:'顧客本人を安全に確認できません。登録を停止します。',invalid_origin:'Origin制限により操作できません。設定は迂回しません。',inbox_registration_unavailable:'登録経路またはDB候補が未導入です。結果を確認し、自動再試行しません。'};
export function createGeneralInbox({request,isAuthenticated,onRegistered,onAuthFailure=()=>{}}){
 let state=null,generation=0;
 const bodies=createMailBodyView({isAuthenticated,request:async(_id,row)=>state?.review?.id===row.gmail_message_id?{...state.review,gmail_message_id:state.review.id}:Promise.reject(Error('inbox_review_stale'))});
 const current=s=>state===s&&s.generation===generation&&isAuthenticated();
 function clear(){generation++;bodies.clear();const s=state;state=null;if(s)s.host.replaceChildren();}
 function beforeLeave(){return !state?.busy;}
 function fail(s,e){if(!current(s))return;s.status.textContent=(errors[e.message]||'取得・処理に失敗しました。成功とは判定していません。')+' / '+String(e.status||'')+' '+e.message;if([401,403].includes(e.status)){clear();onAuthFailure();}}
 async function mount(host){clear();const s={host,generation,busy:false,cursor:null,review:null};state=s;host.innerHTML='<h2>未紐付けメール</h2><p class="hint">保存済み候補のみ表示します。Gmail同期・既読変更・自動登録は行いません。</p>';
  s.status=el('p');s.status.setAttribute('role','status');s.list=el('section');s.reviewHost=el('section');s.next=el('button','さらに表示');s.next.className='lightbtn';s.next.hidden=true;host.append(s.status,s.list,s.next,s.reviewHost);
  async function load(){s.next.disabled=true;try{const r=(await request('inbox_list',s.cursor?{cursor:s.cursor}:{})).result;if(!current(s))return;if(!Array.isArray(r.candidates))throw Error('invalid_read_response');s.cursor=r.next_cursor||null;s.next.hidden=!s.cursor;s.status.textContent=r.candidates.length?'候補 '+r.candidates.length+'通（この取得ページ）':'保存済みの未紐付けメールはありません';for(const row of r.candidates){const box=el('article');box.className='record';const open=el('button','本文・本人確認');open.className='lightbtn';open.onclick=()=>review(s,row);box.append(el('strong',row.subject||'件名未取得'),el('p','差出人 '+(row.from_address||'未取得')+' / '+(row.received_at||'日時未取得')),open);s.list.append(box);}}catch(e){fail(s,e);}finally{if(current(s))s.next.disabled=false;}}
  s.next.onclick=load;await load();
 }
 async function review(s,row){if(!current(s)||s.busy)return;s.busy=true;s.status.textContent='選択した1通の原本を照合中…';s.reviewHost.replaceChildren();bodies.clear();
  try{const m=(await request('inbox_review',{gmail_message_id:row.gmail_message_id})).result;if(!current(s))return;if(m.id!==row.gmail_message_id||m.thread_id!==row.gmail_thread_id)throw Error('mail_link_conflict');s.review=m;
   const r={...m,gmail_message_id:m.id,gmail_thread_id:m.thread_id,received_at:m.occurred_at,attachment_metadata:[]};s.reviewHost.innerHTML=mailRow(r,{dateText:m.occurred_at||'日時未取得',actions:false,candidate:true});const card=s.reviewHost.querySelector('.mail-row');bodies.mount(card,'unlinked',r,()=>current(s)&&s.review===m);
   s.reviewHost.append(el('p','Reply-To '+(m.reply_to||'なし')+' / 本人候補の根拠 '+(m.identity_source==='relay_reply_to'?'通知の返信先ヘッダー':'差出人ヘッダー')));
   const form=el('form'),name=el('input'),email=el('input'),kind=el('select'),check=el('input'),submit=el('button','一般問い合わせ案件として登録');form.className='general-inquiry-form';check.type='checkbox';kind.append(new Option('一般問い合わせ（OTHER）','OTHER'));email.value=m.customer_candidate||'';email.type='email';name.required=true;email.required=true;submit.type='submit';submit.className='action';
   for(const [label,input]of [['顧客名',name],['顧客メール',email],['問い合わせ種別',kind]]){const l=el('label',label);input.setAttribute('aria-label',label);l.append(input);form.append(l);}
   const l=el('label','本文・From・Reply-Toを確認し、顧客本人と種別を確認しました');check.setAttribute('aria-label',l.textContent);l.prepend(check);form.append(l,submit);submit.disabled=true;let attempted=false;
   const enabled=()=>{submit.disabled=attempted||!check.checked||!name.value.trim()||!email.value.trim()||m.registration_blocked||!m.review_token;};name.oninput=email.oninput=check.onchange=enabled;
   form.onsubmit=async e=>{e.preventDefault();enabled();if(submit.disabled||s.busy||!current(s))return;if(!window.confirm('この1通を一般問い合わせ案件として登録しますか？\n'+name.value+' / '+email.value+'\nOTHER / '+m.id+' / '+m.thread_id))return;s.busy=true;attempted=true;enabled();
    try{const result=(await request('inbox_decide',{gmail_message_id:m.id,decision:'create',customer_name:name.value,customer_email:email.value,case_type:kind.value,review_token:m.review_token,identity_confirmed:true})).result;if(!current(s))return;if(!result?.inquiry_id||result.message_only!==true)throw Error('invalid_registration_result');s.busy=false;await onRegistered(result.inquiry_id);}catch(e){fail(s,e);}finally{if(current(s))s.busy=false;}};
   s.reviewHost.append(form);s.status.textContent=m.registration_blocked?'本人確認できないため登録を停止しています。':'原本を取得しました。登録はOwnerの最終確認後だけ実行します。';
  }catch(e){fail(s,e);}finally{if(current(s))s.busy=false;}
 }
 return {mount,clear,beforeLeave,get active(){return !!state;}};
}
