'use strict';
const assert=require('node:assert/strict'),{createInvoiceMailRead}=require('../api/_pa-invoice-mail-read.cjs');
const gmail=require('../api/_pa-gmail.cjs'),proof=require('../api/_pa-reply-proof.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',O='33333333-3333-4333-8333-333333333333',U='44444444-4444-4444-8444-444444444444';
const attachment={filename:'請求.pdf',mime_type:'application/pdf',size:11,sha256:'a'.repeat(64)};
let mode='ok',gets=0,reads=0;
const raw={id:'sent',threadId:'thread',labelIds:['SENT'],internalDate:'1700000000000',payload:{headers:[{name:'From',value:'aratechsound@gmail.com'},{name:'To',value:'recipient@example.invalid'},{name:'Cc',value:'cc@example.invalid'},{name:'Subject',value:'Synthetic'},{name:'Message-ID',value:'<synthetic@example.invalid>'}],mimeType:'multipart/mixed',parts:[{partId:'1',filename:'請求.pdf',mimeType:'application/pdf',body:{size:11,attachmentId:'fresh-id'}}]}};
const audit=()=>({inquiry_id:A,actor_user_id:U,details:{operation_id:O,entry_context:'invoice',communication_kind:'contact',gmail_message_id:'sent',gmail_thread_id:'thread',attachments:[{...attachment}]}});
const op=()=>({operation_id:O,inquiry_id:A,state:mode==='unknown'?'UNKNOWN':'SENT',gmail_message_id:mode==='ack'?'different':'sent',gmail_thread_id:'thread',history_sync:'COMPLETE',binding:{contract:'PAUI-062',inquiry_id:A,account:'aratechsound@gmail.com',kind:'contact',to:'recipient@example.invalid',cc:['cc@example.invalid'],subject:'Synthetic',attachments:[{...attachment}]}});
const read=createInvoiceMailRead({getInquiry:async id=>{assert.equal(id,A);},rows:async(t,q)=>{
 if(t==='pa_inquiry_audit'){if(mode==='audit_fail')throw Error('case_mail_read_unavailable');const a=audit();if(mode==='general')a.details.entry_context='general';if(mode==='owner')a.actor_user_id=B;if(mode==='audit_identity')a.details.attachments[0].sha256='b'.repeat(64);return [a];}
 if(t==='pa_gmail_message_index')return [{inquiry_id:mode==='foreign'?B:A,gmail_message_id:'sent',gmail_thread_id:'thread',direction:'outbound',attachment_metadata:[{id:'persisted-id',part_id:mode==='part'?'2':'1',filename:attachment.filename,mime_type:attachment.mime_type,size:attachment.size}]}];
 assert.equal(t,'pa_gmail_thread_links');return [{inquiry_id:A,gmail_thread_id:'thread'}];
},rpc:async(actor,action,p)=>{gets++;assert.equal(actor,U);assert.equal(action,'get');assert.deepEqual(p,{inquiry_id:A,operation_id:O});return {ok:true,operation:op()};},gmailMessage:async()=>{reads++;const r=structuredClone(raw);if(mode==='recipient')r.payload.headers.find(h=>h.name==='To').value='other@example.invalid';if(mode==='sent_label')r.labelIds=[];return r;},normalize:gmail.normalizeMessage,official:'aratechsound@gmail.com',subject:proof.subject,uuid:require('../api/_pa-mail.cjs').isUuid,ids:gmail.validGmailId});
(async()=>{
 let x=await read({inquiry_id:A},U);assert.equal(x.records.length,1);assert.equal(x.partial,false);assert.equal(x.records[0].kind,'contact');assert.equal(x.records[0].entry_context,'invoice');assert.equal(x.records[0].attachments[0].sha256,attachment.sha256);assert.equal(x.records[0].attachments[0].document_kind,'normal');assert.equal(x.records[0].formal_invoice_dispatched,false);assert.equal(x.records[0].attachments[0].asset_id,'persisted-id');
 for(mode of ['foreign','part','owner','recipient','ack','audit_identity','sent_label']){x=await read({inquiry_id:A},U);assert.equal(x.records.length,0,mode);assert.equal(x.partial,true,mode);assert.equal(x.errors.length,1,mode);}
 mode='unknown';const before=reads;x=await read({inquiry_id:A},U);assert.equal(x.records[0].state,'UNKNOWN');assert.deepEqual(x.records[0].attachments,[]);assert.equal(reads,before);
 mode='general';x=await read({inquiry_id:A},U);assert.equal(x.records.length,0);assert.equal(x.partial,false);
 mode='audit_fail';await assert.rejects(read({inquiry_id:A},U),/case_mail_read_unavailable/);
 assert(gets>0);console.log(JSON.stringify({status:'PASS',contact_preserved:true,invoice_entry_from_existing_audit:true,no_filename_classification:true,ack_case_thread_part_sha_owner_guards:true,unknown_no_transition:true,audit_error_not_empty:true,provider_sends:0,db_mutations:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
