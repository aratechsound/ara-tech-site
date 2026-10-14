'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const {createHandler,summaryRequest}=require('../api/_pa-mail-summary-handler.cjs');
const C='11111111-1111-4111-8111-111111111111',O='22222222-2222-4222-8222-222222222222';
let mode='',calls=[],gmail=0,summary=0;
const read=createReadHandler({key:'sb_publishable_fixture',provider:{message:async id=>{gmail++;return {id,threadId:mode==='message-mismatch'?'foreign':'thread',payload:{mimeType:'text/plain',body:{data:Buffer.from('架空メール全体').toString('base64url')}}};},normalize:()=>({subject:'fixture',direction:'inbound',body_text:'架空メール全体',attachments:[]})},fetchImpl:async(url,options)=>{
 calls.push({url,options});assert.equal(options.method,'GET');const q=new URL(url),table=q.pathname.split('/').at(-1);
 let rows=table==='user'?{id:O}:table==='work_admins'?mode==='no-admin'?[]:[{user_id:O}]:table==='pa_inquiries'?mode==='foreign-case'?[]:[{id:C}]:table==='pa_gmail_thread_links'?[{inquiry_id:mode==='foreign-thread'?O:C,gmail_thread_id:'thread'}]:[];
 return {ok:true,json:async()=>rows};
}});
const handler=createHandler({read,service:{run:async({owner,source,generate})=>{summary++;assert.equal(owner,O);assert.equal(source.body_text,'架空メール全体');return {state:generate?'ready':'not_generated',inquiry_id:C,gmail_thread_id:'thread',gmail_message_id:'message',...(generate?{lines:['架空要約']}:{})};}}});
async function request({method='GET',authorization='Bearer fixture-owner-session-0000000000',headers={},query=''}={}){
 const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=JSON.parse(v);}};
 await handler({method,url:'/api/pa-gmail?case='+C+'&thread=thread&message=message'+query,headers:{host:'ara-tech.cc',authorization,...(method==='POST'?{origin:'https://ara-tech.cc'}:{}),...headers}},res);return res;
}
(async()=>{
 for(const [m,status] of [['no-admin',403],['foreign-case',403],['foreign-thread',403],['message-mismatch',403]]){mode=m;const n=summary;assert.equal((await request()).statusCode,status);assert.equal(summary,n);}
 mode='';const n=summary;assert.equal((await request({authorization:''})).statusCode,401);assert.equal(summary,n);
 for(const opts of [{headers:{origin:'https://evil.invalid'}},{headers:{'sec-fetch-site':'cross-site'}},{method:'POST',headers:{origin:''}},{query:'&message=duplicate'},{query:'&body=spoofed'},{method:'DELETE'}])assert.notEqual((await request(opts)).statusCode,200);
 const r=await request();assert.equal(r.body.result.state,'not_generated');assert.equal(r.headers['Cache-Control'],'private, no-store');
 assert.equal((await request({method:'POST'})).body.result.state,'ready');
 assert(calls.every(c=>c.options.method==='GET'&&!c.url.includes('/rpc/')&&c.options.headers.authorization.startsWith('Bearer ')));
 const original={method:'POST',headers:{},url:'/api/pa-gmail?mail_summary=1&case='+C+'&thread=thread&message=message'};
 assert(!summaryRequest({...original,url:'/api/pa-gmail?action=send_reply'}));assert(!summaryRequest({...original,url:'/api/pa-workspace-read?mail_summary=1'}));
 assert(!summaryRequest(original).url.includes('mail_summary'));assert(summaryRequest({...original,url:original.url+'&mail_summary=1'}).url.includes('mail_summary'));
 // Exact PAUI-036 source fix and all pre-existing tests must remain byte-identical.
 const base='bafc3742db4f49bb19b103aeda8932960c616d24';
 const old=cp.execFileSync('git',['ls-tree','-r','--name-only',base,'tests'],{encoding:'utf8'}).trim().split('\n');
 // Windows checkout CRLF and canonical Git LF differ; compare exact content
 // after newline normalization only. Git blob identity is recorded separately.
 for(const file of [...old,'pa-ui/js/model.mjs'])assert.equal(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n'),cp.execFileSync('git',['show',base+':'+file],{encoding:'utf8',maxBuffer:32*1024*1024}).replace(/\r\n/g,'\n'),file);
 assert(fs.readFileSync('pa-ui/js/desk.mjs','utf8').includes('deliveryUnknown,flattenMaterials'));
 console.log(JSON.stringify({status:'PASS',Owner_JWT_ACL:'PASS',source_binding:'PASS',get_does_not_generate:true,unchanged_existing_tests:old.length,PAUI036_preserved:true,real_business_writes:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
