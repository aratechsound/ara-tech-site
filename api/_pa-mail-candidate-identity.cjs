'use strict';
const crypto=require('node:crypto');
const {normalizeMessage,validGmailId}=require('./_pa-gmail.cjs');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Matches the existing PAUI-041 full-thread review fingerprint exactly.
function reviewThreadIdentity(raw,threadId){
  if(raw.id!==threadId||!Array.isArray(raw.messages)||!raw.messages.length||raw.messages.length>2000)throw Error('discovery_thread_invalid');
  const messages=raw.messages.map(m=>{if(!validGmailId(m.id)||m.threadId!==threadId)throw Error('discovery_message_identity');const labels=m.labelIds||[];return {...normalizeMessage(m),direction:labels.includes('SENT')?'outbound':'inbound',labels};});
  if(new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('discovery_duplicate_message');
  const fingerprint=hash(messages.map(m=>[m.id,m.thread_id,m.direction,m.from_address,m.to_addresses,m.cc_addresses,m.subject,m.occurred_at,m.attachments.map(a=>[a.part_id,a.original_filename,a.mime_type,a.size])]));
  return {messages,fingerprint};
}
module.exports={reviewThreadIdentity};
