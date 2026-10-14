// Summary and source identity keys are private session memory. No persistent storage, automatic
// generation, polling, paid retry, or HTML rendering in this view.
export function createMailSummaryView({request,isAuthenticated,limit=2,maxEntries=200}) {
  const cache=new Map();let queue=[],active=0,observer=null,generation=0;
  const key=(id,row)=>JSON.stringify([id,row.gmail_thread_id,row.gmail_message_id,row.direction,row.subject,row.body_text,row.body_html]);
  const labels={approval_required:'AI要約：未生成 / 承認済みAI基盤・費用・送信条件の確認待ち',not_requested:'AI要約：未生成',
    html_only:'AI要約：未生成 / HTML原文の意味抽出は未対応',empty_body:'AI要約：未生成 / 本文なし',source_too_large:'AI要約：未生成 / 本文が処理上限を超えています',direction_unknown:'AI要約：未生成 / 送受信未確認',unsupported_encoding:'AI要約：未生成 / 文字コードを確認できません',source_incomplete:'AI要約：未生成 / 原文全体を確認できません'};
  function pump(){
    while(active<limit&&queue.length){
      const job=queue.shift();
      if(job.generation!==generation||!job.valid()||!isAuthenticated()){job.entry.state='idle';job.resolve();continue;}
      active++;job.entry.state='loading';job.entry.notify();
      Promise.resolve().then(()=>request(job.id,job.row,{generate:job.generate})).then(result=>{
        if(job.generation!==generation||!isAuthenticated())return;
        if(!result||result.inquiry_id!==job.id||result.gmail_thread_id!==job.row.gmail_thread_id||result.gmail_message_id!==job.row.gmail_message_id
          ||!['ready','not_generated','failed','loading'].includes(result.state))throw Error('summary_binding_mismatch');
        if(result.state==='ready'&&(!Array.isArray(result.lines)||!result.lines.length||result.lines.length>3||result.lines.some(t=>typeof t!=='string'||!t.trim()||/[\r\n]/u.test(t))))throw Error('invalid_summary');
        job.entry.result=result;job.entry.state=result.state;
      }).catch(error=>{if(job.generation===generation){job.entry.state='failed';job.entry.error=error;}})
        .finally(()=>{active--;if(job.generation===generation)job.entry.notify();job.resolve();pump();});
    }
  }
  function load(id,row,entry,valid,generate=false){
    if(entry.pending)return entry.pending;
    entry.state='loading';entry.error=null;
    entry.pending=new Promise(resolve=>queue.push({id,row,entry,valid,generate,generation,resolve})).finally(()=>{entry.pending=null;entry.notify();});
    entry.notify();pump();return entry.pending;
  }
  function detach(){observer?.disconnect();observer=null;for(const e of cache.values())e.notify=()=>{};}
  function mount(container,id,row,valid){
    const k=key(id,row);let entry=cache.get(k);
    if(!entry){
      if(cache.size>=maxEntries){const old=[...cache].find(([,e])=>!e.pending);if(old)cache.delete(old[0]);else return;}
      entry={state:'idle',result:null,notify:()=>{}};cache.set(k,entry);
    }
    const panel=document.createElement('section'),label=document.createElement('strong'),lines=document.createElement('p'),notice=document.createElement('small'),action=document.createElement('button');
    panel.className='mail-summary';panel.setAttribute('aria-label','AI要約');label.textContent='AI要約';lines.className='mail-summary-lines';
    lines.setAttribute('role','status');notice.textContent='要約は原文の代替証拠ではありません。';action.type='button';action.className='lightbtn';
    notice.style.display='block';panel.style.marginBottom='8px';
    panel.append(label,lines,notice,action);(container.querySelector('[data-mail-original-label]')||container.querySelector('.mail-excerpt')).before(panel);
    function draw(){
      if(!valid()||!container.isConnected)return;
      const result=entry.result;lines.replaceChildren();
      if(entry.state==='ready')for(const value of result.lines){const line=document.createElement('span');line.textContent=value;line.style.display='block';lines.append(line);}
      else lines.textContent=entry.state==='idle'?'AI要約：状態未取得':entry.state==='loading'?'AI要約：取得・生成中…':entry.state==='failed'?
        (entry.error?.status===401||entry.error?.status===403?'AI要約：認証・ACL拒否 / '+entry.error.status:'AI要約：生成・取得失敗 / 原文を確認してください'):
        labels[result?.reason]||'AI要約：未生成';
      const can=entry.state==='not_generated'&&result?.can_generate===true;
      action.hidden=!can&&entry.state!=='failed'&&!(entry.state==='loading'&&result?.state==='loading');
      action.disabled=!!entry.pending;action.textContent=can?'AI要約を生成':'要約状態を再取得';
    }
    entry.notify=draw;draw();
    action.onclick=()=>{if(valid()&&!entry.pending)void load(id,row,entry,valid,entry.state==='not_generated'&&entry.result?.can_generate===true);};
    if(entry.state==='idle'){
      observer??=new IntersectionObserver(items=>{for(const item of items)if(item.isIntersecting){observer.unobserve(item.target);item.target._loadSummary?.();}},{rootMargin:'80px'});
      panel._loadSummary=()=>{if(entry.state==='idle')void load(id,row,entry,valid);};observer.observe(panel);
    }
  }
  return {mount,detach,clear(){detach();generation++;cache.clear();for(const job of queue)job.resolve();queue=[];}};
}
