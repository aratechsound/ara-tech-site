(() => {
 'use strict';
 // Fragment never reaches HTTP access logs. Keep it in memory only and remove
 // it from the address bar before requesting any contract data.
 const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
 // A newly issued fragment link may reuse this already-open document. Reload
 // once so the new token gets its own view instead of retaining the old offer.
 window.addEventListener('hashchange',()=>{if(location.hash)location.reload();});
 const $=id=>document.getElementById(id);let offer,busy=false,documents=[],activeDoc=0,viewEpoch=0;
 const docCache=new Map();
 const japaneseDate=value=>new Date(value+'T00:00:00Z').toLocaleDateString('ja-JP',{timeZone:'UTC',year:'numeric',month:'long',day:'numeric',weekday:'short'});
 const shortDate=value=>{const [,m,d]=value.split('-');return Number(m)+'/'+Number(d);};
 const messages={expired_link:'このURLの有効期限が切れています。ARA-TECHへ再発行をご依頼ください。',invalid_link:'このURLは利用できません。ARA-TECHへお問い合わせください。',case_unavailable:'現在この案件の回答を受け付けていません。ARA-TECHへお問い合わせください。',contract_changed:'確認内容が一致しません。案内されたURLを開き直してください。',consent_required:'同意と確認者氏名をご入力ください。',rate_limited:'操作が集中しています。しばらくしてからお試しください。'};
 async function request(action,extra={},binary=false){
  const r=await fetch('/api/pa-contract',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',referrerPolicy:'no-referrer',body:JSON.stringify({action,token,...extra})});
  if(binary&&r.ok)return r.blob();const data=await r.json();if(!r.ok||!data.ok)throw Error(data.code);return data.result;
 }
 function accepted(pending=false){$('confirmation').hidden=true;$('status').textContent='回答受付済み。正式依頼を受け付けました。'+(pending?' 契約控えPDFを準備中です。':' 契約控えPDFはARA-TECHからご案内します。');}
 async function load(){
  if(!/^[a-f0-9]{64}$/.test(token))throw Error('invalid_link');
  offer=await request('view');if(offer.state==='accepted'){accepted();return;}
  const s=offer.snapshot;
  $('event').textContent=s.event_name;$('date').textContent=japaneseDate(s.event_date);$('customer').textContent=s.customer_name;
  $('amount').textContent=Number(s.amount).toLocaleString('ja-JP')+'円';$('confirmer').value=s.confirmer_name;
  $('expires').textContent='回答期限（日本時間）：'+new Date(Date.parse(offer.expires_at)-1).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
  $('cancel-base').textContent='開催日 '+japaneseDate(s.event_date)+'を基準';
  // Legacy links render only their original text: no recalculation/new terms.
  if(s.presentation_version===3&&Array.isArray(s.cancellation_bands)){
   $('cancel').hidden=false;
   for(const band of s.cancellation_bands){
    const cell=document.createElement('div');cell.className='cancel-cell';
    const main=document.createElement('div');main.className='cancel-main';
    const label=document.createElement('span');label.textContent=band.label;
    const rate=document.createElement('strong');rate.textContent=band.rate===0?'無料':band.rate+'%';main.append(label,rate);
    const dates=document.createElement('div');dates.className='cancel-date';
    dates.textContent=(band.from?shortDate(band.from)+' 〜 ':'〜 ')+shortDate(band.to);cell.append(main,dates);$('cancel').append(cell);
   }
   for(const block of s.cancellation_terms.split('\n\n').slice(4)){const p=document.createElement('p');p.textContent=block;$('cancel-notes').append(p);}
  }else{$('legacy-cancel').hidden=false;$('legacy-cancel').textContent=s.cancellation_terms;}
  if(s.payment_due_date){$('payment-date').textContent=japaneseDate(s.payment_due_date);$('payment-summary').textContent=s.payment_summary;}
  else{$('payment-label').textContent='今回のお支払条件';$('payment-date').className='legacy-payment';$('payment-date').textContent=s.payment_terms.split('\n\n')[0];}
  const paymentParts=s.payment_terms.split('\n\n');
  $('payment-help').textContent=paymentParts.slice(1).join('\n\n');
  const appendTerm=(title,value)=>{const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.className='multiline';p.textContent=value;$('business').append(h,p);};
  appendTerm('ご依頼内容',s.request_summary);
  // Full issued terms, not shortened mock text; includes every responsibility exception.
  appendTerm('ご依頼条件の全文',s.terms_text);
  documents=[{...s.quote,label:'最終見積書',role:'quote'},...(s.related_documents||[]).map((d,index)=>({...d,label:d.filename,role:'related',index}))];
  $('document-summary').textContent='今回の確認資料：'+documents.map(d=>d.label).join('／');
  documents.forEach((d,index)=>{const b=document.createElement('button');b.type='button';b.className='tab';b.id='document-tab-'+index;b.setAttribute('role','tab');b.setAttribute('aria-controls','pdfViewer');const title=document.createElement('span');title.textContent=d.label;const badge=document.createElement('span');badge.className='badge';badge.textContent=index===0?'契約資料':'関連資料';b.append(title,badge);b.onclick=()=>showDocument(index);b.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?documents.length-1:(index+(e.key==='ArrowRight'?1:-1)+documents.length)%documents.length;showDocument(next);$('document-tab-'+next).focus();};$('tabs').append(b);});
  $('confirmation').hidden=false;$('status').textContent='';
  await showDocument(0);
 }
 async function documentBlob(index){
  if(docCache.has(index))return docCache.get(index);
  const d=documents[index];const blob=await request(d.role==='quote'?'quote':'related_document',d.role==='quote'?{}:{index:d.index},true);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==d.sha256)throw Error('contract_changed');
  const result={blob,url:URL.createObjectURL(blob)};docCache.set(index,result);return result;
 }
 async function showDocument(index){
  activeDoc=index;const epoch=++viewEpoch,d=documents[index];$('pdfViewer').hidden=true;$('pdfViewer').removeAttribute('src');
  for(const [i,b] of Array.from($('tabs').children).entries()){b.classList.toggle('active',i===index);b.setAttribute('aria-selected',String(i===index));b.tabIndex=i===index?0:-1;}
  $('docTitle').textContent=d.filename;$('docNote').textContent=d.role==='quote'?'契約金額・業務範囲の正式根拠資料':'関連資料（金額根拠資料ではありません）';$('quote-status').textContent='資料を読み込んでいます。';
  try{const file=await documentBlob(index);if(epoch!==viewEpoch)return;$('pdfViewer').src=file.url+'#toolbar=1&navpanes=0&view=FitH';$('pdfViewer').hidden=false;$('quote-status').textContent='表示できない場合は「表示中のPDFをダウンロード」からご確認ください。';}
  catch(e){if(epoch===viewEpoch)$('quote-status').textContent=messages[e.message]||'資料を確認できません。ARA-TECHへお問い合わせください。';}
 }
 window.addEventListener('pagehide',()=>{for(const file of docCache.values())URL.revokeObjectURL(file.url);docCache.clear();});
 $('quote').addEventListener('click',async()=>{
  $('quote').disabled=true;
  try{const index=activeDoc,file=await documentBlob(index);const a=document.createElement('a');a.href=file.url;a.download=documents[index].filename;a.click();$('quote-status').textContent='表示中のPDFをダウンロードしました。';}
  catch(e){$('quote-status').textContent=messages[e.message]||'見積書を確認できません。ARA-TECHへお問い合わせください。';}
  finally{$('quote').disabled=false;}
 });
 $('accept-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy||!offer)return;busy=true;$('submit').disabled=true;
  try{const r=await request('accept',{offer_id:offer.offer_id,snapshot_sha256:offer.snapshot_sha256,confirmer_name:$('confirmer').value,agree:$('agree').checked});accepted(r.receipt_status==='pending');}
  catch(e){$('submission-status').textContent=messages[e.message]||'受付結果を確認できません。案内されたURLを開き直し、回答受付済みかご確認ください。';}
  finally{busy=false;$('submit').disabled=false;}
 });
 load().catch(e=>{$('status').textContent=messages[e.message]||'確認内容を読み込めません。しばらくしてから案内されたURLを開き直してください。';});
})();
