const LABELS={quote_monitor_storage_unavailable:'変更見積の保存済み検査結果は未取得です。',quote_monitor_changed:'メール索引または候補が変わりました。再確認してください。',quote_monitor_cooldown:'再確認の間隔が短すぎます。1分以上待ってください。',invalid_origin:'このテスト環境の操作許可はありません。',rate_limited:'操作上限です。時間を置いて明示的に再確認してください。'};
export const monitorError=e=>LABELS[e.message]||'変更見積の確認は未完了です。成功・変更なしとは扱いません。';
export function createQuoteMonitor({getSession,fetchImpl=fetch,read:readWorkspace=null,onUpdate=()=>{},onAuthFailure=()=>{}}){
 let epoch=0,identity=null,queueRun=0,automatic=0,disposed=false,lane=Promise.resolve();
 const summaries=new Map(),full=new Map(),inflight=new Map(),listeners=new Map(),controllers=new Set(),caseVersions=new Map();
 const notify=id=>{onUpdate(id,summaries.get(id));for(const fn of listeners.get(id)||[])fn(full.get(id)||summaries.get(id));};
 function clear(){++epoch;++queueRun;for(const c of controllers)c.abort();controllers.clear();summaries.clear();full.clear();inflight.clear();caseVersions.clear();identity=null;automatic=0;}
 async function request(action,input={},binary=false){
  const ticket=epoch,session=await getSession();if(disposed||ticket!==epoch||!session?.access_token)throw Error('case_changed');
  const owner=session.user?.id||session.access_token;if(identity&&identity!==owner){clear();throw Error('case_changed');}identity=owner;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);controllers.add(controller);
  try{
   const r=await fetchImpl(action==='case_discovery_sync'?'/api/pa-gmail':'/api/pa-mail?surface=commercial',{method:'POST',cache:'no-store',redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify({...input,action})});
   if(disposed||ticket!==epoch)throw Error('case_changed');
   if(r.status===401){onAuthFailure();throw Error('not_authorized');}
   if(binary){if(!r.ok){let value;try{value=await r.json();}catch{}throw Error(value?.code||'quote_monitor_unavailable');}if(!(r.headers.get('content-type')||'').startsWith('application/pdf'))throw Error('quote_monitor_mismatch');return r.blob();}
   const value=await r.json();if(!r.ok||!value.ok)throw Error(value.code||'quote_monitor_unavailable');return value.result;
  }finally{clearTimeout(timer);controllers.delete(controller);}
 }
 function put(value){if(!value?.case_id)throw Error('quote_monitor_mismatch');const old=summaries.get(value.case_id);if(!value.error&&Number(old?.generation)>Number(value.generation))return old;summaries.set(value.case_id,value);if(value.candidates||value.error&&full.has(value.case_id))full.set(value.case_id,value.error?{...full.get(value.case_id),...value}:value);notify(value.case_id);return value;}
 async function read(id){const ticket=epoch,value=await request('quote_monitor_status',{case_id:id});if(ticket!==epoch||value.case_id!==id)throw Error('case_changed');return put(value);}
 async function check(id,{force=false,resume=false}={}){
  if(inflight.has(id))return inflight.get(id);
  if(force&&Date.parse(full.get(id)?.scan?.started_at)>Date.now()-60000)throw Error('quote_monitor_cooldown');
  caseVersions.set(id,(caseVersions.get(id)||0)+1);
  const ticket=epoch,task=lane.catch(()=>{}).then(async()=>{if(ticket!==epoch)throw Error('case_changed');try{
   if(readWorkspace){const sync=await readWorkspace('/data/mail-discovery/'+id);if(ticket!==epoch)throw Error('case_changed');if(sync.enabled===true&&(force||sync.complete!==true||!Number.isFinite(Date.parse(sync.last_completed_at))||Date.parse(sync.last_completed_at)<=Date.now()-5*60000||sync.last_error))await request('case_discovery_sync',{inquiry_id:id});}
   let value;for(let page=0;page<2;page++){if(ticket!==epoch)throw Error('case_changed');value=await request('quote_monitor_check',{case_id:id,operation_id:crypto.randomUUID(),force:page===0&&force,resume:page===0&&resume});if(ticket!==epoch||value.case_id!==id)throw Error('case_changed');put(value);if(!value.continue_inspection)break;}return value;
  }catch(e){if(ticket===epoch)put({case_id:id,state:'incomplete',label:'確認未完了',error:e.message,needs_check:true});throw e;}});
  lane=task.catch(()=>{});
  inflight.set(id,task);try{return await task;}finally{if(inflight.get(id)===task)inflight.delete(id);}
 }
 async function ensure(id){if(inflight.has(id))return inflight.get(id);const value=full.get(id)||await read(id);return value.needs_check&&!value.checking&&!value.automatic_blocked?check(id):value;}
 async function start(cases){
  const run=++queueRun,ticket=epoch;automatic=0;
  const selected=cases.slice(0,100);
  for(let offset=0;offset<selected.length;offset+=20){
   if(ticket!==epoch||run!==queueRun)return;
   const ids=selected.slice(offset,offset+20).map(c=>c.id),versions=new Map(ids.map(id=>[id,caseVersions.get(id)||0]));
   try{const value=await request('quote_monitor_list',{case_ids:ids});if(ticket!==epoch||run!==queueRun)return;
    if(!Array.isArray(value.cases)||value.cases.some(c=>!ids.includes(c.case_id)))throw Error('quote_monitor_mismatch');for(const c of value.cases)if((caseVersions.get(c.case_id)||0)===versions.get(c.case_id))put(c);
   }catch(e){if(ticket!==epoch)return;for(const id of ids)put({case_id:id,label:'確認未完了',state:'incomplete',error:e.message,needs_check:true});return;}
  }
  for(const c of selected){
   if(ticket!==epoch||run!==queueRun||automatic>=4)return;const cached=summaries.get(c.id);
   if(c.monitorActive===false||!cached?.eligible||!cached.needs_check||cached.checking||cached.automatic_blocked||Date.parse(cached.retry_after)>Date.now())continue;
   ++automatic;try{await check(c.id);}catch(e){if(['not_authorized','invalid_origin','rate_limited','quote_monitor_storage_unavailable'].includes(e.message))return;}
  }
 }
 async function decide(id,candidate,kind,reason){
  if(!['excluded','deferred','restored'].includes(kind))throw Error('invalid_quote_monitor');
  const value=await request('quote_monitor_decision',{case_id:id,candidate_key:candidate.key,quote_sha256:candidate.evidence.quote.sha256,event_kind:kind,reason,previous_event_id:candidate.decision?.id||null,operation_id:crypto.randomUUID()});
  await read(id);return value;
 }
 return {start,clear,ensure,read,check,decide,get:id=>summaries.get(id)||null,getFull:id=>full.get(id)||null,
  history:(id,before_event=null)=>request('quote_monitor_history',{case_id:id,...(before_event?{before_event}:{})}),
  document:(id,candidate,kind='quote')=>request('quote_monitor_document',{case_id:id,candidate_key:candidate.key,quote_sha256:candidate.evidence.quote.sha256,kind},true),
  subscribe(id,fn){const set=listeners.get(id)||new Set();listeners.set(id,set);set.add(fn);return ()=>{set.delete(fn);if(!set.size)listeners.delete(id);};},
  stats:()=>({automatic,concurrency:1,tracked:summaries.size,inflight:inflight.size}),dispose(){disposed=true;clear();listeners.clear();}};
}

export async function openCandidateDecision({candidate,kind,caseId,monitor,dialog,stop,status,valid,setDirty,setBusy}){
 const {privateText}=await import('./pa-workspace-privacy.mjs');if(!valid())return;
 const d=dialog(({excluded:'この案件の変更見積ではない',deferred:'あとで確認',restored:'変更見積の除外を解除'})[kind]),s=status(d),safe=()=>valid()&&d.open;
 const info=document.createElement('p');info.textContent=privateText(candidate.evidence.quote.filename+' / '+candidate.evidence.quote.sha256);d.append(info);
 const reason=document.createElement('textarea');reason.setAttribute('aria-label','判断理由');reason.maxLength=2000;
 const label=document.createElement('label'),ack=document.createElement('input');ack.type='checkbox';ack.setAttribute('aria-label','対象案件・候補・操作の意味を確認しました');label.append(ack,document.createTextNode('対象案件・候補・操作の意味を確認しました'));
 const apply=document.createElement('button');apply.type='button';apply.className='lightbtn';apply.textContent=kind==='excluded'?'この候補を除外する':kind==='restored'?'除外を解除する':'この候補を保留する';apply.disabled=true;
 const changed=()=>{setDirty(true);apply.disabled=!ack.checked||!reason.value.trim();};reason.oninput=changed;ack.onchange=changed;
 apply.onclick=async()=>{if(!safe()||apply.disabled)return;apply.disabled=true;setBusy(true);try{await monitor.decide(caseId,candidate,kind,reason.value.trim());if(safe()){setDirty(false);s.textContent='判断を保存しました。元契約・見積・Gmail原本は変更していません。';reason.disabled=true;ack.disabled=true;}}catch(e){if(safe())s.textContent=monitorError(e);}finally{setBusy(false);}};
 d.append(reason,label,apply);stop(d);d.showModal();
}
