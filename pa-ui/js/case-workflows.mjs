// Existing authenticated routes only. No implicit send or candidate adoption.
export function createWorkflowRequest(getSession){
  return async function request(action,input){
    const endpoint=action==='candidate_backfill'?'/api/pa-portal':['reply_preview','send_reply'].includes(action)?'/api/pa-gmail':null;
    if(!endpoint)throw Error('workflow_action_refused');
    const session=await getSession();if(!session?.access_token)throw Error('login_required');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);
    try{
      const response=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+session.access_token,'content-type':'application/json'},body:JSON.stringify({...input,action}),signal:controller.signal});
      const result=await response.json();
      if(!response.ok||result.ok!==true)throw Object.assign(Error(result.code||'workflow_unavailable'),{status:response.status});
      return result;
    }finally{clearTimeout(timer);}
  };
}

export function createPortalCandidateBridge({request,isCurrent,onStatus}){
  const active=new Map(),states=new Map();let generation=0,blocked=false,sequence=0;
  const safeReason=error=>({login_required:'認証失効',not_authorized:'権限未確認',invalid_origin:'Origin拒否',rate_limited:'回数制限',candidate_message_binding_mismatch:'案件・メール不一致',candidate_attachment_binding_mismatch:'添付不一致',candidate_identity_unavailable:'原本identity未取得',candidate_legacy_identity_unresolved:'旧原本identity未確認',invalid_candidate_result:'応答不整合'})[error?.message]||(error?.name==='AbortError'?'通信中断':'取得・連携失敗');
  const authFailure=error=>error?.status===401||error?.status===403||['login_required','not_authorized','invalid_origin'].includes(error?.message);
  const keyFor=(caseId,messageId)=>caseId+':'+messageId;
  function records(caseId){return [...states.values()].filter(s=>s.caseId===caseId).map(s=>({...s}));}
  function publish(caseId){
    if(!isCurrent(caseId))return;
    const rows=records(caseId),pending=rows.filter(s=>s.state==='pending'),failed=rows.filter(s=>s.state==='failed'),queued=rows.filter(s=>s.state==='queued');
    const detail=failed.map(s=>s.messageId+'：'+s.reason+(s.autoAttempts>=2?'（自動回復上限）':'')).join(' / ');
    onStatus(caseId,pending.length?'資料候補へ連携中…'+(detail?' 未確認 '+detail:''):failed.length?'資料候補の連携は一部未確認です。'+detail+'。該当メールで明示的に再試行できます。':queued.length?'資料候補の未処理 '+queued.length+'通。次回同期または索引済み添付の再照合で確認してください。':'資料候補へ連携済み。採用・最新版切替・公開は資料ポータルで確認してください。');
  }
  async function link(caseId,messageId,{automatic=false,threadId}={}){
    const key=keyFor(caseId,messageId);if(active.has(key))return active.get(key);
    if(!isCurrent(caseId)||blocked)throw Error('login_required');
    if(!/^[A-Za-z0-9_-]{1,200}$/u.test(messageId))throw Error('invalid_candidate_message');
    const previous=states.get(key);
    if(automatic&&(previous?.state==='success'||(previous?.autoAttempts||0)>=2))return;
    if(!previous&&states.size>=500)throw Error('candidate_tracking_limit');
    const epoch=generation,s={caseId,messageId,threadId:threadId||previous?.threadId,state:'pending',reason:'',sequence:++sequence,autoAttempts:(previous?.autoAttempts||0)+(automatic?1:0)};states.set(key,s);
    const pending=(async()=>{
      publish(caseId);
      try{
        const value=await request('candidate_backfill',{inquiry_id:caseId,gmail_message_id:messageId,preserve_existing:true,...(s.threadId?{gmail_thread_id:s.threadId}:{})});
        if(!value.result||!Number.isInteger(value.result.detected)||!Number.isInteger(value.result.pending))throw Error('invalid_candidate_result');
        if(value.result.unresolved_identity_count)throw Error('candidate_legacy_identity_unresolved');
        if(epoch===generation&&isCurrent(caseId))s.state='success';return value;
      }catch(error){if(epoch===generation){s.state='failed';s.reason=safeReason(error);if(authFailure(error))blocked=true;}throw error;}
    })();active.set(key,pending);
    try{return await pending;}finally{if(active.get(key)===pending)active.delete(key);if(epoch===generation)publish(caseId);}
  }
  const eligible=(caseId,row)=>row?.attachment_metadata?.length&&(!row.inquiry_id||row.inquiry_id===caseId)&&/^[A-Za-z0-9_-]{1,200}$/u.test(row.gmail_message_id||'');
  async function process(caseId,rows,automatic){
    const epoch=generation;let attempted=0;
    for(const row of rows){
      if(!isCurrent(caseId)||epoch!==generation||blocked)break;
      if(!eligible(caseId,row))continue;
      try{await link(caseId,row.gmail_message_id,{automatic,threadId:row.gmail_thread_id});}catch{ /* Each result remains visible; independent messages continue. */ }
      if(++attempted>=20)break;
    }
    return {attempted,remaining:Math.max(0,rows.length-attempted),results:records(caseId)};
  }
  async function newlyIndexed(caseId,before,rows){
    if(!isCurrent(caseId))return;
    for(const row of rows||[])if(eligible(caseId,row)&&!before.has(row.gmail_message_id)&&!states.has(keyFor(caseId,row.gmail_message_id))&&states.size<500)states.set(keyFor(caseId,row.gmail_message_id),{caseId,messageId:row.gmail_message_id,threadId:row.gmail_thread_id,state:'queued',autoAttempts:0,sequence:0});
    const selected=(rows||[]).filter(row=>{
      const old=states.get(keyFor(caseId,row.gmail_message_id));
      return eligible(caseId,row)&&(!before.has(row.gmail_message_id)||['failed','queued'].includes(old?.state))&&old?.state!=='success'&&(old?.autoAttempts||0)<2;
    });
    return process(caseId,selected,true);
  }
  async function recheck(caseId,rows){
    const selected=(rows||[]).filter(row=>eligible(caseId,row)).sort((a,b)=>(states.get(keyFor(caseId,a.gmail_message_id))?.sequence||0)-(states.get(keyFor(caseId,b.gmail_message_id))?.sequence||0));
    const result=await process(caseId,selected,false);
    if(result.remaining&&isCurrent(caseId))onStatus(caseId,'最大20通を再照合しました。残り '+result.remaining+'通。'+records(caseId).filter(s=>s.state==='failed').map(s=>s.messageId+'：'+s.reason).join(' / '));
    return result;
  }
  function cancel(){generation++;const affected=new Set();for(const s of states.values())if(s.state==='pending'){s.state='failed';s.reason='処理中断・結果未確認';affected.add(s.caseId);}for(const caseId of affected)publish(caseId);}
  function clear(){cancel();states.clear();active.clear();blocked=false;}
  return {link,newlyIndexed,recheck,records,cancel,clear};
}

const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
const control=(label,element)=>{const wrap=node('label');wrap.append(node('span',label),element);return wrap;};
const button=(label,click)=>{const b=node('button',label);b.type='button';b.onclick=click;return b;};
const replySubject=value=>/^re\s*:/iu.test(value)?String(value):('Re: '+String(value||'')).slice(0,240);
const ccValues=value=>[...new Set(String(value||'').split(/[;,\n]/u).map(x=>x.trim().toLowerCase()).filter(Boolean))];
const previewError=error=>({reply_already_attempted:'同じ返信の送信操作を実行済み、または確認上限です。再送せずGmailと履歴を確認してください。',invalid_origin:'この環境のOriginは許可されていません。返信プレビューを実行できません。',not_authorized:'既存Owner認証を確認できません。送信していません。',login_required:'既存Owner認証を確認できません。送信していません。',rate_limited:'操作回数の上限です。時間を置いてプレビューを確認してください。',invalid_reply_cc:'CCは選択メールの参加者の範囲で指定してください。',reply_attachments_too_large:'添付は10件・合計3MiBまでです。',invalid_reply_source:'選択メールと案件の対応を確認できません。送信していません。',reply_target_unavailable:'このメールの返信先を安全に確認できません。送信していません。'})[error.message]||'返信プレビューを確認できません。送信していません。';
async function attachmentsPayload(files){
  if(files.length>10||files.reduce((sum,f)=>sum+f.size,0)>3*1024*1024||files.some(f=>!f.size))throw Error('reply_attachments_too_large');
  return Promise.all(files.map(async file=>{
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
    for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
    return {filename:file.name,mime_type:file.type||'application/octet-stream',data:window.btoa(binary).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/u,'')};
  }));
}
export function createReplyComposer({request,getCase,onSent}){
  let state=null;const attemptedReplies=new Set();
  const current=s=>state===s&&getCase()?.id===s.caseId;
  function clear(){const s=state;state=null;if(s){s.leaveResolve?.(false);s.dialog.remove();s.files=[];s.preview=null;s.payload=null;}}
  async function beforeLeave(){
    const s=state;if(!s)return true;
    if(s.busy){s.status.textContent='処理中です。結果を確認してから移動してください。';return false;}
    if(!s.dirty){clear();return true;}
    if(s.leaveResolve)return false;
    s.warning.replaceChildren(node('p','下書きを破棄しますか？ 案件を切り替えると、この下書きは失われます。'));
    return new Promise(resolve=>{
      s.leaveResolve=resolve;
      s.warning.append(button('編集へ戻る',()=>{s.leaveResolve=null;s.warning.replaceChildren();resolve(false);}),button('下書きを破棄',()=>{s.leaveResolve=null;clear();resolve(true);}));
    });
  }
  async function open(message){
    if(message.direction!=='inbound'||!message.gmail_message_id||!message.gmail_thread_id)return;
    const selectedCase=getCase();if(!selectedCase||message.inquiry_id&&message.inquiry_id!==selectedCase.id)return;
    if(!await beforeLeave())return;
    const c=getCase();if(!c||c.id!==selectedCase.id)return;
    const s={caseId:c.id,messageId:message.gmail_message_id,threadId:message.gmail_thread_id,recipient:String(message.from_address||''),subject:replySubject(message.subject),files:[],revision:0,dirty:false,busy:false,attempted:false,preview:null};state=s;
    const dialog=node('dialog');dialog.className='case-reply-dialog';dialog.setAttribute('aria-label','Gmail返信作成');s.dialog=dialog;
    const title=node('h2','選択メールへ返信');const binding=node('p',(c.inquiry_number||'')+' / '+(c.event_name||'')+' / '+(message.subject||'')+' / '+(message.received_at||''));binding.className='hint';
    const to=node('input');to.value=s.recipient;to.readOnly=true;
    const subject=node('input');subject.value=s.subject;subject.readOnly=true;
    const cc=node('input');cc.value=ccValues(message.cc_addresses?.join(', ')).filter(x=>x!==s.recipient.toLowerCase()&&!/^aratechsound@gmail\.com$/iu.test(x)).join(', ');
    const body=node('textarea');body.rows=10;body.maxLength=20000;
    const files=node('input');files.type='file';files.multiple=true;
    const fileList=node('p');s.status=node('p');s.status.setAttribute('role','status');s.previewHost=node('section');s.warning=node('section');s.warning.setAttribute('role','group');s.warning.setAttribute('aria-label','下書き破棄の確認');
    const invalidate=()=>{if(s.attempted)return;s.revision++;s.dirty=true;s.preview=null;s.payload=null;s.previewHost.replaceChildren();s.status.textContent='変更後の内容でプレビューを確認してください。';};
    cc.oninput=body.oninput=invalidate;
    files.onchange=()=>{s.files=[...files.files];fileList.textContent=s.files.map(f=>f.name+' ('+f.size+' bytes)').join(' / ');invalidate();};
    const removeFiles=button('添付を外す',()=>{s.files=[];files.value='';fileList.textContent='';invalidate();});
    const preview=button('返信プレビュー',async()=>{
      if(s.busy||s.attempted||!current(s))return;
      if(!body.value.trim()){s.status.textContent='本文を入力してください。';return;}
      s.busy=true;preview.disabled=true;s.preview=null;s.previewHost.replaceChildren();s.status.textContent='返信先と原本メールを確認中…';
      const revision=s.revision;
      try{
        const attachments=await attachmentsPayload(s.files);if(!current(s)||revision!==s.revision)return;
        const payload={inquiry_id:s.caseId,reply_source_message_id:s.messageId,reply_source_thread_id:s.threadId,body:body.value.trim(),cc_addresses:ccValues(cc.value),attachments,mode:'normal'};
        const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({...payload,recipient:s.recipient,subject:s.subject})))),x=>x.toString(16).padStart(2,'0')).join('');
        if(!current(s)||revision!==s.revision)return;
        if(attemptedReplies.has(fingerprint)||attemptedReplies.size>=100)throw Error('reply_already_attempted');
        const result=await request('reply_preview',payload);if(!current(s)||revision!==s.revision)return;
        const p=result.preview;
        if(!p||p.inquiry_id!==s.caseId||p.gmail_thread_id!==s.threadId||p.reply_source_message_id!==s.messageId||p.reply_source_explicit!==true||p.mode!=='normal'||p.recipient.toLowerCase()!==s.recipient.toLowerCase()||p.subject!==s.subject||JSON.stringify(p.cc_addresses)!==JSON.stringify(payload.cc_addresses)||typeof p.body!=='string'||typeof p.html!=='string'||!p.confirmation_token||!Number.isFinite(Date.parse(p.expires_at))||Date.parse(p.expires_at)<=Date.now()||!Array.isArray(p.attachments)||JSON.stringify(p.attachments.map(a=>[a.filename,a.size]))!==JSON.stringify(s.files.map(f=>[f.name,f.size])))throw Error('invalid_reply_binding');
        s.preview=p;s.payload=payload;s.status.textContent='プレビュー確認済み。まだ送信していません。';
        const summary=node('p','To: '+p.recipient+' / CC: '+p.cc_addresses.join(', ')+' / 件名: '+p.subject+' / 添付: '+p.attachments.map(a=>a.filename).join(', '));
        const text=node('pre',p.body);const frame=node('iframe');frame.title='ARA-TECH返信プレビュー';frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';frame.srcdoc=p.html;
        const confirm=button('送信内容を最終確認',()=>{
          if(!current(s)||s.preview!==p||revision!==s.revision||s.attempted||Date.parse(p.expires_at)<=Date.now()){s.status.textContent='プレビューの再確認が必要です。';return;}
          confirm.disabled=true;
          const check=node('input');check.type='checkbox';
          const send=button('最終確認して送信',async()=>{
            if(!check.checked||s.busy||s.attempted||!current(s)||s.preview!==p||revision!==s.revision||Date.parse(p.expires_at)<=Date.now())return;
            if(attemptedReplies.has(fingerprint)||attemptedReplies.size>=100){s.status.textContent='同じ返信の送信操作を実行済み、または確認上限です。再送せずGmailと履歴を確認してください。';return;}
            attemptedReplies.add(fingerprint);s.attempted=true;s.busy=true;send.disabled=true;preview.disabled=true;for(const el of [cc,body,files,removeFiles])el.disabled=true;
            s.status.textContent='送信結果を確認中…';
            try{
              const result=await request('send_reply',{...s.payload,confirmation_token:p.confirmation_token});
              if(!current(s))return;
              if(result.result?.gmail_thread_id!==s.threadId||!result.result?.gmail_message_id)throw Error('invalid_reply_result');
              s.status.textContent='送信済み。履歴を更新しています。';s.dirty=false;
              try{await onSent(s.caseId,result.result);if(current(s))s.status.textContent='送信済み。履歴を更新しました。';}
              catch{if(current(s))s.status.textContent='送信済み。履歴更新は未確認です。再送せず履歴を確認してください。';}
            }catch{if(current(s))s.status.textContent='送信結果は未確認です。自動再送しません。Gmailと履歴を確認してください。';}
            finally{if(current(s))s.busy=false;}
          });send.disabled=true;check.onchange=()=>{send.disabled=!check.checked||s.attempted;};
          s.previewHost.append(node('p','この受信メールへの通常返信です。見積送信・正式受注送信とは別です。'),control('宛先・CC・件名・本文・添付と対象メールを確認しました',check),send);
        });s.previewHost.append(summary,text,frame,confirm);
      }catch(error){if(current(s)){s.preview=null;s.status.textContent=previewError(error);}}
      finally{if(current(s)){s.busy=false;preview.disabled=s.attempted;}}
    });
    dialog.append(title,binding,node('p','Toと件名は選択メールから確定します。CCは元メールの参加者の範囲で指定できます。'),control('To',to),control('CC',cc),control('件名',subject),control('本文',body),control('添付',files),fileList,removeFiles,preview,s.status,s.previewHost,s.warning,button('返信を閉じる',beforeLeave));
    dialog.addEventListener('cancel',event=>{event.preventDefault();beforeLeave();});document.body.append(dialog);dialog.showModal();body.focus();
  }
  return {open,beforeLeave,clear};
}
