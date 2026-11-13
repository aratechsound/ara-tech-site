const MAIL_ID=/^[A-Za-z0-9_-]{1,200}$/;
const validMailId=value=>typeof value==='string'&&MAIL_ID.test(value);
const keyFor='paui089-send-attempts-v1';
export const parseCc=value=>[...new Set(String(value||'').split(/[;,\n]/).map(v=>v.trim().toLowerCase()).filter(Boolean))];
export const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');

// Only hashes, case/message/thread IDs, outcomes and timestamps survive a reload. No body,
// recipient, attachment bytes, Auth token or confirmation_token is stored.
export function createAttemptStore(storage, storageKey=keyFor){
  function read(){const rows=JSON.parse(storage.getItem(storageKey)||'[]');if(!Array.isArray(rows)||rows.some(r=>typeof r.key!=='string'||!r.key||typeof r.caseId!=='string'||!r.caseId||!['pending','sent','unknown'].includes(r.status)||r.receipt&&(r.receipt.caseId!==r.caseId||!validMailId(r.receipt.messageId)||!validMailId(r.receipt.threadId))))throw Error('send_lock_unavailable');return rows;}
  function write(rows){storage.setItem(storageKey,JSON.stringify(rows));}
  return {
    blocked:id=>read().some(r=>r.caseId===id&&['pending','unknown'].includes(r.status)),
    has:key=>read().some(r=>r.key===key),
    begin(key,caseId){const rows=read();if(rows.some(r=>r.key===key||r.caseId===caseId&&r.status!=='sent'))throw Error('send_already_attempted');rows.push({key,caseId,status:'pending',at:new Date().toISOString()});write(rows);},
    release(key){write(read().filter(r=>r.key!==key||r.status!=='pending'));},
    finish(key,status,receipt){const rows=read(),row=rows.find(r=>r.key===key);if(!row)throw Error('send_lock_unavailable');row.status=status;if(receipt){if(receipt.caseId!==row.caseId||!validMailId(receipt.messageId)||!validMailId(receipt.threadId))throw Error('invalid_reply_binding');row.receipt={caseId:row.caseId,messageId:receipt.messageId,threadId:receipt.threadId};row.verified=false;}write(rows);},
    receipts:caseId=>read().filter(r=>r.caseId===caseId&&r.status==='sent'&&r.receipt&&!r.verified).map(r=>({key:r.key,...r.receipt})),
    verify(key){const rows=read(),row=rows.find(r=>r.key===key);if(!row||row.status!=='sent')throw Error('send_lock_unavailable');row.verified=true;write(rows);}
  };
}
export async function encodeAttachments(files){
  if(files.length>10||files.some(f=>!f.size)||files.reduce((n,f)=>n+f.size,0)>3*1024*1024)throw Error('attachment_limit');
  return Promise.all(files.map(async file=>{
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return {filename:file.name,mime_type:file.type||'application/octet-stream',size:bytes.length,data:btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
  }));
}

export function verifiedSentMail(receipt,value){
  const {caseId,messageId,threadId}=receipt;
  if(!validMailId(messageId)||!validMailId(threadId)||!Array.isArray(value?.links)||!Array.isArray(value.messages)||!value.links.some(l=>l.inquiry_id===caseId&&l.gmail_thread_id===threadId)||value.links.some(l=>l.inquiry_id!==caseId))throw Error('sent_readback_mismatch');
  const unique=new Map();
  for(const row of value.messages){
    if(row.inquiry_id!==caseId||!validMailId(row.gmail_message_id)||!value.links.some(l=>l.gmail_thread_id===row.gmail_thread_id))throw Error('sent_readback_mismatch');
    const old=unique.get(row.gmail_message_id);
    if(old&&(old.gmail_thread_id!==row.gmail_thread_id||old.direction!==row.direction))throw Error('sent_readback_mismatch');
    if(!old)unique.set(row.gmail_message_id,row);
  }
  const sent=unique.get(messageId);
  if(!sent||sent.gmail_thread_id!==threadId||sent.direction!=='outbound'||!Number.isFinite(Date.parse(sent.sent_at||'')))throw Error('sent_readback_mismatch');
  const time=m=>Date.parse(m.received_at||m.sent_at||'')||0;
  return {...value,messages:[...unique.values()].sort((a,b)=>time(b)-time(a)||a.gmail_message_id.localeCompare(b.gmail_message_id))};
}

export function createReplyState({request,attempts,readSent=async()=>{throw Error('sent_readback_unavailable');},applySent=()=>{},changed=()=>{},now=Date.now,hash=digest}){
  const drafts=new Map(),sentJobs=new Map(),sendingCases=new Set();let generation=0,revision=0,authGeneration=0,listener=()=>{};
  let state={caseId:null,open:false,phase:'idle',body:'',cc:'',attachments:[],context:null,source:null,preview:null,confirmed:false,error:null,history:null};
  const notify=()=>{changed(state);listener(state);};
  function invalidate(){revision++;state.preview=null;state.confirmed=false;}
  function stash(){if(state.caseId&&!sentJobs.has(state.caseId))drafts.set(state.caseId,{body:state.body,attachments:state.attachments});}
  const valid=(g,r,c)=>generation===g&&revision===r&&state.caseId===c&&state.open;
  function sourcePayload(){return {inquiry_id:state.caseId,mode:'normal',reply_source_message_id:state.source.gmail_message_id,reply_source_thread_id:state.source.gmail_thread_id};}
  function content(){return {...sourcePayload(),body:state.body.trim(),cc_addresses:parseCc(state.cc),attachments:state.attachments.map(({filename,mime_type,data})=>({filename,mime_type,data}))};}
  function boundContext(c){return c&&c.inquiry_id===state.caseId&&c.gmail_thread_id===state.source.gmail_thread_id&&c.reply_source_message_id===state.source.gmail_message_id&&c.reply_source_explicit===true&&typeof c.recipient==='string'&&c.recipient&&typeof c.subject==='string'&&c.subject&&typeof c.reply_source_authority_hash==='string';}
  function blocked(){try{return attempts.blocked(state.caseId);}catch{return true;}}
  const pending=id=>Boolean(sentJobs.get(id)&&sentJobs.get(id).phase!=='sent');
  function reflect(job){if(state.caseId!==job.receipt.caseId)return;state.phase=job.phase;state.receipt=job.receipt;state.error=null;invalidate();}
  async function refreshSent(caseId){
    const job=sentJobs.get(caseId);if(!job||job.phase==='sent')return;if(job.promise)return job.promise;
    const auth=authGeneration;job.phase='sent-refreshing';reflect(job);
    job.promise=Promise.resolve().then(async()=>{
      try{
        const value=verifiedSentMail(job.receipt,await readSent(job.receipt));
        if(auth!==authGeneration||sentJobs.get(caseId)!==job)return;
        await applySent(caseId,value,job.receipt);
        if(auth!==authGeneration||sentJobs.get(caseId)!==job)return;
        attempts.finish(job.key,'sent',job.receipt);attempts.verify?.(job.key);
        job.phase='sent';drafts.delete(caseId);
        if(state.caseId===caseId){invalidate();state={...state,open:false,phase:'sent',body:'',cc:'',attachments:[],context:null,source:null,preview:null,confirmed:false,history:null,receipt:job.receipt,error:null};}
      }catch{if(auth!==authGeneration||sentJobs.get(caseId)!==job)return;job.phase='sent-unverified';reflect(job);}
      finally{job.promise=null;if(auth===authGeneration)notify();}
    });notify();return job.promise;
  }
  return {
    get:()=>state,
    subscribe(fn){listener=fn;notify();return()=>{listener=()=>{};};},
    setCase(caseId){stash();generation++;invalidate();try{for(const receipt of attempts.receipts?.(caseId)||[])if(!sentJobs.has(caseId))sentJobs.set(caseId,{key:receipt.key,receipt,phase:'sent-unverified',promise:null});}catch{}const job=sentJobs.get(caseId),draft=job?{}:drafts.get(caseId)||{};state={caseId,open:false,phase:job?.phase||(sendingCases.has(caseId)?'sending':'idle'),body:draft.body||'',cc:'',attachments:draft.attachments||[],source:null,context:null,preview:null,confirmed:false,error:null,history:null,receipt:job?.receipt||null};notify();},
    clearAuth(){generation++;revision++;authGeneration++;drafts.clear();sentJobs.clear();state={caseId:null,open:false,phase:'idle',body:'',cc:'',attachments:[],source:null,context:null,preview:null,confirmed:false,error:null,history:null,receipt:null};notify();},
    pending:id=>pending(id)||sendingCases.has(id),
    resumeSent(){return refreshSent(state.caseId);},
    retrySent(){return refreshSent(state.caseId);},
    close(){if(state.phase==='sending'||state.phase==='sent-refreshing')return;generation++;invalidate();state.open=false;stash();notify();},
    async open(row){
      if(this.pending(state.caseId))return;
      if(!state.caseId||row.inquiry_id!==state.caseId||row.direction!=='inbound'||row.index_state==='not_indexed'||!MAIL_ID.test(row.gmail_message_id||'')||!MAIL_ID.test(row.gmail_thread_id||''))throw Error('invalid_reply_source');
      generation++;invalidate();sentJobs.delete(state.caseId);state.receipt=null;state.open=true;state.source={...row};state.context=null;state.cc='';state.error=null;state.phase='context-loading';state.history=null;
      const g=generation,c=state.caseId,isCurrent=()=>generation===g&&state.caseId===c&&state.open;notify();
      try{const data=await request({action:'reply_context',...sourcePayload()},isCurrent);if(!isCurrent())return;
        if(!boundContext(data.context))throw Error('invalid_reply_binding');state.context=data.context;state.cc=(data.context.cc_addresses||[]).join(', ');state.phase='editing';
      }catch(e){if(!isCurrent())return;state.phase='error';state.error=e.message||'context_unavailable';}
      notify();
    },
    edit(field,value){if(this.pending(state.caseId)||!['body','cc','attachments'].includes(field))return;invalidate();state[field]=value;state.error=null;if(state.phase!=='context-loading')state.phase=state.context?'editing':'error';stash();notify();},
    attachmentError(){invalidate();state.error='attachment_limit';notify();},
    confirm(value){state.confirmed=Boolean(value)&&state.phase==='ready';notify();},
    canSend(){return state.phase==='ready'&&state.confirmed&&state.preview&&Date.parse(state.preview.expires_at)>now()&&!blocked();},
    blocked,
    invalidateAuth(){if(state.preview){invalidate();state.phase='editing';state.error='login_required';notify();}},
    expire(){if(state.preview&&Date.parse(state.preview.expires_at)<=now()){invalidate();state.phase='editing';state.error='preview_expired';notify();}},
    async preview(){
      if(!state.context||blocked()||this.pending(state.caseId)||state.phase==='preview-loading')return;
      invalidate();state.phase='preview-loading';state.error=null;const g=generation,r=revision,c=state.caseId,payload=content(),context=state.context;notify();
      if(!payload.body||payload.body.length>20000){state.phase='editing';state.error='body_required';notify();return;}
      try{const data=await request({action:'reply_preview',...payload},()=>valid(g,r,c));if(!valid(g,r,c))return;const p=data.preview;
        if(!boundContext(p)||p.recipient!==context.recipient||p.subject!==context.subject||p.reply_source_authority_hash!==context.reply_source_authority_hash||p.mode!=='normal'||!p.confirmation_token||!p.html||Date.parse(p.expires_at)<=now()||JSON.stringify(p.cc_addresses)!==JSON.stringify(payload.cc_addresses))throw Error('invalid_reply_binding');
        const key=await hash({payload,recipient:p.recipient,subject:p.subject});if(!valid(g,r,c))return;
        state.preview={...p,payload,key};state.phase='ready';state.confirmed=false;
      }catch(e){if(!valid(g,r,c))return;state.preview=null;state.phase='editing';state.error=e.message||'preview_unavailable';}
      notify();
    },
    async send(){
      if(!this.canSend())return;
      const p=state.preview,g=generation,r=revision,c=state.caseId,auth=authGeneration;
      if(attempts.has(p.key)){state.error='send_already_attempted';state.confirmed=false;notify();return;}
      // Lock synchronously before awaiting authentication or starting a POST.
      try{attempts.begin(p.key,c);}catch{state.error='send_lock_unavailable';state.confirmed=false;notify();return;}
      sendingCases.add(c);state.phase='sending';state.confirmed=false;notify();
      try{const data=await request({action:'send_reply',...p.payload,confirmation_token:p.confirmation_token},()=>valid(g,r,c));
        if(!validMailId(data.result?.gmail_message_id)||!validMailId(data.result?.gmail_thread_id)||data.result.gmail_thread_id!==p.gmail_thread_id)throw Error('send_outcome_unknown');
        const receipt={caseId:c,messageId:data.result.gmail_message_id,threadId:data.result.gmail_thread_id};
        try{attempts.finish(p.key,'sent',receipt);}catch{}
        if(authGeneration!==auth)return;
        const job={key:p.key,receipt,phase:'sent-refreshing',promise:null};sentJobs.set(c,job);drafts.delete(c);reflect(job);notify();await refreshSent(c);
      }catch{try{attempts.finish(p.key,'unknown');}catch{}if(auth!==authGeneration||state.caseId!==c)return;state.phase='unknown';state.error='send_outcome_unknown';state.preview=null;}
      finally{sendingCases.delete(c);}
      notify();
    },
    async history(read){
      const c=state.caseId,g=generation;if(!c)return;invalidate();state.history={loading:true};notify();
      try{const result=await read(c);if(generation!==g||state.caseId!==c)return;state.history=result;}
      catch{if(generation!==g)return;state.history={error:true};}notify();
    }
  };
}
