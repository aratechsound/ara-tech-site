'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createReadHandler}=require('../api/_pa-workspace-read.cjs');
const C='11111111-1111-4111-8111-111111111111',P='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333',V='44444444-4444-4444-8444-444444444444';
const bytes=Buffer.from('%PDF-fixture'),hash=crypto.createHash('sha256').update(bytes).digest('hex');let mode='',calls=[],providerCalls=0;
const asset={id:V,card_id:D,portal_id:P,source_type:'gmail_attachment',mime_type:'application/pdf',source_ref:{gmail_message_id:'mail1',gmail_attachment_id:'a'},gmail_part_id:'1',source_content_sha256:hash,source_byte_size:bytes.length};
const handler=createReadHandler({key:'sb_publishable_fixture',provider:{message:async()=>{providerCalls++;return {id:'mail1',threadId:'thread1'};},attachment:async()=>{providerCalls++;return {bytes,mime:'application/pdf'};}},fetchImpl:async(url,options)=>{
 assert.equal(options.method,'GET');const q=new URL(url),table=q.pathname.split('/').at(-1);calls.push(q);let data=[];
 if(q.pathname==='/auth/v1/user')data={id:C};else if(table==='work_admins')data=[{user_id:C}];else if(table==='pa_inquiries')data=mode==='unreadable'?[]:[{id:C}];
 else if(table==='pa_portals')data=[{id:P,case_id:C}];else if(table==='pa_portal_document_versions'||table==='pa_portal_photo_items'){data=[{...asset,id:mode==='wrong-id'?D:V,portal_id:mode==='foreign-photo'?D:P}];if(mode==='duplicate-asset')data.push({...asset});}
 else if(table==='pa_portal_document_cards')data=[{id:mode==='wrong-parent'?V:D,portal_id:mode==='foreign-parent'?D:P}];
 else if(table==='pa_gmail_message_index'){data=[{inquiry_id:C,gmail_message_id:'mail1',gmail_thread_id:'thread1',attachment_metadata:[{id:'a',part_id:'1',mime_type:'application/pdf',size:bytes.length}]}];if(mode==='duplicate-mail')data.push({...data[0]});}
 else if(table==='pa_gmail_thread_links')data=mode==='missing-owner'?[]:[{inquiry_id:C,gmail_thread_id:'thread1'}];
 return new Response(JSON.stringify(data));
}});
async function read(kind='version'){const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=value;}};await handler({method:'GET',url:'/api/pa-workspace-read?path='+encodeURIComponent(`/data/material/${C}/${kind}/${V}`),headers:{authorization:'Bearer fixture-only-long-token-0123456789'}},res);return res;}
(async()=>{
 let passed=0;
 for(const m of ['', 'wrong-id','duplicate-asset','wrong-parent','foreign-parent','duplicate-mail','missing-owner','unreadable','foreign-photo']){mode=m;calls=[];providerCalls=0;const res=await read(m==='foreign-photo'?'photo':'version');assert.equal(res.statusCode,m?403:200,m);if(m)assert.equal(providerCalls,0,m);else {assert(Buffer.from(res.body).equals(bytes));for(const q of calls)if(q.pathname.endsWith('pa_portal_document_versions')){assert.equal(q.searchParams.get('id'),'eq.'+V);assert.equal(q.searchParams.get('limit'),'2');assert.equal(q.searchParams.get('archived_at'),'is.null');}assert(!calls.some(q=>q.pathname.endsWith('pa_portal_photo_items')));assert(!calls.some(q=>q.pathname.endsWith('pa_gmail_message_index')&&!q.searchParams.has('gmail_message_id')));assert(/auth;dur=/.test(res.headers['Server-Timing']));assert(!res.headers['Server-Timing'].includes(C));}passed++;}
 console.log(`PASS ${passed}/${passed} targeted row and parent attribution; Provider never read on failed authorization`);
})().catch(e=>{console.error(e);process.exitCode=1;});
