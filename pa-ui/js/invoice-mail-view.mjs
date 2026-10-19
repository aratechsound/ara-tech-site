import {escape} from './model.mjs';
import {mailRow} from './mail-row.mjs';
const at=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ja-JP'):'日時未確認';
export function invoiceMailHtml(data,billing){
 let html='<p class="hint">メール送信履歴と正式請求登録は別です。入口は保存済み送信監査で確認し、過去のcontact・添付区分は変更しません。</p>';
 if(data.partial||data.truncated)html+='<div class="read-error" role="status">送信履歴の一部は未確認です。未確認の原本・送信済み判定を補いません。</div>';
 if(!data.records.length)return html+'<p class="empty-state">取得範囲内の請求関連送信履歴なし（全Gmail送信の有無を断定しません）</p>';
 const formal=billing?.state==='ready'&&billing.value.billings.length===0?'正式請求記録なし':'正式請求記録とこのPDFの対応は未確認です';
 return html+data.records.map(r=>{
  if(r.state!=='SENT'||r.verification!=='SENT_IDENTITY_VERIFIED')return '<article class="record"><p>送信結果未確定 / '+escape(r.state||'UNKNOWN')+'。再送しません。</p><p>送信操作ID: '+escape(r.operation_id)+'</p></article>';
  const mail=mailRow({direction:'outbound',gmail_message_id:r.gmail_message_id,gmail_thread_id:r.gmail_thread_id,from_address:r.from,to_addresses:r.to,cc_addresses:r.cc,subject:r.subject,body_text:r.body_text,attachment_metadata:r.attachments.map(a=>({...a,id:a.asset_id}))},{actions:false,dateText:at(r.sent_at)});
  return '<article class="invoice-mail-record">'+mail+
   '<p class="hint">送信操作ID: '+escape(r.operation_id)+' / '+escape(r.state)+' / 履歴同期 '+escape(r.history_sync)+'</p>'+
   '<p class="hint">保存済み入口: '+(r.entry_context==='invoice'?'請求・入金':'明示された請求書添付')+' / 送信種別: '+escape(r.kind)+'</p>'+
   '<p class="hint">正式請求登録状態: '+formal+'。通常のメール送信を正式な請求書送付済みとは扱いません。</p>'+
   '<a class="lightbtn" target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/?authuser='+escape(encodeURIComponent(r.from))+'#all/'+escape(encodeURIComponent(r.gmail_thread_id))+'">Gmail送信履歴を開く</a>'+
   '<details><summary>送信原本identity</summary><p>Gmail message: '+escape(r.gmail_message_id)+'</p><p>thread: '+escape(r.gmail_thread_id)+'</p>'+r.attachments.map(a=>'<p>MIME part '+escape(a.part_id)+' / '+escape(a.size)+' bytes / SHA256 '+escape(a.sha256)+'</p>').join('')+'</details>'+
   (r.attachments.length?'':'<p>請求書PDFの添付は確認されていません。メール送信を正式な請求書送付済みとは扱いません。</p>')+'</article>';
 }).join('');
}
