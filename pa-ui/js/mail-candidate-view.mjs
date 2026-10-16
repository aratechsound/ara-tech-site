import {createMailBodyView} from './mail-body-view.mjs';
import {mailRow,updateMailEnvelope} from './mail-row.mjs';
// Decisions remain explicit, thread/fingerprint-bound Owner operations.
// Candidate display and body reads never start sync or a decision.
export function createCandidateMailView({read,getSession,isCurrent,onIndexed}){
  const states=new Map();let controller=null,epoch=0,activeCase=null;
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const identity=c=>JSON.stringify([c.gmail_message_id,c.gmail_thread_id,c.fingerprint]);
  const bodies=createMailBodyView({
    isAuthenticated:()=>!!activeCase&&isCurrent(activeCase),
    keyOf:(id,row)=>JSON.stringify([id,row.gmail_message_id,row.gmail_thread_id,row.fingerprint]),
    request:async(id,row)=>{
      const result=await read('/data/mail-candidate-body/'+[id,row.gmail_thread_id,row.gmail_message_id,row.fingerprint].map(encodeURIComponent).join('/'));
      if(result.inquiry_id!==id||result.gmail_message_id!==row.gmail_message_id||result.gmail_thread_id!==row.gmail_thread_id||result.fingerprint!==row.fingerprint)throw {status:403,code:'mail_candidate_mismatch'};
      return result;
    },
    onReady:(container,result)=>updateMailEnvelope(container,result),
    excerptText:text=>text.split('\n').filter(line=>line.trim()).slice(0,3).join('\n'),
    errorText:error=>'本文を取得できません'+([401,403].includes(error?.status)?' / 認証・ACL拒否':'')
  });
  function mount(id){
    const host=document.getElementById('mail-discovery');if(!host)return;
    activeCase=id;bodies.detach();const s=states.get(id);host.replaceChildren();if(!s)return;
    const node=document.createElement('div');node.className='hint';node.setAttribute('role','status');
    node.textContent=s.busy?'関連付け候補を取得中…':s.error?'確認未完了 / '+s.error:s.enabled===false?'Gmail自動確認は未有効です。保存済み情報を表示しています。':s.complete?'保存済み確認結果 '+new Date(s.last_completed_at).toLocaleString('ja-JP'):'保存済み候補を表示しています。未取得範囲があります。';host.append(node);
    const candidates=[...new Map((s.candidates||[]).map(c=>[identity(c),c])).values()];
    if(!candidates.length)return;
    const details=document.createElement('details');details.className='group';details.open=!!(s.expanded||s.confirmation);
    const summary=document.createElement('summary');summary.textContent='関連付け判断待ち '+candidates.length+'件';details.append(summary);
    details.addEventListener('toggle',()=>{s.expanded=details.open;});
    const list=document.createElement('div');list.className='mail-list';details.append(list);
    for(const c of candidates){
      const actions='<span class="mail-review-actions"><button class="lightbtn" data-discovery-link="'+escape(c.gmail_thread_id)+'" data-review-message="'+escape(c.gmail_message_id)+'">この案件に関連付ける</button><button class="lightbtn" data-discovery-exclude="'+escape(c.gmail_thread_id)+'" data-review-message="'+escape(c.gmail_message_id)+'">候補から除外</button></span>';
      const at=c.occurred_at,when=at&&Number.isFinite(Date.parse(at))?new Date(at).toLocaleString('ja-JP'):'日時未取得';
      list.insertAdjacentHTML('beforeend',mailRow(c,{dateText:when,headingActions:actions,actions:false,candidate:true}));
      const container=list.lastElementChild;
      bodies.mount(container,id,c,()=>isCurrent(id)&&states.get(id)===s&&candidates.some(row=>identity(row)===identity(c)));
    }
    if(s.confirmation){
      details.open=true;
      const prompt=document.createElement('div');prompt.className='record';prompt.setAttribute('role','group');prompt.setAttribute('aria-label','関連付け判断の確認');
      const selected=document.createElement('strong');selected.textContent=candidates.find(c=>identity(c)===s.confirmation.key)?.subject||'件名未取得';prompt.append(selected);
      const text=document.createElement('p');text.textContent=s.confirmation.decision==='link'?'選択したスレッドを現在の案件へ関連付けます。内容と案件を確認して確定してください。':'選択したスレッドをこの案件の候補から除外します。';prompt.append(text);
      const yes=document.createElement('button');yes.className='lightbtn';yes.dataset.discoveryConfirm=s.confirmation.thread;yes.textContent=s.confirmation.decision==='link'?'確定して関連付ける':'確定して除外する';prompt.append(yes);
      const cancel=document.createElement('button');cancel.className='lightbtn';cancel.dataset.discoveryCancel='true';cancel.textContent='キャンセル';prompt.append(cancel);details.append(prompt);
    }
    details.onclick=async event=>{
      const b=event.target.closest('[data-discovery-link],[data-discovery-exclude],[data-discovery-confirm],[data-discovery-cancel]');if(!b||s.busy||!isCurrent(id))return;
      if(b.dataset.discoveryCancel){delete s.confirmation;mount(id);return;}
      if(!b.dataset.discoveryConfirm){const c=candidates.find(row=>row.gmail_message_id===b.dataset.reviewMessage&&row.gmail_thread_id===(b.dataset.discoveryLink||b.dataset.discoveryExclude));if(!c)return;s.confirmation={thread:c.gmail_thread_id,key:identity(c),decision:b.dataset.discoveryLink?'link':'exclude'};mount(id);return;}
      const {thread,key,decision}=s.confirmation||{},c=candidates.find(row=>identity(row)===key);
      if(!c||b.dataset.discoveryConfirm!==thread)return;
      delete s.confirmation;s.busy=true;mount(id);
      try{await write({action:'case_discovery_decide',inquiry_id:id,gmail_thread_id:thread,fingerprint:c.fingerprint,decision});if(!isCurrent(id))return;await onIndexed(id);if(!isCurrent(id))return;Object.assign(s,await read('/data/mail-discovery/'+id));s.error=null;}
      catch{s.error='関連付け判断を確定できません。次回表示時に状態を確認します。';}
      finally{s.busy=false;if(isCurrent(id)&&states.get(id)===s)mount(id);}
    };host.append(details);
  }
  async function write(body){
    if(body.action!=='case_discovery_decide'||!isCurrent(body.inquiry_id))throw Error('case_changed');const ticket=epoch;
    const session=await getSession();if(!session?.access_token)throw Error('login_required');
    if(ticket!==epoch||!isCurrent(body.inquiry_id))throw Error('case_changed');
    const active=new AbortController();controller=active;const timer=setTimeout(()=>active.abort(),55000);
    try{const response=await fetch('/api/pa-gmail',{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+session.access_token,'content-type':'application/json'},body:JSON.stringify(body),signal:active.signal});if(!response.ok)throw Error('discovery_unavailable');const data=await response.json();if(data.ok!==true)throw Error('invalid_discovery_response');return data.result;}
    finally{clearTimeout(timer);if(controller===active)controller=null;}
  }
  async function check(id){
    if(states.get(id)?.busy)return;const ticket=epoch,s={busy:true};states.set(id,s);mount(id);
    try{const value=await read('/data/mail-discovery/'+id);if(ticket===epoch&&isCurrent(id))Object.assign(s,value);}
    catch{s.error='保存済みの関連付け候補を取得できません。';}
    finally{s.busy=false;if(ticket===epoch&&isCurrent(id)&&states.get(id)===s)mount(id);}
  }
  return {mount,check,detach:()=>bodies.detach(),cancel(){++epoch;controller?.abort();controller=null;activeCase=null;states.clear();bodies.clear();document.getElementById('mail-discovery')?.replaceChildren();}};
}
