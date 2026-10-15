// PAUI-041 uses the existing Owner session and same-origin guarded write route.
// The workspace read adapter remains GET-only. No automatic business operations.
export function createMailDiscovery({read,getSession,isCurrent,onIndexed}){
  const states=new Map();let controller=null;
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function mount(id){
    const host=document.getElementById('mail-discovery');if(!host)return;
    const s=states.get(id);host.replaceChildren();if(!s)return;
    const node=document.createElement('div');node.className='hint';node.setAttribute('role','status');
    node.textContent=s.busy?'Gmailの最新状態を確認中…':s.error?'確認未完了 / '+s.error:s.enabled===false?'Gmail自動確認は未有効です。保存済み情報を表示しています。':s.complete?'最新確認済み '+new Date(s.last_completed_at).toLocaleString('ja-JP'):'確認未完了 / 未取得範囲があります。次回表示時に再照合します。';
    host.append(node);
    const candidates=[...new Map((s.candidates||[]).map(c=>[c.gmail_thread_id,c])).values()];
    if(candidates.length){
      const details=document.createElement('details');details.innerHTML='<summary>関連付け判断待ち '+candidates.length+'件</summary>'+candidates.map(c=>'<div class="record"><strong>'+escape(c.subject||'件名未取得')+'</strong><small>'+escape(c.occurred_at?new Date(c.occurred_at).toLocaleString('ja-JP'):'日時未取得')+'</small><a target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(c.gmail_thread_id)+'">Gmailで内容を確認 ↗</a><button class="lightbtn" data-discovery-link="'+escape(c.gmail_thread_id)+'">この案件に関連付ける</button><button class="lightbtn" data-discovery-exclude="'+escape(c.gmail_thread_id)+'">候補から除外</button></div>').join('');
      details.onclick=async event=>{
        const b=event.target.closest('[data-discovery-link],[data-discovery-exclude]');if(!b||s.busy)return;
        const thread=b.dataset.discoveryLink||b.dataset.discoveryExclude,c=candidates.find(x=>x.gmail_thread_id===thread),decision=b.dataset.discoveryLink?'link':'exclude';
        if(!c||!confirm(decision==='link'?'このスレッドを現在の案件へ関連付けます。内容と案件を確認しましたか？':'この案件の関連メール候補から除外しますか？'))return;
        s.busy=true;mount(id);
        try{await write({action:'case_discovery_decide',inquiry_id:id,gmail_thread_id:thread,fingerprint:c.fingerprint,decision});await onIndexed(id);Object.assign(s,await read('/data/mail-discovery/'+id));s.error=null;}
        catch{s.error='関連付け判断を確定できません。次回表示時に状態を確認します。';}
        finally{s.busy=false;if(isCurrent(id))mount(id);}
      };host.append(details);
    }
  }
  async function write(body){
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
      if(s.enabled!==true)return;
      // Continue persisted pages automatically. The existing rate gate bounds
      // work; a partial response or 429 stays visibly incomplete.
      for(let page=0;page<25&&isCurrent(id);page++){
        const result=await write({action:'case_discovery_sync',inquiry_id:id});Object.assign(s,result);
        await onIndexed(id);
        if(result.last_error){s.error='Gmail取得に失敗しました。新着なしとは判定していません。';break;}
        if(result.has_more===false)break;
      }
      Object.assign(s,await read('/data/mail-discovery/'+id));
    }catch{s.error='Gmailの最新確認を完了できませんでした。保存済みメールを表示しています。';}
    finally{s.busy=false;if(isCurrent(id))mount(id);}
  }
  return {mount,check,cancel(){controller?.abort();controller=null;states.clear();}};
}
