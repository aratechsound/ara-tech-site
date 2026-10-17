// Explicit save only. No sync, send, adoption, classification or persistent state.
export function downloadFilename(header,fallback){
 let name;
 try{name=decodeURIComponent(header?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1]||'');}catch{}
 name ||= header?.match(/filename="([^"\r\n]*)"/iu)?.[1]||fallback||'資料';
 return [...name.replace(/[\p{Cc}\\/]/gu,'_').replace(/[. ]+$/gu,'')].slice(0,255).join('')||'資料';
}
export async function saveOriginal({item,assets,isCurrent,label}){
 let record;
 try{
  record=await assets.record(item,{fresh:true,download:true,priority:100});
  if(!isCurrent())return;
  if(record.blob.size>20*1024*1024)throw Object.assign(Error('file_too_large'),{code:'file_too_large'});
  const data=await record.blob.arrayBuffer();
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if([item.sha256,record.blob.originalSha256].some(h=>h&&h!==sha))throw Object.assign(Error('asset_identity_mismatch'),{code:'asset_identity_mismatch'});
  if(!isCurrent())return;
  const a=document.createElement('a');a.href=record.url;a.download=downloadFilename(null,record.blob.originalFilename||item.filename);a.hidden=true;
  document.body.append(a);a.click();a.remove();
  if(label)label.textContent='ダウンロードしました';
 }finally{if(record)setTimeout(()=>assets.release(record),1000);}
}
export function downloadButton({item,assets,isCurrent,onError,onStart=()=>{},label='ダウンロード'}){
 const b=document.createElement('button');b.type='button';b.className='lightbtn original-download';b.textContent=label;
 b.disabled=!item.asset_id||item.asset_kind==='document'||item.asset_kind==='receipt';
 if(item.asset_kind==='document'||item.asset_kind==='receipt')b.title='商務原本のダウンロードは今回の限定リリース対象外です（既存の取得経路・制限を維持）';
 b.onclick=async()=>{if(b.disabled)return;b.disabled=true;onStart();try{await saveOriginal({item,assets,isCurrent});}catch(e){if(isCurrent())onError?.(e);}finally{if(isCurrent())b.disabled=false;}};
 return b;
}
