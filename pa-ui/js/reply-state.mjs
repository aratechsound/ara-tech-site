const MAIL_ID=/^[A-Za-z0-9_-]{1,200}$/;
const keyFor='paui089-send-attempts-v1';
export const parseCc=value=>[...new Set(String(value||'').split(/[;,\n]/).map(v=>v.trim().toLowerCase()).filter(Boolean))];
export const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');

// Only hashes, case IDs, outcomes and timestamps survive a reload. No body,
// recipient, attachment bytes, Auth token or confirmation_token is stored.
export function createAttemptStore(storage){
  function read(){const rows=JSON.parse(storage.getItem(keyFor)||'[]');if(!Array.isArray(rows)||rows.some(r=>!r.key||!r.caseId||!['pending','sent','unknown'].includes(r.status)))throw Error('send_lock_unavailable');return rows;}
  function write(rows){storage.setItem(keyFor,JSON.stringify(rows));}
  return {
    blocked:id=>read().some(r=>r.caseId===id&&['pending','unknown'].includes(r.status)),
    has:key=>read().some(r=>r.key===key),
    begin(key,caseId){const rows=read();if(rows.some(r=>r.key===key||r.caseId===caseId&&r.status!=='sent'))throw Error('send_already_attempted');rows.push({key,caseId,status:'pending',at:new Date().toISOString()});write(rows);},
    finish(key,status){const rows=read(),row=rows.find(r=>r.key===key);if(!row)throw Error('send_lock_unavailable');row.status=status;write(rows);}
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

export function createReplyState({request,attempts,now=Date.now,hash=digest}){
  const drafts=new Map();let generation=0,revision=0,listener=()=>{};
  let state={caseId:null,open:false,phase:'idle',body:'',cc:'',attachments:[],context:null,source:null,preview:null,confirmed:false,error:null,history:null};
  const notify=()=>listener(state);
  function invalidate(){revision++;state.preview=null;state.confirmed=false;}
  function stash(){if(state.caseId)drafts.set(state.caseId,{body:state.body,attachments:state.attachments});}
  const valid=(g,r,c)=>generation===g&&revision===r&&state.caseId===c&&state.open;
  function sourcePayload(){return {inquiry_id:state.caseId,mode:'normal',reply_source_message_id:state.source.gmail_message_id,reply_source_thread_id:state.source.gmail_thread_id};}
  function content(){return {...sourcePayload(),body:state.body.trim(),cc_addresses:parseCc(state.cc),attachments:state.attachments.map(({filename,mime_type,data})=>({filename,mime_type,data}))};}
  function boundContext(c){return c&&c.inquiry_id===state.caseId&&c.gmail_thread_id===state.source.gmail_thread_id&&c.reply_source_message_id===state.source.gmail_message_id&&c.reply_source_explicit===true&&typeof c.recipient==='string'&&c.recipient&&typeof c.subject==='string'&&c.subject&&typeof c.reply_source_authority_hash==='string';}
  function blocked(){try{return attempts.blocked(state.caseId);}catch{return true;}}
  return {
    get:()=>state,
    subscribe(fn){listener=fn;notify();return()=>{listener=()=>{};};},
    setCase(caseId){stash();generation++;invalidate();const draft=drafts.get(caseId)||{};state={caseId,open:false,phase:'idle',body:draft.body||'',cc:'',attachments:draft.attachments||[],source:null,context:null,preview:null,confirmed:false,error:null,history:null};notify();},
    clearAuth(){generation++;revision++;drafts.clear();state={caseId:null,open:false,phase:'idle',body:'',cc:'',attachments:[],source:null,context:null,preview:null,confirmed:false,error:null,history:null};notify();},
    close(){if(state.phase==='sending')return;generation++;invalidate();state.open=false;stash();notify();},
    async open(row){
      if(state.phase==='sending')return;
      if(!state.caseId||row.inquiry_id!==state.caseId||row.direction!=='inbound'||row.index_state==='not_indexed'||!MAIL_ID.test(row.gmail_message_id||'')||!MAIL_ID.test(row.gmail_thread_id||''))throw Error('invalid_reply_source');
      generation++;invalidate();state.open=true;state.source={...row};state.context=null;state.cc='';state.error=null;state.phase='context-loading';state.history=null;
      const g=generation,c=state.caseId,isCurrent=()=>generation===g&&state.caseId===c&&state.open;notify();
      try{const data=await request({action:'reply_context',...sourcePayload()},isCurrent);if(!isCurrent())return;
        if(!boundContext(data.context))throw Error('invalid_reply_binding');state.context=data.context;state.cc=(data.context.cc_addresses||[]).join(', ');state.phase='editing';
      }catch(e){if(!isCurrent())return;state.phase='error';state.error=e.message||'context_unavailable';}
      notify();
    },
    edit(field,value){if(state.phase==='sending'||!['body','cc','attachments'].includes(field))return;invalidate();state[field]=value;state.error=null;if(state.phase!=='context-loading')state.phase=state.context?'editing':'error';stash();notify();},
    attachmentError(){invalidate();state.error='attachment_limit';notify();},
    confirm(value){state.confirmed=Boolean(value)&&state.phase==='ready';notify();},
    canSend(){return state.phase==='ready'&&state.confirmed&&state.preview&&Date.parse(state.preview.expires_at)>now()&&!blocked();},
    blocked,
    invalidateAuth(){if(state.preview){invalidate();state.phase='editing';state.error='login_required';notify();}},
    expire(){if(state.preview&&Date.parse(state.preview.expires_at)<=now()){invalidate();state.phase='editing';state.error='preview_expired';notify();}},
    async preview(){
      if(!state.context||blocked()||state.phase==='sending'||state.phase==='preview-loading')return;
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
      const p=state.preview,g=generation,r=revision,c=state.caseId;
      if(attempts.has(p.key)){state.error='send_already_attempted';state.confirmed=false;notify();return;}
      // Lock synchronously before awaiting authentication or starting a POST.
      try{attempts.begin(p.key,c);}catch{state.error='send_lock_unavailable';state.confirmed=false;notify();return;}
      state.phase='sending';state.confirmed=false;notify();
      try{const data=await request({action:'send_reply',...p.payload,confirmation_token:p.confirmation_token},()=>valid(g,r,c));
        if(!data.result?.gmail_message_id||data.result.gmail_thread_id!==p.gmail_thread_id)throw Error('send_outcome_unknown');
        attempts.finish(p.key,'sent');if(!valid(g,r,c))return;state.phase='sent';state.error=null;state.preview=null;
      }catch{try{attempts.finish(p.key,'unknown');}catch{}if(!valid(g,r,c))return;state.phase='unknown';state.error='send_outcome_unknown';state.preview=null;}
      notify();
    },
    async history(read){
      const c=state.caseId,g=generation;if(!c)return;invalidate();state.history={loading:true};notify();
      try{const result=await read(c);if(generation!==g||state.caseId!==c)return;state.history=result;}
      catch{if(generation!==g)return;state.history={error:true};}notify();
    }
  };
}
