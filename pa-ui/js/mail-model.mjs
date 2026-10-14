import {purposeExcerpt} from './mail-purpose.mjs';
// Template contents are inert, including remote media. Never attach email HTML.
export function htmlText(html, doc=globalThis.document, preserveQuotes=false) {
  if(!doc)return '';
  const template=doc.createElement('template');template.innerHTML=preserveQuotes?String(html||''):String(html||'').slice(0,50000);
  const fragment=template.content;
  fragment.querySelectorAll('script,style,iframe,object,embed,svg,math,template,form,input,button,img,video,audio,link,meta,[hidden],[aria-hidden="true"]').forEach(n=>n.remove());
  if(preserveQuotes)fragment.querySelectorAll('blockquote,.gmail_quote').forEach(n=>n.prepend('\n> 引用\n'));
  else fragment.querySelectorAll('blockquote,.gmail_quote,.gmail_signature').forEach(n=>n.remove());
  fragment.querySelectorAll('[style]').forEach(n=>{if(n.style.display==='none'||n.style.visibility==='hidden')n.remove();});
  fragment.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));
  fragment.querySelectorAll('p,div,li,tr,h1,h2,h3').forEach(n=>n.append('\n'));
  return fragment.textContent||'';
}
export function excerpt(text) {
  const lines=String(text||'').slice(0,50000).replace(/\r\n?/g,'\n').split('\n'),out=[];
  for(const raw of lines){
    const s=raw.trim();
    if(/^>|^On .{0,250}wrote:|^Le .{0,250}écrit|^[-_]{3,}\s*(Original Message|Forwarded|元のメッセージ)|^Begin forwarded message:|^転送されたメッセージ|^\d{4}[年/.-].{0,160}(書きました|wrote):?\s*$|^(差出人|From):\s*.+/iu.test(s))break;
    if(out.length && (/^(--|[-_=＊*]{4,})\s*$/.test(s)||/^(Sent from my|iPhoneから送信|Androidから送信)/i.test(s)))break;
    if(s)out.push(s);
  }
  // Keep the new message and bound long signatures/headers without inventing content.
  return out.join('\n').slice(0,650);
}
export function savedExcerpt(row){
  const text=row.body_text||row.snippet||htmlText(row.body_html||'');
  return purposeExcerpt(text);
}
export function mailAttachments(row){
  if(!Array.isArray(row.attachment_metadata))return [];
  return row.attachment_metadata.map((a,index)=>{
    const ref=String(a.id||a.gmail_attachment_id||a.part_id||'');
    const filename=String(a.original_filename||a.filename||'名称未取得');
    return {key:'mail:'+row.gmail_message_id+':'+ref+':'+index,asset_kind:'mail',asset_id:ref||null,message_id:row.gmail_message_id,filename,title:filename,mime_type:String(a.mime_type||''),size:a.size,versions:[],change:'確認状態未取得',index,
      read_route:row.read_route==='live'?'live':undefined,source_subject:row.subject||'件名未提供',source_at:row.received_at||row.sent_at||row.indexed_at||null,source_direction:row.direction,case_id:row.inquiry_id,gmail_thread_id:row.gmail_thread_id};
  });
}
export function messageAttention(row,caseAttention,rows=[]){
  if(row.index_state==='not_indexed')return false;
  // A case-level attention flag alone is not evidence that every mail is NEW.
  const at=Date.parse(caseAttention?.last_seen_inbound_at||'');
  return Boolean(Number.isFinite(at)&&row.direction==='inbound'&&Date.parse(row.received_at||'')===at&&caseAttention?.attention_state==='new_customer_reply'
    &&rows.filter(m=>m.direction==='inbound'&&Date.parse(m.received_at||'')===at).length===1);
}
export function fileType(item){
  if(item.mime_type==='application/pdf')return 'PDF';
  if(/^image\//.test(item.mime_type))return '画像';
  return (/\.([^.]+)$/.exec(item.filename||'')?.[1]||'FILE').toUpperCase().slice(0,12);
}

export function fullBody(row){
  const text=String(row.body_text||htmlText(row.body_html||'',globalThis.document,true)||'').replace(/\r\n?/g,'\n');
  const lines=text.split('\n');
  const at=lines.findIndex(line=>/^\s*>|^On .{0,250}wrote:|^[-_]{3,}\s*(Original Message|Forwarded|元のメッセージ)|^Begin forwarded message:|^転送されたメッセージ|^\d{4}[年/.-].{0,160}(書きました|wrote):?\s*$|^(差出人|From):\s*.+/iu.test(line.trim()));
  return {text:at<0?text:lines.slice(0,at).join('\n'),quoted:at<0?'':lines.slice(at).join('\n'),empty:!text.trim()};
}
