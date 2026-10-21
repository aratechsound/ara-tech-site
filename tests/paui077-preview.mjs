// Only invented records. Integration is replaced before CASE DESK is loaded.
const types=['PA_EVENT','OTHER','AUDIO_INSTALL','AV_INSTALL','LIGHTING_INSTALL','VIDEO_INSTALL','EQUIPMENT_RENTAL'];
const cases=types.map((case_type,i)=>({id:`11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`,case_type,inquiry_number:'FIXTURE-077-'+(i+1),case_name:'架空の案件名 '+case_type,event_name:case_type==='PA_EVENT'?'合成PA・未受注':null,customer_name:'架空の担当者 '+(i+1),email:'fixture@example.invalid',phone:'架空の連絡先',status:'new_inquiry',updated_at:'2026-10-20T00:00:00Z',revision:1,event_date:'2020-01-01',request_summary:'PAUI-077 合成本文。実顧客・実案件のデータではありません。'}));
cases.push({...cases[0],id:'22222222-2222-4222-8222-222222222222',inquiry_number:'FIXTURE-077-ORDERED',event_name:'合成PA・受注済み未入金'});
cases.push({...cases[0],id:'33333333-3333-4333-8333-333333333333',inquiry_number:'FIXTURE-077-PAID',event_name:'合成PA・入金確認の導線'});
const progress=cases.filter(c=>c.case_type==='PA_EVENT').map((c,i)=>({inquiry_id:c.id,updated_at:c.updated_at,current_step:i?9:1,booking_confirmed_on:i?'2026-10-01':null,estimate_approved_on:i?'2026-10-01':null,closed_at:null}));
const integration=`const cases=${JSON.stringify(cases)},progress=${JSON.stringify(progress)};
export const workspaceAuth={restore:async()=>({access_token:'fixture-only',expires_at:9999999999}),current:async()=>({access_token:'fixture-only',expires_at:9999999999}),logout:async()=>{},subscribe:()=>{}};
export const legacyUrl=()=>{throw Error('fixture_read_only')};
export const readPaCompletion=async c=>({inquiry:c,progress:progress.find(p=>p.inquiry_id===c.id),commercial:{case_status:c.status,state:{inquiry_id:c.id,revision:1,unresolved_changes:false},offers:[],billings:c.id.startsWith('2222')?[{id:'fixture-billing',state:'open',amount_minor:10000}]:[],payments:[],adjustments:[],outbox:[],change_orders:[]}});
export const savePaCompletion=async()=>{throw Error('fixture_read_only')};
export const readPaCompletionStatus=async id=>cases.find(c=>c.id===id);
export const saveGeneralCompletion=async()=>{throw Error('fixture_read_only')};
export const readUrl=p=>'data:application/json,'+encodeURIComponent(JSON.stringify({ok:true,result:p==='/data/cases'?{cases,progress}:p.startsWith('/data/materials/')?{items:[]}:p.startsWith('/data/commercial/')?{offers:[],billings:[],estimates:[],documents:[]}:[]}));`;
const native=window.fetch.bind(window);
window.fetch=(target,options={})=>{
 const u=new URL(target,location.href);
 if((options.method||'GET')!=='GET'||u.pathname.startsWith('/api/'))return Promise.reject(Error('fixture_read_only'));
 if(u.protocol!=='data:'&&u.origin!==location.origin)return Promise.reject(Error('fixture_external_network_refused'));
 return native(target,options);
};
const res=await fetch('/pa-admin.html',{cache:'no-store'});let html=await res.text();if(!res.ok||!html.includes('/pa-ui/js/desk.mjs'))throw Error('UI unavailable');
const map=JSON.stringify({imports:{[new URL('/pa-ui/js/integration.mjs',location.href).href]:'data:text/javascript,'+encodeURIComponent(integration)}});
html=html.replace('<head>','<head><base href="/"><script type="importmap">'+map+'</scr'+'ipt>').replace('<span class="topinfo">案件管理</span>','<span class="topinfo">PAUI-077 合成データのみ・保存不可</span>');
document.open();document.write(html);document.close();
document.addEventListener('click',e=>{if(e.target.closest('[data-legacy],#new-case,#open-portal')){e.preventDefault();e.stopImmediatePropagation();}},true);
