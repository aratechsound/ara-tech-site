let active=null,epoch=0;
const errors={quote_case_mismatch:'この案件のお客様に送付済みの見積PDFを選択してください。',quote_identity_mismatch:'見積書が一致しません。PDFを選び直してください。',invalid_pdf:'PDFが壊れているか、対応範囲（1.5 MB・30ページ以内）を超えています。',unsafe_pdf:'フォーム・注釈・署名・動作を含むPDFは結合できません。固定ページの最終見積をご用意ください。',recipient_changed:'契約時のお客様と現在のGmail返信先が異なります。連携先をご確認ください。',invalid_contract:'入力内容と必須項目をご確認ください。',delivery_in_progress:'送信結果を確認中です。10分以上経過しても変わらない場合は、Gmailの送信済みを確認してください。',resend_ack_required:'再送前にGmailの送信済みと重複送信の可能性をご確認ください。',case_changed:'案件内容が更新されています。案件を開き直してください。'};
Object.assign(errors,{invalid_payment_date:'別の支払条件には、開催日以降の承認済み支払期限日を指定してください。',payment_calendar_unavailable:'対象年の銀行休業日カレンダーが未対応です。管理者による更新後に発行してください。',related_document_invalid:'関連資料の案件・選択・一致をご確認ください。最終見積との重複、同一資料の重複、6件以上は選べません。',related_documents_too_large:'関連資料のPDFは合計1.5 MB以内で選択してください。'});
export function renderContractPanel(context){
 Object.assign(errors,{related_index_unavailable:'関連資料の案件索引を読み取れません。',related_link_unavailable:'関連資料の案件とGmail会話の紐付けを読み取れません。',related_gmail_not_found:'関連資料がGmailの現在の添付情報と一致しません。同期後に選び直してください。',related_gmail_unavailable:'関連資料をGmailから取得できません。読取接続をご確認ください。',related_pdf_unavailable:'関連PDFの構造を検証できません。固定ページのPDFをご確認ください。'});
 const root=document.getElementById('formal-contract-panel');if(!root)return;
 if(!context.case){active=null;epoch++;root.replaceChildren();root.hidden=true;return;}
 if(active?.id===context.case.id&&active.caseRef===context.case&&active.progressRef===context.progress)return;
 active={id:context.case.id,caseRef:context.case,progressRef:context.progress};const current=++epoch,caseId=context.case.id;root.hidden=false;
 const valid=()=>current===epoch&&context.getCurrentCase()?.id===caseId;
 // Static markup only. Every case, PDF and server value below uses textContent.
 root.innerHTML=`<h3>正式受注・契約控え</h3><p data-c="state" role="status">読み込み中…</p><p data-c="next"></p><p data-c="meta"></p><p data-c="message" role="status"></p><div class="actions"><button type="button" data-c="reload" class="button button--secondary">状態を更新</button><button type="button" data-c="start" class="button">正式受注確認を開始</button></div>
 <form data-c="form" hidden><p>お客様へ提示した最終見積PDFを明示的に指定してください。重要条件を変更する場合は新versionの確認URLを発行します。</p><div class="field"><label>最終見積PDF（案件の送付済み添付）<select data-c="quotes" required><option value="">選択してください</option></select></label></div><div class="actions"><button type="button" data-c="inspect" class="button button--secondary">選択したPDFを確認</button></div><p data-c="identity" class="small-note"></p>
 <div class="field"><label>契約上の顧客名<input data-c="customer" maxlength="400" required></label></div><div class="field"><label>税込契約金額（円）<input data-c="amount" type="number" min="1" max="999999999" step="1" required></label></div><div class="field"><label>依頼内容<textarea data-c="request" maxlength="10000" required></textarea></label></div><div class="field"><label>承認する別の支払条件（標準は終了後14日以内）<textarea data-c="payment" maxlength="2000"></textarea></label><label><input data-c="payment-approved" type="checkbox">別の支払条件をARA-TECHとして承認する</label></div><p>公開サイトの支払期間・キャンセル日程・雨天条件には今回の条件と差があります。今回の個別条件を確認して発行してください。</p><button data-c="issue" class="button" type="submit" disabled>この条件で確認URLを発行</button></form>
 <div data-c="issued" hidden><label>顧客向け確認URL<input data-c="url" readonly></label><p>URLはこの画面でのみ表示します。新規発行・再発行後の旧URLは利用できません。メールは自動送信されません。</p></div><div data-c="history"></div><div data-c="mail" hidden><h4>契約控えの送信前確認</h4><pre data-c="preview"></pre><label><input type="checkbox" data-c="ack">送信済みを確認し、再送による重複の可能性を了承する</label><button type="button" data-c="send" class="button">確認した宛先へ契約控えを送信</button></div>`;
 const $=key=>root.querySelector(`[data-c="${key}"]`);let quotes=[],selected=null,mailPreview=null,issuing=false,related=[],relatedEpoch=0,conditionsEpoch=0,conditionsVerified=false;
 const relatedPanel=document.createElement('fieldset');relatedPanel.innerHTML='<legend>関連資料（任意・最大5件／合計1.5 MB）</legend><p>最終見積書とは別の参考資料です。金額根拠資料にはなりません。表示するPDFだけを明示選択してください。</p><div data-c="related"></div><button type="button" data-c="inspect-related" class="button button--secondary">選択した関連資料を照合</button><p data-c="related-status" role="status"></p>';
 $('identity').after(relatedPanel);
 const conditionsPanel=document.createElement('div');conditionsPanel.innerHTML='<div class="field"><label>承認済みの支払期限日（別の支払条件を承認する場合のみ）<input type="date" data-c="payment-date"></label></div><button type="button" data-c="conditions" class="button button--secondary">発行する条件を確認（URLは発行しません）</button><pre data-c="conditions-preview" class="mail-preview__body"></pre>';
 $('issue').before(conditionsPanel);
 const paymentInput=()=>({custom_payment:$('payment').value,payment_approved:$('payment-approved').checked,approved_payment_date:$('payment-date').value});
 const updateReady=()=>{$('issue').disabled=issuing||!selected||!conditionsVerified||related.some(d=>d.check.checked&&!d.identity);};
 const invalidateConditions=()=>{conditionsEpoch++;conditionsVerified=false;$('conditions-preview').textContent='';updateReady();};
 for(const key of ['payment','payment-approved','payment-date'])$(key).addEventListener('input',invalidateConditions);
 const error=e=>{if(valid())$('message').textContent=errors[e.message]||'操作を完了できません。状態を更新して確認してください。';};
 const access=async()=>{const token=await context.getAccessToken();if(!valid())throw Error('case_changed');return token;};
 const api=async(action,extra={},binary=false)=>{
  if(!valid())throw Error('case_changed');const token=await access();
  const r=await fetch('/api/pa-contract',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action,case_id:caseId,...extra}),cache:'no-store'});
  if(binary&&r.ok)return r.blob();const data=await r.json();if(!r.ok||!data.ok)throw Error(data.code);return data.result;
 };
 const download=(blob,name)=>{if(!valid())return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='button button--secondary button--small';b.textContent=label;b.addEventListener('click',async()=>{if(!valid())return;b.disabled=true;try{await fn();}catch(e){error(e);}finally{b.disabled=false;}});return b;};
 async function refresh(){
  const data=await api('list');if(!valid())return;
  quotes=data.quotes;selected=null;$('issue').disabled=true;$('identity').textContent='';$('quotes').replaceChildren(new Option('選択してください',''));
  quotes.forEach((q,i)=>$('quotes').append(new Option(`${q.filename} / ${q.sent_at||''}`,String(i))));
  relatedEpoch++;related=[];$('related').replaceChildren();$('related-status').textContent='';invalidateConditions();
  for(const candidate of data.related_candidates||[]){
   const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';
   const entry={candidate,check,identity:null};related.push(entry);label.append(check,document.createTextNode(` ${candidate.filename} ／ ${candidate.direction==='outbound'?'送信済み':'受信'} ／ ${candidate.sent_at||''}`));
   const row=document.createElement('div');row.append(label);$('related').append(row);
   check.onchange=()=>{relatedEpoch++;entry.identity=null;$('related-status').textContent='選択変更後は関連資料を照合してください。';updateReady();};
  }
  if(!related.length)$('related-status').textContent='この案件に紐づく関連PDF候補はありません。関連資料なしで発行できます。';
  const last=data.history.find(h=>h.state==='accepted'),pending=data.history.find(h=>h.state==='active');
  const sent=last?.delivery?.status==='sent';
  $('state').textContent=last?`正式受注済み（v${last.version}）／${sent?'控え送信済み':'契約成立済み／控え送信未完了'}`:pending?'正式受注確認：お客様の回答待ち':'正式受注確認：未成立';
  $('next').textContent='次に行うこと：'+(pending?`v${pending.version}の回答待ち。`:'')+(last?!last.receipt?'契約控えPDFを生成してください。':!sent?'控えを確認してメール送信してください。':'イベント準備を進めてください。':pending?'':'最終見積PDFと契約条件を確認し、URLを発行してください。');
  const unfinished=[pending?'新versionの回答確認':'',last&&!last.receipt?'PDF生成':'',last&&!sent?'控え送信':'',!last?'正式受注確認':''].filter(Boolean);
  $('meta').textContent=`イベント日：${last?.snapshot.event_date||context.case.event_date||'未設定'} ／ 契約金額：${last?Number(last.snapshot.amount).toLocaleString('ja-JP')+'円（税込）':'未確定'} ／ 未完了：${unfinished.join('・')||'なし'}`;
  $('history').replaceChildren();
  for(const h of data.history){
   const card=document.createElement('div');card.className='action-panel';
   const p=document.createElement('p');p.textContent=`v${h.version} / ${{active:'回答待ち',expired:'期限切れ',revoked:'失効',accepted:'回答受付済み'}[h.state]||'確認必要'} / ${h.snapshot.quote.filename}`;card.append(p);
   if(h.state==='accepted'){
    card.append(button(h.receipt?'契約控えPDFをダウンロード':'契約控えPDFを生成',async()=>{download(await api('receipt',{contract_id:h.id},true),`契約控え-v${h.version}.pdf`);await refresh();}));
    card.append(button('控え送信・再送のプレビュー',async()=>{const preview=await api('mail_preview',{contract_id:h.id});if(!valid())return;mailPreview={id:h.id,preview,attempt:crypto.randomUUID()};$('preview').textContent=`To: ${preview.recipient}\n件名: ${preview.subject}\n\n${preview.body}\n\n添付: ${preview.attachments.map(a=>a.filename).join(', ')}`;$('ack').checked=false;$('mail').hidden=false;}));
    const mail=document.createElement('p');mail.textContent='控え送信：'+({sent:'送信済み',failed:'失敗（再送可能）',uncertain:'結果不明（Gmailの送信済みを確認）',sending:'処理中・結果確認中'}[h.delivery?.status]||'未送信');card.append(mail);
    if(h.delivery?.status==='sending'&&Date.now()-Date.parse(h.delivery.created_at)>600000)card.append(button('結果不明として再送確認へ進む',async()=>{await api('mark_uncertain',{contract_id:h.id});await refresh();}));
   }
   $('history').append(card);
  }
 }
 $('customer').value=[context.case.organization_name,context.case.customer_name].filter(Boolean).join(' ');
 $('amount').value=context.progress?.estimate_amount||'';$('request').value=context.case.public_request_summary||context.case.request_summary||'';
 $('start').onclick=()=>{$('form').hidden=!$('form').hidden;};
 $('reload').onclick=()=>refresh().catch(error);
 $('quotes').onchange=()=>{selected=null;$('issue').disabled=true;$('identity').textContent='';};
 $('conditions').onclick=async()=>{
  const captured=conditionsEpoch;$('conditions').disabled=true;conditionsVerified=false;updateReady();
  try{const result=await api('preview_conditions',paymentInput());if(!valid()||captured!==conditionsEpoch)return;$('conditions-preview').textContent=result.terms_text;conditionsVerified=true;updateReady();}
  catch(e){error(e);}finally{$('conditions').disabled=false;}
 };
 $('inspect-related').onclick=async()=>{
  const chosen=related.filter(d=>d.check.checked),captured=relatedEpoch;$('inspect-related').disabled=true;
  try{
   if(chosen.length>5)throw Error('related_document_invalid');
   let size=0;const verified=[];
   for(const d of chosen){const result=await api('inspect_related',d.candidate);if(!valid()||captured!==relatedEpoch)return;size+=result.identity.size;verified.push({entry:d,identity:result.identity});}
   if(size>1500000)throw Error('related_documents_too_large');
   for(const d of verified)d.entry.identity=d.identity;
   $('related-status').textContent=verified.length?verified.map(d=>`${d.identity.filename} ／ SHA-256 ${d.identity.sha256}`).join('\n'):'関連資料なし';$('message').textContent=verified.length?'選択した関連資料の一致を確認しました。発行済みURLは変更していません。':'関連資料なしで確認しました。';updateReady();
  }catch(e){error(e);}finally{$('inspect-related').disabled=false;}
 };
 $('inspect').onclick=async()=>{
  const index=$('quotes').value,q=quotes[Number(index)];if(index===''||!q)return;
  $('inspect').disabled=true;selected=null;$('issue').disabled=true;
  try{
   const r=await api('inspect_quote',q);if(!valid()||$('quotes').value!==index)return;
   const token=await access();
   const response=await fetch('/api/pa-gmail',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'attachment_download',inquiry_id:caseId,gmail_message_id:q.gmail_message_id,gmail_attachment_id:q.gmail_attachment_id})});
   if(!response.ok)throw Error('quote_missing');
   const blob=await response.blob();const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
   if(hash!==r.identity.sha256)throw Error('quote_identity_mismatch');
   if(!valid()||$('quotes').value!==index)return;selected={...q,quote_sha256:hash};
   download(blob,r.identity.filename);$('identity').textContent=`確認対象：${r.identity.filename} / SHA-256 ${hash}`;$('message').textContent='PDFの一致を確認しました。';updateReady();
  }catch(e){error(e);}finally{$('inspect').disabled=false;}
 };
 $('form').onsubmit=async e=>{
  e.preventDefault();if(!selected||!valid()||issuing||!conditionsVerified||related.some(d=>d.check.checked&&!d.identity))return;issuing=true;updateReady();
  try{const result=await api('issue',{...selected,customer_name:$('customer').value,amount:$('amount').value,request_summary:$('request').value,...paymentInput(),related_documents:related.filter(d=>d.check.checked).map(d=>d.identity)});if(!valid())return;$('url').value=result.url;$('issued').hidden=false;$('form').hidden=true;$('message').textContent='確認URLを発行しました。以前の未回答URLは失効しました。メールは送信していません。';await refresh();}
  catch(e){error(e);}
  finally{issuing=false;if(valid())updateReady();}
 };
 $('send').onclick=async()=>{
  if(!valid()||!mailPreview)return;const captured=mailPreview;$('send').disabled=true;
  try{const result=await api('send',{contract_id:captured.id,confirmation_token:captured.preview.confirmation_token,attempt_id:captured.attempt,acknowledge_resend:$('ack').checked});if(!valid())return;$('message').textContent=result.delivery_status==='sent'?'契約控えを送信しました。':'契約は成立済みです。控えの送信結果をご確認ください。';mailPreview=null;$('mail').hidden=true;await refresh();}
  catch(e){error(e);if(valid()){mailPreview=null;$('mail').hidden=true;await refresh().catch(error);}}
  finally{$('send').disabled=false;}
 };
 refresh().catch(error);
}
