'use strict';
const assert=require('node:assert/strict');
// PAUI-046 explicitly extends this previously frozen handler. Remove only the
// exact authorized additions, then retain the original whole-file assertion.
// Existing Origin/auth/rate, discovery, attachment and commercial routes cannot
// change under this exception. Runtime authority tests cover the new routes.
module.exports=source=>{
 let s=source.replace(/\r\n/g,'\n');
 assert.equal(require('node:crypto').createHash('sha256').update(s).digest('hex'),'c5539f7e11319bdf7c35c71399ae8428edad23c9dca54be317d38869fe2addfa','PAUI-072 exact reviewed Gmail handler changed');
 const additions=[
  'replyOperationStatus, reconcileReplyOperation, ',
  '    reply_operation_status: "PA_GMAIL_REPLY_PREVIEW",\n    reply_reconcile: "PA_GMAIL_REPLY_PREVIEW",\n',
  "        if(input.action==='reply_operation_status')return sendJson(response,200,{ok:true,result:await replyOperationStatus({\n            actorId:user.id,inquiryId:input.inquiry_id,operationId:input.operation_id,sourceMessageId:input.reply_source_message_id,sourceThreadId:input.reply_source_thread_id})});\n        if(input.action==='reply_reconcile')return sendJson(response,200,{ok:true,result:await reconcileReplyOperation({\n            actorId:user.id,inquiryId:input.inquiry_id,operationId:input.operation_id})});\n",
  '                newOperation:input.new_operation,previousOperationId:input.previous_operation_id,\n',
  '            operationId: input.operation_id,\n',
  '        if (/^reply_operation_(?:unknown|blocked|mismatch|conflict)$/.test(code)) return sendJson(response,409,{ok:false,code});\n'
 ];
 for(const addition of additions){assert.equal(s.split(addition).length,2,'Authorized extension must occur exactly once');s=s.replace(addition,'');}
 for(const [actual,previous]of [["reviewUnlinkedMail({messageId:input.gmail_message_id,actorId:user.id})", "reviewUnlinkedMail({messageId:input.gmail_message_id})"], ["            customerName: input.customer_name, customerEmail: input.customer_email, caseType: input.case_type,\n            reviewToken: input.review_token, identityConfirmed: input.identity_confirmed }) });", "            customerName: input.customer_name, customerEmail: input.customer_email, caseType: input.case_type }) });"], ["[\"mail_operation_conflict\",\"mail_page_conflict\",\"mail_link_conflict\",\"mail_identity_review_required\",\"inbox_review_stale\",\"inquiry_archived\"]", "[\"mail_operation_conflict\",\"mail_page_conflict\",\"mail_link_conflict\",\"inquiry_archived\"]"], ["        if (code === \"inbox_registration_unavailable\") return sendJson(response, 503, {ok:false,code});\n", ""]]){assert.equal(s.split(actual).length,2,'PAUI-072 identity extension must occur exactly once');s=s.replace(actual,previous);}
 assert.equal(require('node:crypto').createHash('sha256').update(s).digest('hex'),'245254f69cf335a4b325f9c8152052caee1831d15238b3f18fe70041ddbdf0af','PAUI-072 complete historical Gmail handler changed');
 return s;
};
