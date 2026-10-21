// PAUI-041 uses the existing Owner session and same-origin guarded write route.
// The workspace read adapter remains GET-only. No automatic business operations.
export function createMailDiscovery({read,getSession,isCurrent,onIndexed}){
  const states=new Map();let controller=null;
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function mount(id){
    const host=document.getElementById('mail-discovery');if(!host)return;
    const s=states.get(id);host.replaceChildren();if(!s)return;
    const node=document.createElement('div');node.className='hint';node.setAttribute('role','status');
    node.textContent=s.busy?'保存済みメール情報を読取り中…':s.error?'読取り未完了 / '+s.error:'保存済み情報を表示しています。Gmailの最新確認はこの閲覧では実行していません。'+(s.last_completed_at&&Number.isFinite(Date.parse(s.last_completed_at))?' 最終同期記録 '+new Date(s.last_completed_at).toLocaleString('ja-JP'):' 同期記録未確認');
    host.append(node);
    const candidates=[...new Map((s.candidates||[]).map(c=>[c.gmail_thread_id,c])).values()];
    if(candidates.length){
      const details=document.createElement('details');details.innerHTML='<summary>関連付け判断待ち '+candidates.length+'件</summary>'+candidates.map(c=>'<div class="record"><strong>'+escape(c.subject||'件名未取得')+'</strong><small>'+escape(c.occurred_at?new Date(c.occurred_at).toLocaleString('ja-JP'):'日時未取得')+'</small><a target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(c.gmail_thread_id)+'">Gmailで内容を確認 ↗</a><button class="lightbtn" data-discovery-link="'+escape(c.gmail_thread_id)+'">この案件に関連付ける</button><button class="lightbtn" data-discovery-exclude="'+escape(c.gmail_thread_id)+'">候補から除外</button></div>').join('');
      if(s.confirmation){
        details.open=true;
        const prompt=document.createElement('div');prompt.className='record';prompt.setAttribute('role','group');prompt.setAttribute('aria-label','関連付け判断の確認');
        const selected=document.createElement('strong');selected.textContent=candidates.find(c=>c.gmail_thread_id===s.confirmation.thread)?.subject||'件名未取得';prompt.append(selected);
        const text=document.createElement('p');text.textContent=s.confirmation.decision==='link'?'選択したスレッドを現在の案件へ関連付けます。内容と案件を確認して確定してください。':'選択したスレッドをこの案件の候補から除外します。';prompt.append(text);
        const yes=document.createElement('button');yes.className='lightbtn';yes.dataset.discoveryConfirm=s.confirmation.thread;yes.textContent=s.confirmation.decision==='link'?'確定して関連付ける':'確定して除外する';prompt.append(yes);
        const cancel=document.createElement('button');cancel.className='lightbtn';cancel.dataset.discoveryCancel='true';cancel.textContent='キャンセル';prompt.append(cancel);details.append(prompt);
      }
      details.onclick=async event=>{
        const b=event.target.closest('[data-discovery-link],[data-discovery-exclude],[data-discovery-confirm],[data-discovery-cancel]');if(!b||s.busy)return;
        if(b.dataset.discoveryCancel){delete s.confirmation;mount(id);return;}
        if(!b.dataset.discoveryConfirm){s.confirmation={thread:b.dataset.discoveryLink||b.dataset.discoveryExclude,decision:b.dataset.discoveryLink?'link':'exclude'};mount(id);return;}
        const {thread,decision}=s.confirmation||{},c=candidates.find(x=>x.gmail_thread_id===thread);
        if(!c||b.dataset.discoveryConfirm!==thread)return;
        delete s.confirmation;
        s.busy=true;mount(id);
        try{await write({action:'case_discovery_decide',inquiry_id:id,gmail_thread_id:thread,fingerprint:c.fingerprint,decision});await onIndexed(id);Object.assign(s,await read('/data/mail-discovery/'+id));s.error=null;}
        catch{s.error='関連付け判断を確定できません。次回表示時に状態を確認します。';}
        finally{s.busy=false;if(isCurrent(id))mount(id);}
      };host.append(details);
    }
  }
  async function write(body){
    if(body.action!=='case_discovery_decide')throw Error('discovery_action_refused');
    const session=await getSession();if(!session?.access_token)throw Error('login_required');
    const active=new AbortController();controller=active;const timer=setTimeout(()=>active.abort(),55000);
    try{
      const response=await fetch('/api/pa-gmail',{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+session.access_token,'content-type':'application/json'},body:JSON.stringify(body),signal:active.signal});
      if(!response.ok)throw Error('discovery_unavailable');const data=await response.json();if(data.ok!==true)throw Error('invalid_discovery_response');return data.result;
    }finally{clearTimeout(timer);if(controller===active)controller=null;}
  }
  async function check(id){
    if(states.get(id)?.busy)return;
    const s={busy:true};states.set(id,s);mount(id);
    try{
      Object.assign(s,await read('/data/mail-discovery/'+id));
      // Saved metadata and candidates only. No sync, paging or onIndexed side effects.
    }catch{s.error='保存済みのメール探索情報を読取れませんでした。Gmail同期は実行していません。';}
    finally{s.busy=false;if(isCurrent(id))mount(id);}
  }
  return {mount,check,cancel(){controller?.abort();controller=null;states.clear();}};
}
