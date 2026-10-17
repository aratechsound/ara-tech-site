'use strict';
// Reuse the portal/Gmail RFC 6266 filename encoder. This grants no access;
// callers must first verify case ACL, persisted identity and original bytes.
const crypto=require('node:crypto');
const {attachmentContentDisposition}=require('./_pa-filename.cjs');
const {streamAttachmentResponse}=require('./_pa-gmail.cjs');
const MAX=20*1024*1024;
async function sendOriginal(res,{bytes,mime,filename}){
 if(res.destroyed)return;
 if(!Buffer.isBuffer(bytes)||bytes.length>MAX)throw Error('file_too_large');
 const type=/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime||'')?mime:'application/octet-stream';
 res.setHeader('Content-Type',type);
 res.setHeader('Content-Disposition',attachmentContentDisposition(filename));
 res.setHeader('Content-Length',String(bytes.length));
 res.setHeader('X-PA-Original-SHA256',crypto.createHash('sha256').update(bytes).digest('hex'));
 res.setHeader('Cache-Control','private, no-store, max-age=0');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");
 if(!bytes.length)return res.end(bytes);
 // The existing event-portal stream preserves bytes and backpressure. Never
 // convert or compress a file or create a public/signed bypass URL.
 return streamAttachmentResponse(res,{bytes,mime_type:type,filename});
}
module.exports={sendOriginal};
