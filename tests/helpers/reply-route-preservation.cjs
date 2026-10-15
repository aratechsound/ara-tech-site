'use strict';
const assert=require('node:assert/strict');
// PAUI-046 explicitly extends this previously frozen handler. Remove only the
// exact authorized additions, then retain the original whole-file assertion.
// Existing Origin/auth/rate, discovery, attachment and commercial routes cannot
// change under this exception. Runtime authority tests cover the new routes.
module.exports=source=>{
 let s=source.replace(/\r\n/g,'\n');
 const additions=[
  'replyOperationStatus, reconcileReplyOperation, ',
  '    reply_operation_status: "PA_GMAIL_REPLY_PREVIEW",\n    reply_reconcile: "PA_GMAIL_REPLY_PREVIEW",\n',
  "        if(input.action==='reply_operation_status')return sendJson(response,200,{ok:true,result:await replyOperationStatus({\n            actorId:user.id,inquiryId:input.inquiry_id,operationId:input.operation_id,sourceMessageId:input.reply_source_message_id,sourceThreadId:input.reply_source_thread_id})});\n        if(input.action==='reply_reconcile')return sendJson(response,200,{ok:true,result:await reconcileReplyOperation({\n            actorId:user.id,inquiryId:input.inquiry_id,operationId:input.operation_id})});\n",
  '                newOperation:input.new_operation,previousOperationId:input.previous_operation_id,\n',
  '            operationId: input.operation_id,\n',
  '        if (/^reply_operation_(?:unknown|blocked|mismatch|conflict)$/.test(code)) return sendJson(response,409,{ok:false,code});\n'
 ];
 for(const addition of additions){assert.equal(s.split(addition).length,2,'Authorized extension must occur exactly once');s=s.replace(addition,'');}
 return s;
};
