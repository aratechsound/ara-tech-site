const crypto=require('node:crypto');const {spawnSync}=require('node:child_process');const path=require('node:path');
const actor='123e4567-e89b-42d3-a456-426614174001';
const secret='ara-case-r2-fixture-secret-at-least-32-characters';
const jwt=(role,sub=actor)=>{const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const body=Buffer.from(JSON.stringify({role,sub,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url');return `${header}.${body}.${crypto.createHmac('sha256',secret).update(`${header}.${body}`).digest('base64url')}`;};
const psql=path.resolve(__dirname,'../../../r2-runtime/pgsql/bin/psql.exe');
function sql(query,database='ara_case_r2_verify'){if(!['ara_case_r2_verify','ara_case_r2_guards','ara_case_r2_legacy'].includes(database))throw Error('fixture database');const p=spawnSync(psql,['-h','127.0.0.1','-p','55437','-U','fixture_admin','-d',database,'-v','ON_ERROR_STOP=1','-At'],{input:query,encoding:'utf8',env:{...process.env,PGCLIENTENCODING:'UTF8'}});if(p.status)throw Error(p.stderr);return p.stdout.replace(/\r/g,'').trim();}
function fixture({database='ara_case_r2_verify',restPort=55442}={}){
 const live=global.fetch.bind(globalThis);
 const state={mailbox:'aratechsound@gmail.com',messages:new Map(),sends:0,failSend:false,failPage:null,queries:[],pageQueries:new Map(),restPort};
 const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 const raw=(id,thread=id,when=Date.now()-10000,body='施工問い合わせの原文。希望日未定、来月まで。')=>({id,threadId:thread,labelIds:['INBOX'],snippet:body.slice(0,50),internalDate:String(when),payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'customer@example.invalid'},{name:'To',value:'aratechsound@gmail.com'},{name:'Subject',value:'設備施工相談'},{name:'Message-ID',value:`<${id}@example.invalid>`}],parts:[{mimeType:'text/plain',body:{data:Buffer.from(body).toString('base64url')}},{mimeType:'text/plain',filename:'施工資料.txt',partId:'1',body:{attachmentId:`att_${id}`,size:12}}]}});
 Object.assign(process.env,{SUPABASE_URL:`http://127.0.0.1:${restPort}`,SUPABASE_SERVICE_ROLE_KEY:jwt('service_role'),GMAIL_CLIENT_ID:'fixture-id',GMAIL_CLIENT_SECRET:'fixture-secret',GMAIL_REFRESH_TOKEN:'fixture-refresh',GMAIL_SENDER_ADDRESS:'aratechsound@gmail.com',GMAIL_REPLY_TO:'aratechsound@gmail.com',GMAIL_NOTIFICATION_ADDRESS:'aratechsound@gmail.com',RATE_LIMIT_HASH_SECRET:'fixture-rate',ALLOWED_ORIGINS:'http://127.0.0.1:8872,https://ara-tech.cc',ARA_GENERAL_INQUIRY_ENABLED:'true',ARA_GENERAL_FIXTURE:'true',ARA_GENERAL_NOTIFICATION_POLICY:JSON.stringify({verified:true,notification_recipient:'aratechsound@gmail.com',receipt_enabled:false,spam_adapter:'fixture'})});
 async function fetchImpl(target,options={}){
  const u=new URL(target);
  if(u.hostname==='127.0.0.1'&&['55442','55443','55439'].includes(u.port)){
   if(u.pathname==='/auth/v1/user'){
    try{const token=String(options.headers.authorization||'').slice(7),[h,b,s]=token.split('.');const claims=JSON.parse(Buffer.from(b,'base64url'));if(claims.sub===actor&&claims.role==='authenticated'&&s===crypto.createHmac('sha256',secret).update(`${h}.${b}`).digest('base64url'))return json({id:actor,email:'owner@example.invalid'});}catch{}return json({},401);
   }
   u.pathname=u.pathname.replace(/^\/rest\/v1/,'');return live(u,options);
  }
  if(u.host==='oauth2.googleapis.com')return json({access_token:'fixture-gmail',expires_in:3600});
  if(u.host==='gmail.googleapis.com'){
   if(u.pathname.endsWith('/profile'))return json({emailAddress:state.mailbox});
   if(u.pathname.endsWith('/messages/send')){
    state.sends++;if(state.failSend)throw Error('fixture_timeout_after_provider_started');
    const sent=JSON.parse(options.body),mime=Buffer.from(sent.raw,'base64url').toString('utf8'),[header,...body]=mime.split(/\r?\n\r?\n/);
    const headers=header.replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/).map(line=>{const i=line.indexOf(':');return {name:line.slice(0,i),value:line.slice(i+1).trim().replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,(_,b)=>Buffer.from(b,'base64').toString('utf8'))};});
    const id=`sent_${Date.now()}_${state.sends}`,threadId=sent.threadId||`sent_thread_${id}`;
    state.messages.set(id,{id,threadId,labelIds:['SENT'],internalDate:String(Date.now()),payload:{mimeType:'text/plain',headers,body:{data:Buffer.from(body.join('\n\n')).toString('base64url')}}});
    return json({id,threadId});
   }
   if(u.pathname.endsWith('/messages')){
    const query=u.searchParams.get('q');state.queries.push(query);const start=Number(query.match(/after:(\d+)/)?.[1])*1000,end=Number(query.match(/before:(\d+)/)?.[1])*1000;
    const offset=Number(u.searchParams.get('pageToken')||0);if(offset&&state.pageQueries.get(String(offset))!==query)throw Error('pageToken/query mismatch');if(state.failPage===offset)return json({},503);
    const all=[...state.messages.values()].filter(m=>Number(m.internalDate)>=start&&Number(m.internalDate)<end&&!m.labelIds.some(l=>['SENT','DRAFT','SPAM','TRASH'].includes(l))).sort((a,b)=>Number(b.internalDate)-Number(a.internalDate)||b.id.localeCompare(a.id));
    const next=offset+50<all.length?String(offset+50):null;if(next)state.pageQueries.set(next,query);
    return json({messages:all.slice(offset,offset+50).map(m=>({id:m.id,threadId:m.threadId})),...(next?{nextPageToken:next}:{})});
   }
   if(u.pathname.includes('/attachments/'))return json({data:Buffer.from('fixture file').toString('base64url')});
   if(u.pathname.includes('/threads/'))return json({messages:[...state.messages.values()].filter(m=>m.threadId===u.pathname.split('/').at(-1))});
   if(u.pathname.includes('/messages/'))return json(state.messages.get(u.pathname.split('/').at(-1))||{},state.messages.has(u.pathname.split('/').at(-1))?200:404);
  }
  throw Error('Live external network forbidden: '+u.host);
 }
 return {actor,state,raw,fetchImpl,jwt,sql:(query,db=database)=>sql(query,db)};
}
module.exports={fixture,jwt,sql,actor};
