// Invented records only. No real session, external network, writes or sends.
const C='11111111-1111-4111-8111-111111111111',D='22222222-2222-4222-8222-222222222222';
const cases=[{id:C,case_type:'PA_EVENT',event_name:'合成PA・保存情報の閲覧',customer_name:'架空の担当者A',inquiry_number:'FIXTURE-079-PA',status:'new_inquiry'},{id:D,case_type:'OTHER',case_name:'合成一般問い合わせ',customer_name:'架空の担当者B',inquiry_number:'FIXTURE-079-OTHER',status:'new_inquiry'}].map(c=>({...c,email:'fixture@example.invalid',updated_at:'2026-10-20T00:00:00Z',revision:1}));
const integration=`let active=!new URL(location.href).searchParams.has('login');const s={access_token:'fixture-only',expires_at:9999999999,user:{id:'fixture-owner'}};
export const workspaceAuth={restore:async()=>active?s:null,current:async()=>active?s:null,login:async()=>{active=true;return s},logout:async()=>{active=false},subscribe:fn=>{window.fixtureAuth=fn}};
export const readUrl=p=>'/api/pa-workspace-read?path='+encodeURIComponent(p);
export const legacyUrl=()=>{throw Error('fixture_legacy_forbidden')};
export const saveGeneralCompletion=async()=>{throw Error('fixture_write_forbidden')};
export const savePaCompletion=async()=>{throw Error('fixture_write_forbidden')};`;
const native=window.fetch.bind(window),calls=window.PAUI079_NETWORK=[];
const savedMail=id=>({inquiry_id:id,gmail_message_id:'saved_'+id[0],gmail_thread_id:'thread_'+id[0],subject:'保存済み合成メール',from_address:'fixture@example.invalid',direction:'inbound',received_at:'2026-10-20T00:00:00Z',body_text:'保存済みの合成本文です。外部メール取得は実行していません。',attachment_metadata:[]});
const snapshot=id=>({case_id:id,case_status:'new_inquiry',read_projection:true,state:{inquiry_id:id,revision:1},offers:[],contracts:[],billings:[],payments:[],adjustments:[],outbox:[],estimates:[],documents:[],change_orders:[]});
window.fetch=async(target,options={})=>{
 const u=new URL(target,location.href),method=options.method||'GET';let body={};try{body=JSON.parse(options.body||'{}');}catch{}
 calls.push({path:u.pathname,query:u.search,method,action:body.action||null});
 if(u.pathname.startsWith('/api/')){
  let result=[];
  if(u.pathname==='/api/pa-workspace-read'&&method==='GET'){
   const p=u.searchParams.get('path');
   if(p==='/data/cases')result={cases,progress:[],quote_monitor:true,quote_adoption_simple:true,commercial_originals_read:true};
   else if(p.startsWith('/data/mail-discovery/'))result={enabled:true,complete:false,has_more:true,candidates:[]};
   else if(p.startsWith('/data/mail/'))result=[savedMail(p.split('/').at(-1))];
   else if(p.startsWith('/data/materials/'))result={items:[]};
   else if(p.startsWith('/data/sent-estimates/'))result={messages:[],unknown:[]};
   else if(p.startsWith('/data/commercial/'))result=snapshot(p.split('/').at(-1));
  }else if(u.pathname==='/api/pa-mail'&&method==='GET'&&['original_index','billing_index'].includes(u.searchParams.get('action')))result=snapshot(u.searchParams.get('case_id'));
  else if(u.pathname==='/api/pa-mail'&&method==='POST'&&['quote_monitor_list','quote_monitor_status','snapshot','change_evidence_candidates','original_index','billing_index'].includes(body.action)){
   const stored=id=>({case_id:id,state:'incomplete',eligible:true,label:'確認未完了',needs_check:true,remote_fresh:false,candidates:[],scan:{state:'ready'}});
   result=body.action==='quote_monitor_list'?{cases:body.case_ids.map(stored)}:body.action==='quote_monitor_status'?stored(body.case_id):body.action==='change_evidence_candidates'?{case_id:body.case_id,contracts:[],history:[]}:snapshot(body.case_id);
  }else throw Error('fixture_write_or_sync_forbidden');
  return new Response(JSON.stringify({ok:true,result}),{headers:{'content-type':'application/json'}});
 }
 if(method!=='GET'||u.origin!==location.origin)throw Error('fixture_external_network_forbidden');
 return native(target,options);
};
const res=await fetch('/pa-admin.html',{cache:'no-store'});let html=await res.text();if(!res.ok||!html.includes('/pa-ui/js/desk.mjs'))throw Error('UI unavailable');
const map=JSON.stringify({imports:{[new URL('/pa-ui/js/integration.mjs',location.href).href]:'data:text/javascript,'+encodeURIComponent(integration)}});
html=html.replace('<head>','<head><base href="/"><script type="importmap">'+map+'</scr'+'ipt>').replace('<span class="topinfo">案件管理</span>','<span class="topinfo">PAUI-079 合成データ・保存不可・Gmail自動同期なし</span>');
document.open();document.write(html);document.close();
document.addEventListener('click',e=>{if(e.target.closest('[data-legacy],#new-case,#open-portal')){e.preventDefault();e.stopImmediatePropagation();}},true);
