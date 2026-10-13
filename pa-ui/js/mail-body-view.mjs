import {fullBody,savedExcerpt} from './mail-model.mjs';
import {purposeExcerpt} from './mail-purpose.mjs';

// Private session memory only. Keys bind case and message; no storage or HTML mount.
export function createMailBodyView({request,isAuthenticated,limit=2}) {
  const cache=new Map();let generation=0,active=0,queue=[],observer=null;
  const key=(id,row)=>JSON.stringify([id,row.gmail_message_id]);
  function pump(){
    while(active<limit&&queue.length){
      const job=queue.shift();
      if(job.generation!==generation||!isAuthenticated()||!job.valid()){cache.delete(job.key);job.resolve();continue;}
      active++;job.entry.state='loading';job.entry.notify();
      Promise.resolve().then(()=>request(job.id,job.row)).then(result=>{
        if(job.generation!==generation||!isAuthenticated())return;
        if(result.gmail_message_id!==job.row.gmail_message_id || (result.inquiry_id&&result.inquiry_id!==job.id))throw {status:403,code:'mail_binding_mismatch'};
        job.entry.parts=fullBody(result);job.entry.state='ready';
      }).catch(error=>{if(job.generation===generation){job.entry.state='error';job.entry.error=error;}})
        .finally(()=>{active--;if(job.generation===generation)job.entry.notify();job.resolve();pump();});
    }
  }
  function load(id,row,entry,valid){
    if(entry.state==='loading'||entry.state==='queued'||entry.state==='ready')return entry.promise;
    entry.state='queued';entry.promise=new Promise(resolve=>queue.push({id,row,entry,valid,key:key(id,row),generation,resolve}));entry.notify();pump();return entry.promise;
  }
  function detach(){observer?.disconnect();observer=null;for(const e of cache.values())e.notify=()=>{};}
  function mount(container,id,row,valid){
    const k=key(id,row);let entry=cache.get(k);
    if(!entry){entry={state:row.body_text||row.body_html?'ready':'idle',parts:row.body_text||row.body_html?fullBody(row):null,expanded:false,quoteOpen:false,notify:()=>{}};cache.set(k,entry);}
    const body=container.querySelector('.mail-excerpt'),button=container.querySelector('[data-body-read]');
    const quoted=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');
    quoted.dataset.quotedBody='true';summary.textContent='引用部分を表示';quoted.append(summary,text);body.after(quoted);
    quoted.addEventListener('toggle',()=>{entry.quoteOpen=quoted.open;});
    function draw(){
      if(!valid()||!container.isConnected)return;
      const failed=entry.state==='error',parts=entry.parts,busy=['loading','queued'].includes(entry.state);
      body.classList.toggle('expanded',entry.expanded&&!!parts);body.classList.toggle('unavailable',failed);
      body.textContent=failed?(entry.error?.status===401||entry.error?.status===403?'認証・ACL拒否 / '+entry.error.status+' / 本文を取得できません':'本文の取得に失敗しました / 再取得できます'):
        parts?(parts.empty?'取得成功 / 空本文':entry.expanded?parts.text||'新規本文なし（引用のみ）':purposeExcerpt(parts.text)||'新規本文なし（引用のみ）'):
        savedExcerpt(row)||(busy?'本文を取得中…':'表示時に本文を取得します…');
      button.textContent=failed?'本文を再取得':entry.expanded?'閉じる':'全文を表示';button.disabled=busy;
      button.setAttribute('aria-expanded',String(entry.expanded));
      text.textContent=parts?.quoted||'';quoted.hidden=!(entry.expanded&&parts?.quoted);quoted.open=!quoted.hidden&&entry.quoteOpen;
    }
    entry.notify=draw;draw();
    button.onclick=async()=>{
      if(!valid())return;
      if(entry.state==='error'){await load(id,row,entry,valid);return;}
      if(!entry.parts)await load(id,row,entry,valid);
      if(!valid()||entry.state!=='ready')return;
      entry.expanded=!entry.expanded;if(!entry.expanded)entry.quoteOpen=false;draw();
    };
    if(entry.state==='idle'){
      observer??=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){observer.unobserve(e.target);e.target._loadBody?.();}},{rootMargin:'160px'});
      container._loadBody=()=>{if(entry.state==='idle')load(id,row,entry,valid);};observer.observe(container);
    }
  }
  return {mount,detach,clear(){detach();generation++;cache.clear();for(const job of queue)job.resolve();queue=[];}};
}
