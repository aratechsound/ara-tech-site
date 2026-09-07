(() => {
 'use strict';
 // Fragment never reaches HTTP access logs. Keep it in memory only and remove
 // it from the address bar before requesting any contract data.
 const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
 // A newly issued fragment link may reuse this already-open document. Reload
 // once so the new token gets its own view instead of retaining the old offer.
 window.addEventListener('hashchange',()=>{if(location.hash)location.reload();});
 const $=id=>document.getElementById(id);let offer,busy=false;
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
  for(const [label,value] of [['イベント名',s.event_name],['開催日',s.event_date],['顧客名',s.customer_name],['見積金額（税込）',Number(s.amount).toLocaleString('ja-JP')+'円'],['回答期限（日本時間）',new Date(Date.parse(offer.expires_at)-1).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})]]){
   const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;$('summary').append(dt,dd);
  }
  $('request').textContent=s.request_summary;$('payment').textContent=s.payment_terms;$('confirmer').value=s.confirmer_name;
  // Render only the issued snapshot. Never substitute current terms into an older offer.
  for(const block of s.cancellation_terms.split('\n\n')){
   const p=document.createElement('p');
   if(/^(開催31日前まで|開催30日前～8日前|開催7日前～2日前|前日・当日)\n/.test(block)){
    p.className='cancel-band';const [label,...lines]=block.split('\n');const strong=document.createElement('strong');strong.textContent=label;p.append(strong,document.createTextNode(lines.join('\n')));
   }else{p.className='cancel-note';p.textContent=block;}
   $('cancel').append(p);
  }
  for(const block of s.business_terms.split('\n\n')){const p=document.createElement('p');p.textContent=block;$('business').append(p);}
  $('confirmation').hidden=false;$('status').textContent='';
 }
 $('quote').addEventListener('click',async()=>{
  $('quote').disabled=true;
  try{const blob=await request('quote',{},true);const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=offer.snapshot.quote.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('quote-status').textContent='見積書PDFをダウンロードしました。';}
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
