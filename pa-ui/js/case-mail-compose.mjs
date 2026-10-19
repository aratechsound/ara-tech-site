import {createGallery} from './gallery.mjs';
const el=(tag,text)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;return x;};
const btn=(text,run)=>{const x=el('button',text);x.type='button';x.onclick=run;return x;};
const field=(title,input)=>{const label=el('label');label.append(el('span',title),input);return label;};
const list=v=>[...new Set(String(v||'').split(/[;,\n]/u).map(x=>x.trim().toLowerCase()).filter(Boolean))];
export function createCaseMailRequest(getSession,onAuthFailure=()=>{}){return async(action,input,read=false)=>{
 const session=await getSession();if(!session?.access_token)throw Error('login_required');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);
 try{let url='/api/pa-gmail?case_mail=1',options={method:read?'GET':'POST',cache:'no-store',headers:{authorization:'Bearer '+session.access_token},signal:controller.signal};
  if(read)url+='&'+new window.URLSearchParams({...input,action});else{options.headers['content-type']='application/json';options.body=JSON.stringify({...input,action});}
  const response=await fetch(url,options);let data;try{data=await response.json();}catch{throw Error('case_mail_unavailable');}
  if(response.status===401||data.code==='not_authorized')onAuthFailure();
  if(!response.ok||data.ok!==true)throw Error(data.code||'case_mail_unavailable');return data.result;
 }finally{clearTimeout(timer);}
};}
async function attachment(file,kind='normal'){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return {...(kind!=='normal'?{document_kind:kind}:{}),filename:file.name,mime_type:file.type||'application/octet-stream',data:window.btoa(binary).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/u,'')};}
const errors={invalid_origin:'このPreviewの送信準備はOrigin制限で停止しています。設定を迂回しません。',case_mail_recipient_unverified:'宛先の形式、案件記録、メール原本を確認できません。自分自身・自動通知用の宛先には送信できません。',invalid_reply_cc:'CCの形式・件数・Toとの重複を確認してください。',case_mail_stale:'案件または原本が更新されました。プレビューを作り直してください。',reply_operation_blocked:'送信済みまたは結果不明の操作です。同じ操作を再送できません。',case_mail_unavailable:'送信準備を確認できません。送信せず停止しています。'};
export function createCaseMailComposer({request,getCase,getMessages,getFiles=()=>[],readFile,onSent=async()=>{},isAuthenticated=()=>true}){
 let state=null;
 const current=s=>state===s&&isAuthenticated()&&getCase()?.id===s.caseId;
 function clear(){const s=state;state=null;if(!s)return;clearInterval(s.guard);s.gallery?.dispose();s.dialog.remove();s.files=[];s.preview=null;s.payload=null;}
 async function beforeLeave(){if(!state)return true;if(state.busy){state.status.textContent='処理中です。結果の確認をお待ちください。';return false;}if(state.dirty&&!window.confirm('下書きを破棄して移動しますか？'))return false;clear();return true;}
 async function open(kind='new',message=null){
  if(!await beforeLeave())return;const c=getCase();if(!c||!isAuthenticated())return;
  if(message&&(message.inquiry_id&&message.inquiry_id!==c.id||!message.gmail_message_id||!message.gmail_thread_id))return;
  const s={caseId:c.id,kind,files:[],kinds:new Map(),busy:false,dirty:false,attempted:false,version:0};state=s;
  const dialog=el('dialog');dialog.className='case-reply-dialog case-mail-compose';dialog.setAttribute('aria-label','CASE DESKメール作成');s.dialog=dialog;
  const title=el('h2','メール作成');
  const source=el('select');source.setAttribute('aria-label','起点メール');source.append(new Option('案件宛先へ新規メール（新しいスレッド）',''));
  const messages=getMessages().filter(m=>(!m.inquiry_id||m.inquiry_id===c.id)&&m.gmail_message_id&&m.gmail_thread_id).slice(0,200);
  for(const m of messages)source.append(new Option((m.direction==='outbound'?'↑送信 ':'↓受信 ')+(m.subject||'件名未提供')+' / '+(m.sent_at||m.received_at||''),m.gmail_message_id));
  if(message)source.value=message.gmail_message_id;
  const to=el('input'),cc=el('input'),subject=el('input'),body=el('textarea');body.rows=10;body.maxLength=20000;subject.maxLength=240;
  const files=el('input');files.type='file';files.multiple=true;
  const fileList=el('section'),pdfHost=el('div');pdfHost.className='material-grid';
  const existing=el('select');existing.append(new Option('登録済みPDFから選択（任意）',''));const docs=getFiles().filter(x=>x.mime_type==='application/pdf').slice(0,200);docs.forEach((x,i)=>existing.append(new Option(x.filename,String(i))));
  const context=el('div'),operation=el('div'),previewHost=el('section');s.status=el('p');s.status.setAttribute('role','status');
  const selected=()=>messages.find(m=>m.gmail_message_id===source.value);
  const payload=()=>{const m=selected();return {inquiry_id:c.id,kind:m?(m.direction==='outbound'?'contact':'reply'):'new',purpose:kind==='invoice'?'invoice':'general',...(m?{source_id:m.gmail_message_id,thread_id:m.gmail_thread_id}:{}),to:to.value.trim(),cc:list(cc.value),subject:subject.value,body:body.value};};
  const invalidate=()=>{if(s.attempted)return;s.version++;s.dirty=true;s.preview=null;previewHost.replaceChildren();s.status.textContent='変更後の内容で送信前プレビューを確認してください。';};
  for(const input of [to,cc,subject,body])input.oninput=invalidate;
  async function renderFiles(){s.gallery?.dispose();fileList.className='reply-document-files';fileList.replaceChildren(...s.files.map((f,i)=>{const row=el('div');row.className='reply-document-file';const select=el('select');select.setAttribute('aria-label','添付区分 '+(i+1));for(const [value,title]of [['normal','通常ファイル'],['estimate','見積書'],['invoice','請求書']])select.append(new Option(title,value));select.value=s.kinds.get(f)||'normal';select.disabled=s.attempted;select.onchange=()=>{if(s.attempted)return;s.kinds.set(f,select.value);invalidate();};row.append(el('strong',f.name+' / '+f.size+' bytes'),field('添付区分',select));return row;}));pdfHost.replaceChildren();const pdfs=s.files.filter(f=>f.type==='application/pdf');
   if(pdfs.length){s.gallery=createGallery({requestBlob:async item=>pdfs[Number(item.asset_id)],isCurrent:()=>current(s)});s.gallery.mount(pdfHost,pdfs.map((f,i)=>({key:'compose-'+i,asset_id:String(i),asset_kind:'local',filename:f.name,mime_type:f.type,byte_size:f.size})));}
  }
  files.onchange=()=>{if(s.attempted)return;s.files=[...files.files];invalidate();renderFiles();};
  existing.onchange=async()=>{if(!existing.value||s.busy||s.attempted)return;s.busy=true;const version=++s.version;try{const item=docs[Number(existing.value)],blob=await readFile(item);if(!current(s)||version!==s.version)return;s.files=[new window.File([blob],blob.originalFilename||item.filename,{type:'application/pdf'})];invalidate();await renderFiles();}catch{s.status.textContent='原本を取得できません。権限・Origin制限は解除しません。';}finally{if(current(s))s.busy=false;}};
  const showOperation=o=>{s.operation=o;operation.textContent=o?'保存済み送信操作 '+o.operation_id+' / '+o.state+(o.state==='SENT'&&o.history_sync!=='COMPLETE'?' / 送信済み・履歴同期未完了':''): 'この案件の新しいメール作成操作はありません。';if(o&&['UNKNOWN','SENDING'].includes(o.state)){s.status.textContent='結果未確定の送信操作があります。再送せず結果照合を行ってください。';}};
  async function loadContext(){const version=++s.version;prepare.disabled=true;context.textContent='案件・メール原本と宛先を照合中…';
   try{const p=payload(),a=await request('context',{inquiry_id:c.id,kind:p.kind,purpose:p.purpose,...(p.source_id?{source_id:p.source_id,thread_id:p.thread_id}:{})},true);if(!current(s)||s.version!==version)return;
    to.value=a.to;cc.value=a.cc.join(', ');subject.value=a.subject;context.replaceChildren(el('p','照合済みの宛先候補: '+a.allowed_recipients.join(', ')),el('p',a.source_id?'Gmail原本 '+a.source_id+' / thread '+a.thread_id:'案件記録の顧客宛先を使用する新規メールです。'));
    if(a.invoice){const v=a.invoice;context.append(el('p',v.context_unavailable?'契約・正式請求の参考情報は未確認です。':'元契約: '+(v.contract_amount_minor??'未確認')+'円 / 採用済み見積: '+(v.adopted_amount_minor??'未確認')+'円 / 正式請求記録: '+v.billings.length+'件'),el('p','添付は任意です。メール送信は正式請求登録・請求書送付記録・契約額更新・入金処理とは別です。'));}
    s.context=a;prepare.disabled=false;
   }catch(error){if(current(s)){context.textContent=errors[error.message]||'案件・宛先を照合できません。送信操作を停止しています。';}}
  }
  source.onchange=()=>{invalidate();loadContext();};
  const reconcile=btn('保存済み送信結果を照合',async()=>{if(s.busy||!s.operation)return;s.busy=true;try{const r=await request('reconcile',{inquiry_id:c.id,operation_id:s.operation.operation_id});if(current(s)){showOperation(r.operation);s.status.textContent=r.verified?'Gmail原本との照合済みです。':'送信結果は未確定です。自動再送しません。';}}catch{if(current(s))s.status.textContent='照合できません。再送しません。';}finally{if(current(s))s.busy=false;}});
  const prepare=btn('送信前プレビュー',async()=>{
   if(s.busy||s.attempted||!current(s))return;if(s.files.length>10||s.files.reduce((n,f)=>n+f.size,0)>3*1024*1024){s.status.textContent='添付は10件・合計3MiBまでです。';return;}
   s.busy=true;prepare.disabled=true;const version=s.version;previewHost.replaceChildren();
   try{const input={...payload(),attachments:await Promise.all(s.files.map(f=>attachment(f,s.kinds.get(f)||'normal'))),...(s.newOperation?{new_operation:true,previous_operation_id:s.newOperation}:{})};if(!current(s)||version!==s.version)return;const p=await request('preview',input);if(!current(s)||version!==s.version)return;
    if(p.inquiry_id!==c.id||p.kind!==input.kind||p.source_id!==(input.source_id||null)||p.thread_id!==(input.thread_id||null)||p.to!==input.to.toLowerCase()||p.subject!==input.subject||p.operation?.operation_id!==p.operation_id||JSON.stringify(p.cc)!==JSON.stringify([...input.cc].sort())||p.attachments.length!==s.files.length||p.attachments.some((a,i)=>a.filename!==s.files[i].name||a.size!==s.files[i].size||(a.document_kind||'normal')!==(s.kinds.get(s.files[i])||'normal')))throw Error('invalid_confirmation');
    showOperation(p.operation);s.newOperation=null;
    if(p.operation.state!=='PREPARED'){
     s.status.textContent='保存済み操作: '+p.operation.state+'。同じ操作は再送しません。';if(p.operation.state==='SENT')previewHost.append(btn('別の送信操作を新しく準備',()=>{s.newOperation=p.operation_id;s.status.textContent='別の送信であることを確認し、再度プレビューしてください。';}));return;
    }
    s.preview=p;s.payload=input;const frame=el('iframe');frame.title='ARA-TECHメール送信前プレビュー';frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';frame.srcdoc=p.html;
    previewHost.append(el('p','To: '+p.to+' / CC: '+p.cc.join(', ')+' / 件名: '+p.subject),...p.attachments.map(a=>el('p','添付: '+a.filename+' / 区分: '+({normal:'通常ファイル',estimate:'見積書',invoice:'請求書'}[a.document_kind||'normal'])+' / SHA256: '+a.sha256)),el('pre',p.body),frame);
    const confirm=el('input');confirm.type='checkbox';const recipientConfirm=el('input');recipientConfirm.type='checkbox';
    previewHost.append(field('対象案件・宛先・件名・本文・添付を最終確認しました',confirm));
    if(p.recipient_confirmation_needed)previewHost.append(field('案件・Gmail履歴では未照合の宛先 '+p.unverified_recipients.join(', ')+' をOwnerとして確認し、この宛先への送信を指定します',recipientConfirm));
    if(p.invoice)previewHost.append(el('p','通常のメール送信履歴として記録します。正式請求登録・正式な請求書送付済みの状態は変更しません。'));
    const send=btn('最終確認してGmail送信',async()=>{
     if(!confirm.checked||p.recipient_confirmation_needed&&!recipientConfirm.checked||s.busy||s.attempted||!current(s)||s.preview!==p||s.version!==version||Date.parse(p.expires_at)<=Date.now())return;
     s.attempted=true;s.busy=true;send.disabled=true;prepare.disabled=true;for(const x of [source,to,cc,subject,body,files,existing])x.disabled=true;for(const x of fileList.querySelectorAll('select'))x.disabled=true;s.status.textContent='送信結果を確認中…';
     try{const result=await request('send',{...s.payload,operation_id:p.operation_id,confirmation_token:p.confirmation_token,owner_confirmed:true,unverified_recipients_confirmed:p.recipient_confirmation_needed&&recipientConfirm.checked});if(!current(s))return;showOperation(result.operation);s.dirty=false;s.status.textContent=result.history_sync==='COMPLETE'?'送信済み。履歴を更新しました。':'送信済み／履歴同期未完了。再送しないでください。';try{await onSent(c.id,result);}catch{if(current(s))s.status.textContent='送信済み／画面履歴更新は未確認。再送しないでください。';}}
     catch{if(current(s)){s.status.textContent='結果未確認。自動再送しません。保存済み状態を確認します。';try{showOperation((await request('status',{inquiry_id:c.id,operation_id:p.operation_id},true)).operation);}catch{operation.textContent='UNKNOWN / 保存済み状態も未確認です。再送禁止。';}}}finally{if(current(s))s.busy=false;}
    });send.disabled=true;const enabled=()=>{send.disabled=!confirm.checked||p.recipient_confirmation_needed&&!recipientConfirm.checked||s.attempted;};confirm.onchange=recipientConfirm.onchange=enabled;previewHost.append(send);s.status.textContent='プレビュー確認済み。まだ送信していません。';
   }catch(error){if(current(s))s.status.textContent=errors[error.message]||'送信前プレビューを確認できません。送信していません。';}finally{if(current(s)){s.busy=false;prepare.disabled=s.attempted;}}
  });
  dialog.append(title,el('p',(c.inquiry_number||'')+' / '+(c.event_name||'')),field('起点メール',source),context,field('To',to),field('CC',cc),field('件名',subject),field('本文',body),field('添付ファイル（任意・複数可）',files),el('p','添付0件でも送信できます。添付する場合は10件・合計3MiBまでです。'),field('既存のPDF原本',existing));
  dialog.append(fileList,pdfHost,btn('添付を外す',()=>{if(s.attempted)return;s.files=[];files.value='';invalidate();renderFiles();}),operation,reconcile,prepare,s.status,previewHost,btn('メール作成を閉じる',beforeLeave));dialog.addEventListener('cancel',e=>{e.preventDefault();beforeLeave();});document.body.append(dialog);dialog.showModal();s.guard=setInterval(()=>{if(state===s&&!current(s))clear();},1000);await loadContext();
  try{const result=await request('status',{inquiry_id:c.id},true);if(current(s))showOperation(result.operation);}catch{if(current(s))operation.textContent='保存済み状態の読取は未確認です。送信前に永続台帳で再検証します。';}
 }
 return {open,beforeLeave,clear};
}
