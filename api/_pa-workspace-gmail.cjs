'use strict';
// Only Gmail reads and the existing OAuth exchange. No Supabase service client,
// sync, rate bucket, labels, audit writes, reconciliation or send operations.
const {gmailJson, gmailMessage, normalizeMessage} = require('./_pa-gmail.cjs');
const MAX = 20 * 1024 * 1024;
function createProvider(fetchImpl=fetch){
  const boundedFetch=(url,options={})=>fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
  async function hydrate(raw){
    async function walk(p){
      if(!p)return;
      if(!p.filename&&['text/plain','text/html'].includes(p.mimeType)&&p.body?.attachmentId&&!p.body.data){
        if(Number(p.body.size)>100000)throw Error('body_too_large');
        const data=await gmailJson('/messages/'+encodeURIComponent(raw.id)+'/attachments/'+encodeURIComponent(p.body.attachmentId),{method:'GET'},boundedFetch);
        if(typeof data.data!=='string'||data.data.length>140000)throw Error('body_too_large');
        p.body={...p.body,data:data.data};
      }
      for(const child of p.parts||[])await walk(child);
    }
    await walk(raw.payload);return raw;
  }
async function message(id) { return hydrate(await gmailMessage(id,boundedFetch)); }
async function thread(id) { return gmailJson('/threads/'+encodeURIComponent(id)+'?format=full',{method:'GET'},boundedFetch); }
async function attachment({messageId,metadata,raw}) {
  const normalized=normalizeMessage(raw);
  const refs=[metadata.id,metadata.gmail_attachment_id,metadata.part_id].filter(Boolean);
  const matches=normalized.attachments.filter(a=>refs.includes(a.id)||refs.includes(a.part_id));
  if(matches.length!==1)throw Error('attachment_mail_mismatch');
  const fresh=matches[0];
  if(fresh.mime_type!==metadata.mime_type || Number(fresh.size)!==Number(metadata.size))throw Error('asset_identity_mismatch');
  let part;
  function find(p){if(!p)return;if(String(p.partId||'')===fresh.part_id && String(p.body?.attachmentId||p.partId)===fresh.id)part=p;for(const child of p.parts||[])find(child);}
  find(raw.payload);
  const payload=fresh.gmail_attachment_id
    ? await gmailJson('/messages/'+encodeURIComponent(messageId)+'/attachments/'+encodeURIComponent(fresh.gmail_attachment_id),{method:'GET'},boundedFetch)
    : part?.body;
  if(typeof payload?.data!=='string'||payload.data.length>Math.ceil(MAX*4/3)+4||! /^[A-Za-z0-9_-]*={0,2}$/.test(payload.data))throw Error('asset_identity_mismatch');
  return {bytes:Buffer.from(payload.data,'base64url'),mime:fresh.mime_type};
}
return {message,thread,attachment,normalize:normalizeMessage};
}
module.exports={...createProvider(),createProvider};
