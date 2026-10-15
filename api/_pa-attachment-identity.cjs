'use strict';
// Read-only identity resolution. Callers must authorize the registered asset,
// case, unique indexed message/thread and fresh Provider message first.
const crypto = require('node:crypto');
const {canonicalAssetKey} = require('./_pa-portal-candidates.cjs');
const REF = /^[^\s\u0000-\u001f\\/]{1,1000}$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const present = value => value !== undefined && value !== null && value !== '';
function fail(code='asset_identity_mismatch'){throw Error(code);}
function assertHints(asset, messageId, attachment){
  if(asset.mime_type !== attachment.mime_type)fail();
  const part=asset.gmail_part_id;
  if(present(part) && (!REF.test(part) || part !== attachment.part_id))fail();
  if(present(asset.canonical_attachment_key) && asset.canonical_attachment_key !== canonicalAssetKey(messageId,attachment.part_id))fail();
  if(present(asset.source_byte_size) && (!Number.isSafeInteger(Number(asset.source_byte_size)) || Number(asset.source_byte_size)<=0 || Number(asset.source_byte_size)!==Number(attachment.size)))fail();
  if(present(asset.source_content_sha256) && !HASH.test(asset.source_content_sha256))fail();
}
async function resolveRegistered({asset,messageId,attachments,loadCurrent,loadHistorical,measure=()=>{}}){
  const digestTimed=bytes=>{const start=performance.now();try{return digest(bytes);}finally{measure('sha256',performance.now()-start);}};
  const hints=(value,attachment)=>{const start=performance.now();try{return assertHints(value,messageId,attachment);}finally{measure('part_canonical',performance.now()-start);}};
  const historicalId=asset.source_ref?.gmail_attachment_id;
  if(!REF.test(historicalId||''))fail('attachment_mail_mismatch');
  const exact=attachments.filter(a=>a.id===historicalId);
  let selected,method,expectedHash=asset.source_content_sha256||'',historicalSize;
  if(exact.length>1)fail('attachment_identity_ambiguous');
  if(exact.length===1){selected=exact[0];method='indexed_attachment';}
  else if(present(asset.gmail_part_id)||present(asset.canonical_attachment_key)){
    const stable=attachments.filter(a=>(!present(asset.gmail_part_id)||a.part_id===asset.gmail_part_id)
      &&(!present(asset.canonical_attachment_key)||canonicalAssetKey(messageId,a.part_id)===asset.canonical_attachment_key));
    if(stable.length>1)fail('attachment_identity_ambiguous');
    if(stable.length!==1)fail('attachment_mail_mismatch');
    selected=stable[0];method='registered_message_part';
  }else{
    // Only a reference read from an authorized persisted portal row may enter
    // this path. No filename matching, general unknown-ID acceptance or writes.
    if(present(expectedHash)&&!HASH.test(expectedHash))fail();
    if(!expectedHash){
      const historical=await loadHistorical(historicalId);
      if(!Buffer.isBuffer(historical.bytes)||!historical.bytes.length)fail();
      expectedHash=digestTimed(historical.bytes);historicalSize=historical.bytes.length;
    }
    const size=present(asset.source_byte_size)?Number(asset.source_byte_size):historicalSize;
    const possible=attachments.filter(a=>a.mime_type===asset.mime_type&&(!present(size)||Number(a.size)===size));
    if(possible.length>32 || possible.reduce((n,a)=>n+Number(a.size||0),0)>40*1024*1024)fail('attachment_identity_unavailable');
    const matches=[];
    for(const a of possible){
      hints(asset,a);
      const file=await loadCurrent(a);
      if(digestTimed(file.bytes)===expectedHash)matches.push({a,file});
    }
    if(matches.length>1)fail('attachment_identity_ambiguous');
    if(matches.length!==1)fail();
    selected=matches[0].a;method='same_message_sha256';
  }
  hints(asset,selected);
  // ID and part evidence must not point at different indexed attachments.
  if(selected.part_id && attachments.filter(a=>a.part_id===selected.part_id).length!==1)fail('attachment_identity_ambiguous');
  const file=await loadCurrent(selected);
  if(!Buffer.isBuffer(file.bytes)||!file.bytes.length || file.mime!==asset.mime_type
    || Number(selected.size)!==file.bytes.length || (expectedHash&&digestTimed(file.bytes)!==expectedHash))fail();
  return {...file,identityProof:{method,indexed_id_equal:exact.length===1,stored_part:present(asset.gmail_part_id),stored_canonical:present(asset.canonical_attachment_key),stored_sha256:present(asset.source_content_sha256),part_verified:!!selected.part_id,sha256_verified:!!expectedHash}};
}
module.exports={resolveRegistered,assertHints};
