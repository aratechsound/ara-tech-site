import {fullBody,savedExcerpt} from './mail-model.mjs';

// Private session memory only. Keys bind case and message; no storage or HTML mount.
export function createMailBodyView({request,isAuthenticated,limit=2}) {
  const cache=new Map();let generation=0,active=0,queue=[],observer=null;
  const key=(id,row,delivery)=>JSON.stringify(row?[id,'mail',row.gmail_message_id]:[id,'delivery',delivery.id]);
  function pump(){
    while(active<limit&&queue.length){
      const job=queue.shift();
      if(job.generation!==generation||!isAuthenticated()||!job.valid()){cache.delete(job.key);job.resolve();continue;}
      active++;job.entry.state='loading';job.entry.notify();
      Promise.resolve().then(()=>request(job.id,job.row)).then(result=>{
        if(job.generation!==generation||!isAuthenticated())return;
        if(result.gmail_message_id!==job.row.gmail_message_id || (result.inquiry_id&&result.inquiry_id!==job.id))throw {status:403,code:'mail_binding_mismatch'};
        job.entry.parts=fullBody(result);job.entry.preview=savedExcerpt(result);job.entry.state='ready';
      }).catch(error=>{if(job.generation===generation){job.entry.state='error';job.entry.error=error;}})
        .finally(()=>{active--;if(job.generation===generation)job.entry.notify();job.resolve();pump();});
    }
  }
  function load(id,row,entry,valid){
    if(entry.state==='loading'||entry.state==='queued'||entry.state==='ready')return entry.promise;
    entry.state='queued';entry.promise=new Promise(resolve=>queue.push({id,row,entry,valid,key:key(id,row),generation,resolve}));entry.notify();pump();return entry.promise;
  }
  function detach(){observer?.disconnect();observer=null;for(const e of cache.values())e.notify=()=>{};}
  function mount(container,id,row,valid,{delivery,fallback,displayText=value=>value}={}){
    const body=container.querySelector('.mail-excerpt');
    const button=container.querySelector('[data-body-read]');
    if(!body||!button)return;
    const k=key(id,row,delivery);
    let entry=cache.get(k);
    if(!entry){
      const saved=row||{body_text:delivery.body};
      const ready=!row||Boolean(saved.body_text||saved.body_html);
      entry={state:ready?'ready':'idle',parts:ready?fullBody(saved):null,preview:savedExcerpt(saved),
        expanded:false,quoteOpen:false,notify:()=>{}};
      cache.set(k,entry);
    }
    const savedDelivery={body_text:fallback};
    const storedPreview=savedExcerpt(savedDelivery);
    const fallbackParts=storedPreview?fullBody(savedDelivery):null;
    const quoted=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');
    quoted.dataset.quotedBody='true';summary.textContent='引用部分';quoted.append(summary,text);body.after(quoted);
    quoted.addEventListener('toggle',()=>{if(!quoted.hidden)entry.quoteOpen=quoted.open;});
    function draw(){
      if(!valid()||!container.isConnected)return;
      const failed=entry.state==='error',parts=entry.parts?.empty&&fallbackParts?fallbackParts:entry.parts;
      const busy=['loading','queued'].includes(entry.state);
      const expanded=entry.expanded&&parts&&!parts.empty;
      body.classList.toggle('expanded',Boolean(expanded));
      body.classList.toggle('unavailable',failed);
      if(expanded)body.textContent=displayText(parts.text);
      else if(failed&&!storedPreview)body.textContent=entry.error?.status===401||entry.error?.status===403
        ?'認証・ACL拒否 / '+entry.error.status+' / 本文を取得できません':'本文の取得に失敗しました / 再取得できます';
      else body.textContent=displayText(storedPreview||entry.preview)||
        (parts?'取得成功 / 空本文':busy?'本文を取得中…':'表示時に本文を取得します…');
      button.textContent=busy?'本文を取得中…':failed?'本文を再取得':expanded?'閉じる':parts?'全文を表示':'本文を取得';
      button.disabled=busy;
      button.hidden=Boolean(parts?.empty);
      button.setAttribute('aria-expanded',String(Boolean(expanded)));
      text.textContent=expanded?displayText(parts.quoted):'';
      quoted.hidden=!(expanded&&parts.quoted);quoted.open=!quoted.hidden&&entry.quoteOpen;
    }
    entry.notify=draw;draw();
    button.onclick=()=>{
      if(!valid())return;
      if(!entry.parts){void load(id,row,entry,valid);return;}
      if(entry.parts.empty&&!fallbackParts)return;
      entry.expanded=!entry.expanded;
      entry.quoteOpen=entry.expanded;
      draw();
    };
    if(entry.state==='idle'){
      observer??=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){observer.unobserve(e.target);e.target._loadBody?.();}},{rootMargin:'160px'});
      container._loadBody=()=>{if(entry.state==='idle')load(id,row,entry,valid);};observer.observe(container);
    }
  }
  return {mount,detach,clear(){detach();generation++;cache.clear();for(const job of queue)job.resolve();queue=[];}};
}
