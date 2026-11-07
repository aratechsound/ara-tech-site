const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAIL=/^[A-Za-z0-9_-]{1,200}$/;
export function validateSyncMetadata(value,id){
  if(!value||value.inquiry_id!==id||value.scope!=='existing_linked_threads'||!Array.isArray(value.thread_ids)||value.thread_ids.some(t=>!MAIL.test(t))||new Set(value.thread_ids).size!==value.thread_ids.length||typeof value.complete!=='boolean'||value.complete&&!value.last_success_at||value.last_success_at!==null&&!Number.isFinite(Date.parse(value.last_success_at)))throw Error('sync_binding_mismatch');
  return value;
}
// One flight per case survives tab/case navigation. No polling, mailbox sync,
// background credential, send, acknowledgement or automatic retry is installed.
export function createCaseMailSync({read,write,canDispatch,apply,changed=()=>{},now=Date.now}){
  let generation=0;const entries=new Map();
  function entry(id){if(!entries.has(id))entries.set(id,{phase:'idle',lastSuccess:null,error:null,promise:null});return entries.get(id);}
  return {
    get:id=>entry(id),
    clear(){generation++;entries.clear();},
    run(id){
      if(!UUID.test(id||'')||!canDispatch(id))return Promise.resolve();
      const e=entry(id);if(e.promise)return e.promise;
      const g=generation,current=()=>g===generation;
      e.phase='syncing';e.error=null;e.attemptedAt=new Date(now()).toISOString();
      // Register before notifying/rendering or awaiting Auth/provider I/O.
      e.promise=Promise.resolve().then(async()=>{
        try{
          const [links,stored]=await Promise.all([read('/data/case/'+id+'/links'),read('/data/case/'+id+'/mail-sync')]);
          if(!current())return;
          const meta=validateSyncMetadata(stored,id);if(meta.complete&&(!e.lastSuccess||Date.parse(meta.last_success_at)>=Date.parse(e.lastSuccess)))e.lastSuccess=meta.last_success_at;changed(id);
          if(!Array.isArray(links)||links.length>30||links.some(l=>l.inquiry_id!==id||!MAIL.test(l.gmail_thread_id||''))||new Set(links.map(l=>l.gmail_thread_id)).size!==links.length)throw Error('sync_binding_mismatch');
          if(!links.length){e.phase='unlinked';return;}
          if(!canDispatch(id)){e.phase='idle';return;}
          const data=await write({action:'sync',inquiry_id:id,linked_only:true},()=>current()&&canDispatch(id));
          if(!current())return;
          const result=data.result;
          if(!result||!Array.isArray(result.links)||!Array.isArray(result.messages)||!result.links.length||result.links.some(l=>l.inquiry_id!==id||!links.some(k=>k.gmail_thread_id===l.gmail_thread_id))||result.messages.some(m=>m.inquiry_id&&m.inquiry_id!==id||!MAIL.test(m.id||'')||!result.links.some(l=>l.gmail_thread_id===m.thread_id))||new Set(result.messages.map(m=>m.id)).size!==result.messages.length)throw Error('sync_binding_mismatch');
          const [messages,attentionRows,persisted]=await Promise.all([read('/data/mail/'+id),read('/data/case/'+id+'/attention'),read('/data/case/'+id+'/mail-sync')]);
          if(!current())return;
          const success=validateSyncMetadata(persisted,id);
          if(!success.complete||!success.last_success_at||success.thread_ids.length!==result.links.length||success.thread_ids.some(t=>!result.links.some(l=>l.gmail_thread_id===t))||success.message_count!==result.messages.length||!Array.isArray(messages)||messages.some(m=>m.inquiry_id!==id||!result.links.some(l=>l.gmail_thread_id===m.gmail_thread_id))||result.messages.some(m=>!messages.some(r=>r.gmail_message_id===m.id))||!Array.isArray(attentionRows)||attentionRows.length!==1||attentionRows[0].inquiry_id!==id)throw Error('sync_readback_mismatch');
          await apply(id,{messages,attention:attentionRows[0],metadata:success});
          if(!current())return;e.lastSuccess=success.last_success_at;e.phase='success';
        }catch(error){if(current()){e.phase='error';e.error=error.message||'sync_unavailable';}}
        finally{e.promise=null;if(current())changed(id);}
      });changed(id);return e.promise;
    }
  };
}
