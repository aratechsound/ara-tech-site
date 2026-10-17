// Memory only. A store belongs to one case and one exact Auth session.
// It never grants access: cache hits still check the current local Auth session,
// and full previews always call the normal authenticated original endpoint.
export function createPrivateAssets({requestBlob,requestDownload,authorize,isCurrent=()=>true,onMetric=()=>{},maxBytes=64*1024*1024}){
  const records=new Map(),sizes=new Map(),pdfs=new Map(),documents=new Set(),thumbs=new Map(),urls=new Set(),queue=[];
  let generation=0,active=0,bytes=0,closed=false,worker;
  const stale=()=>Object.assign(Error('stale_asset'),{code:'read_timeout_or_cancelled'});
  const key=item=>JSON.stringify([item.read_route||'',item.asset_kind,item.asset_id,item.message_id||'',item.mime_type,item.current||item.source_ref||null]);
  const valid=async g=>{if(closed||g!==generation||!isCurrent())throw stale();try{await authorize();}catch(e){clear();throw e;}if(closed||g!==generation||!isCurrent())throw stale();};
  function pump(){
    queue.sort((a,b)=>b.priority-a.priority);
    while(active<2&&queue.length){const job=queue.shift();active++;Promise.resolve().then(async()=>{await valid(job.g);if(!job.needed())throw stale();return job.run();}).then(job.resolve,job.reject).finally(()=>{active--;pump();});}
  }
  function schedule(run,{priority=0,needed=()=>true}={}){const g=generation;return new Promise((resolve,reject)=>{queue.push({run,priority,needed,g,resolve,reject});pump();});}
  async function record(item,{fresh=false,download=false,priority=0,needed=()=>true}={}){
    if(download)fresh=true;
    const g=generation,k=key(item);await valid(g);
    if(!fresh&&records.has(k)){onMetric('original_cache_hit',0);return records.get(k);}
    const pending=schedule(async()=>{const start=performance.now(),blob=await (download&&requestDownload?requestDownload:requestBlob)(item);onMetric('original_get',performance.now()-start);await valid(g);const url=URL.createObjectURL(blob);urls.add(url);return {blob,url};},{priority,needed});
    if(!fresh)records.set(k,pending);
    try{const result=await pending;if(!fresh){bytes+=result.blob.size;sizes.set(k,result.blob.size);
      while((bytes>maxBytes||records.size>64)&&records.size>1){const old=[...records.keys()].find(v=>v!==k&&sizes.has(v));if(!old)break;bytes-=sizes.get(old)||0;sizes.delete(old);const entry=records.get(old);records.delete(old);entry.then(release).catch(()=>{});const doc=pdfs.get(old);pdfs.delete(old);doc?.then(destroyPdf).catch(()=>{});for(const t of thumbs.keys())if(t.startsWith(old+':'))thumbs.delete(t);}
    }return result;}
    catch(e){if(records.get(k)===pending)records.delete(k);throw e;}
  }
  async function openPdf(blob,getPdfjs){
    const g=generation;await valid(g);const data=await blob.arrayBuffer(),lib=await getPdfjs();await valid(g);
    if(!worker){const start=performance.now();worker=new lib.PDFWorker();await worker.promise;onMetric('pdf_worker_init',performance.now()-start);}else await worker.promise;await valid(g);
    const doc=await lib.getDocument({data,worker,cMapUrl:'/pa-ui/vendor/cmaps/',cMapPacked:true,standardFontDataUrl:'/pa-ui/vendor/standard_fonts/',wasmUrl:'/pa-ui/vendor/wasm/'}).promise;
    if(closed||generation!==g){await doc.destroy();throw stale();}documents.add(doc);return doc;
  }
  function destroyPdf(doc){if(!documents.delete(doc))return Promise.resolve();return doc.destroy();}
  async function pdf(item,getPdfjs){
    const g=generation,k=key(item);await valid(g);if(pdfs.has(k))return pdfs.get(k);
    const pending=record(item).then(({blob})=>openPdf(blob,getPdfjs));
    pdfs.set(k,pending);pending.catch(()=>{if(pdfs.get(k)===pending)pdfs.delete(k);});return pending;
  }
  async function thumbnail(item,dimensions,draw,needed){
    const g=generation,k=key(item)+':'+dimensions;await valid(g);
    if(thumbs.has(k)){onMetric('thumbnail_cache_hit',0);try{return await thumbs.get(k);}catch(e){if(e.message==='stale_asset'&&needed()){thumbs.delete(k);return thumbnail(item,dimensions,draw,needed);}throw e;}}
    // Reserve the original before rendering. Network queue has a global limit;
    // no renderer slot is held while waiting for an original.
    const pending=record(item,{needed}).then(async()=>{await valid(g);const start=performance.now(),value=await draw();await valid(g);onMetric('thumbnail_render',performance.now()-start);return value;});
    thumbs.set(k,pending);pending.catch(()=>{if(thumbs.get(k)===pending)thumbs.delete(k);});return pending;
  }
  function release(record){if(record&&urls.delete(record.url))URL.revokeObjectURL(record.url);}
  function clear(){
    closed=true;++generation;for(const job of queue.splice(0))job.reject(stale());
    for(const doc of documents)destroyPdf(doc).catch(()=>{});documents.clear();worker?.destroy();worker=null;
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();records.clear();sizes.clear();pdfs.clear();thumbs.clear();bytes=0;
  }
  return {record,pdf,openPdf,destroyPdf,thumbnail,release,clear};
}
