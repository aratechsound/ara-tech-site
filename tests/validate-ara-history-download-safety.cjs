'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{createReadHandler}=require('../api/_pa-workspace-read.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',bytes=Buffer.from('%PDF-1.4\nhistorical fixture\n%%EOF');
let mode='',read=false,calls=[];
const meta={id:'part1',part_id:'part1',mime_type:'application/pdf',original_filename:'見積書（送信済み）.pdf',size:bytes.length};
const raw={id:'sent1',threadId:'thread1',labelIds:['SENT']};
const provider={thread:async()=>({id:'thread1',messages:[raw]}),message:async()=>raw,normalize:()=>({direction:'outbound',attachments:[meta]}),attachment:async()=>{read=true;return {bytes,mime:'application/pdf',filename:meta.original_filename};}};
const handler=createReadHandler({key:'sb_publishable_fixture',provider,fetchImpl:async(url,options={})=>{
 calls.push(options.method||'GET');const q=new URL(url),t=q.pathname.split('/').at(-1);let value=[];
 if(q.pathname==='/auth/v1/user')value={id:A};else if(t==='work_admins')value=[{user_id:A}];else if(t==='pa_inquiries')value=[{id:A}];
 else if(t==='pa_gmail_thread_links')value=read&&mode==='unlink'?[]:[{inquiry_id:read&&mode==='move'?B:A,gmail_thread_id:'thread1'}];
 else if(t==='pa_gmail_message_index')value=read&&mode==='index-conflict'?[{inquiry_id:B,gmail_thread_id:'thread1',gmail_message_id:'sent1'}]:[];
 return Response.json(value);
}});
(async()=>{for(mode of ['', 'unlink','move','index-conflict']){
 read=false;calls=[];const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},write(b){(this.parts||=[]).push(b);return true;},end(b){this.body=this.parts?Buffer.concat(this.parts):b;}};
 await handler({method:'GET',headers:{authorization:'Bearer '+'fixture-only-'.repeat(4)},url:'/api/pa-workspace-read?path='+encodeURIComponent('/data/download/sent-estimate-attachment/'+A+'/sent1/part1')},res);
 assert.equal(res.statusCode,mode?403:200,mode);assert(calls.every(m=>m==='GET'));
 if(!mode){assert.deepEqual(res.body,bytes);assert.equal(res.headers['X-PA-Original-SHA256'],crypto.createHash('sha256').update(bytes).digest('hex'));assert.match(res.headers['Content-Disposition'],/^attachment;/);}
 else assert(!res.headers['Content-Disposition'],'Changed binding must never release bytes');
 }console.log(JSON.stringify({status:'PASS',historical_sent_pdf:true,post_fetch_unlink_foreign_owner_index_conflict_rejected:true,original_sha:true,writes:0,sends:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
