export const caseTypes = Object.freeze({ PA_EVENT:'PA・イベント音響', AUDIO_INSTALL:'音響設備施工', AV_INSTALL:'AV設備施工', LIGHTING_INSTALL:'照明設備施工', VIDEO_INSTALL:'映像設備施工', EQUIPMENT_RENTAL:'機材レンタル', OTHER:'その他' });
export const isPaCase = row => Boolean(row && (!Object.hasOwn(row,'case_type') || row.case_type === 'PA_EVENT'));
export const caseTypeLabel = row => caseTypes[row?.case_type] || '未分類';
export const matchesCaseType = (row, filter) => !filter || (filter === 'INSTALL' ? String(row?.case_type || '').endsWith('_INSTALL') : row?.case_type === filter);
export function setupUnlinkedMail({ callApi, loadCases, openCase, getCases, downloadAttachment }) {
 const $ = id => document.getElementById(id);
 let candidates = [], requestSerial = 0, nextCursor=null, total=0, displayed=0;
 const status = $('unlinked-mail-status');
 const render = () => {
  $('unlinked-mail-count').textContent = `未紐付けメール ${total}件（表示 ${candidates.length}件／前 ${displayed}件）`;
  const list = $('unlinked-mail-list'); list.replaceChildren();
  for (const mail of candidates) {
   const card = document.createElement('article'); card.className = 'subsection';
   const header = document.createElement('strong'); header.textContent = mail.subject || '件名なし';
   const meta = document.createElement('p'); meta.textContent = `${mail.received_at} ／ ${mail.from_address} ／ ${mail.has_attachments ? '添付あり' : '添付なし'} ／ 未紐付け`;
   const body = document.createElement('p'); body.textContent = mail.snippet;
   const name = document.createElement('input'); name.placeholder='顧客名（Owner確認）'; name.maxLength=160;
   const email = document.createElement('input'); email.type='email'; email.placeholder='顧客メール（Owner確認）'; email.maxLength=320;
   const type = document.createElement('select');
   type.add(new Option('種別を選択してください',''));
   for(const [value,label] of Object.entries(caseTypes)) type.add(new Option(label,value));
   const existing = document.createElement('select'); existing.add(new Option('追加先案件を選択',''));
   for (const c of getCases()) existing.add(new Option(`${c.inquiry_number} ／ ${c.customer_name} ／ ${c.case_subject || c.event_name || ''}`,c.id));
   let reviewed=false;
   const review=document.createElement('button');review.type='button';review.className='button button--secondary button--small';review.textContent='本文・添付を確認';
   const full=document.createElement('div');
   review.addEventListener('click',async()=>{
    review.disabled=true;
    try{
     const r=await callApi({action:'inbox_review',gmail_message_id:mail.gmail_message_id});if(!card.isConnected)return;
     full.replaceChildren();const headers=document.createElement('p');headers.textContent=`From: ${r.result.from_address} / Reply-To: ${r.result.reply_to||'なし'}。通知元と顧客本人を区別し、顧客メールをOwnerが確認してください。`;
     const text=document.createElement('pre');text.textContent=r.result.body_text||r.result.body||'';full.append(headers,text);
     for(const a of r.result.attachments){const b=document.createElement('button');b.type='button';b.textContent=`添付を保存：${a.filename}`;b.addEventListener('click',async()=>{try{await downloadAttachment({action:'inbox_attachment',gmail_message_id:mail.gmail_message_id,gmail_attachment_id:a.gmail_attachment_id});}catch{status.textContent='添付を取得できませんでした。';}});full.append(b);}
     reviewed=true;review.textContent='本文・添付情報を確認済み（顧客と種別を選択）';
    }catch{if(card.isConnected)status.textContent='本文を取得できませんでした。登録せず再確認してください。';}
    finally{review.disabled=false;}
   });
   card.append(header,meta,body,review,full,name,email,type,existing);
   const controls = [];
   for(const [decision,label] of [['create','新規案件として登録'],['link','既存案件へ追加'],['exclude','対象外']]) {
    const button=document.createElement('button'); button.type='button'; button.className='button button--secondary button--small'; button.textContent=label; controls.push(button);
    button.addEventListener('click',async()=>{
     if(decision!=='exclude' && !reviewed){status.textContent='案件化前に本文・添付情報を確認してください。';return;}
     if(decision==='create' && (!type.value || !name.value.trim() || !email.checkValidity() || !email.value.trim())) { status.textContent='顧客名・顧客メール・種別を確認してください。'; return; }
     if(decision==='link' && !existing.value) { status.textContent='追加先案件を選択してください。'; return; }
     if(!window.confirm(`${label}：${mail.subject}。対象thread全体と選択内容を確認しましたか？`)) return;
     controls.forEach(b=>b.disabled=true);
     try {
      const r=await callApi({action:'inbox_decide',gmail_message_id:mail.gmail_message_id,decision,inquiry_id:existing.value,customer_name:name.value.trim(),customer_email:email.value.trim(),case_type:type.value});
      await refresh(false); await loadCases(); if(r.result?.inquiry_id) await openCase(r.result.inquiry_id);
     } catch { status.textContent='操作を完了できませんでした。競合または権限を確認してください。'; }
     finally { controls.forEach(b=>b.disabled=false); }
    }); card.append(button);
   }
   list.append(card);
  }
  if(nextCursor){const more=document.createElement('button');more.type='button';more.id='unlinked-next-page';more.textContent='次の100件を表示';more.className='button button--secondary';more.addEventListener('click',()=>refresh(false,nextCursor));list.append(more);}
  if(displayed){const first=document.createElement('button');first.type='button';first.textContent='先頭へ戻る';first.className='button button--secondary';first.addEventListener('click',()=>refresh(false));list.append(first);}
 };
 async function refresh(sync=true,cursor=null) {
  const serial=++requestSerial; $('sync-unlinked-mail').disabled=true;
  status.textContent=sync?'Gmailを同期中です…':'保存済み候補を読み込んでいます…';
  try {
   const r=await callApi({action:sync?'inbox_sync':'inbox_list',...(cursor?{cursor}:{})}); if(serial!==requestSerial) return;
   displayed=cursor?displayed+candidates.length:0;candidates=r.result?.candidates || r.candidates || [];nextCursor=r.result?.next_cursor||null;total=r.result?.total??candidates.length;render();
   if(sync) $('unlinked-last-sync').textContent=`取得完了範囲：${r.result.covered_until} ／ 最終成功page：${r.result.last_successful_page_at}`;
   status.textContent=r.result?.has_more?'続きがあります。「Gmailを同期」で次のページを取得します。':'保存済み候補を表示しています。';
  } catch { if(serial===requestSerial) status.textContent='メール同期／取得に失敗しました。保存済み一覧と最終成功時刻を維持しています。'; }
  finally { if(serial===requestSerial) $('sync-unlinked-mail').disabled=false; }
 }
 $('sync-unlinked-mail').addEventListener('click',()=>refresh());
 return { refresh };
}
