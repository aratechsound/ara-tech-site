import {privateText,privateMoney,setPrivateAmount,readPrivateAmount} from './pa-workspace-privacy.mjs';
import {createGallery} from './gallery.mjs';
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=privateText(String(text));n.className=cls;return n;};
const btn=(name,fn)=>{const b=el('button',name,'lightbtn');b.type='button';b.addEventListener('click',()=>Promise.resolve(fn()).catch(()=>{}));return b;};
const field=(name,input)=>{const n=el('label',name);input.setAttribute('aria-label',name);n.append(input);return n;};
const select=(name,values)=>{const n=el('select');n.setAttribute('aria-label',name);n.append(new Option('選択してください',''));for(const [value,label]of values)n.append(new Option(label,value));return n;};
const input=(name,type='text')=>{const n=el('input');n.type=type;n.setAttribute('aria-label',name);return n;};
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
async function fileValue(file){if(!file||file.size>1500000)throw Error('PDFは1.5MB以内で選択してください。');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));return {filename:file.name,sha256:await sha(bytes),content_base64:window.btoa(raw)};}
const column=(grid,title)=>{const n=el('section','','change-evidence-column');n.append(el('h3',title));grid.append(n);return n;};
export function mountChangeEvidenceSummary(root,data,open){
 const s=el('section','','change-evidence');s.setAttribute('aria-label','受注後の変更見積・顧客承認証拠');s.append(el('h2','受注後の変更見積・顧客承認証拠'));
 const grid=el('div','','change-evidence-grid'),a=column(grid,'正式受注確認書'),b=column(grid,'変更後の現行合意見積書'),c=column(grid,'変更承認メール');
 const accepted=data.offers.filter(o=>o.state==='accepted');for(const o of accepted)a.append(el('p','正式確認 #'+o.version+' / 同意 '+(o.confirmed_at||'日時未取得')));
 if(!accepted.length)a.append(el('p','正式受注の同意記録は未特定'));
 b.append(el('p','Owner採用記録を取得して確認します。最新revision・最新送信だけでは確定しません。'));c.append(el('p','承認証拠未特定。Gmail原本と対象見積を照合してください。'));
 s.append(grid,btn('変更見積・承認証拠を検索・確認',open));root.append(s);
}
export async function openChangeEvidence({request,dialog,stop,status,facts,valid,getCase,setDirty,setBusy,onChanged,initialCandidate=null,quoteMonitor=null}){
 const d=dialog('変更見積・顧客承認証拠'),s=status(d);let state=null,payload=null,prepared=null,version=0,working=false,presetQuote=null,presetApproval=null;const releases=[];
 const safe=()=>valid()&&d.open;
 const showPdf=(_dialog,blob,title)=>{
  const viewer=createGallery({requestBlob:async()=>blob,isCurrent:safe});
  const release=()=>viewer.dispose();d.addEventListener('close',release,{once:true});
  // Reuse the existing PDF.js viewer: sandboxed browser PDF plugins may show
  // a blank frame. The original has already passed this operation's ACL and
  // identity checks; opening the in-memory Blob performs no further fetch.
  void viewer.openPreview({key:crypto.randomUUID(),asset_id:crypto.randomUUID(),filename:title,mime_type:'application/pdf',size:blob.size});
  return release;
 };
 const error=e=>{s.textContent=privateText(({change_evidence_mismatch:'案件・メール・PDF原本の不一致です。採用できません。',change_evidence_changed:'証拠または採用履歴が変わりました。再照合してください。',change_evidence_storage_unavailable:'証拠台帳は未導入です。読取照合のみ利用できます。',change_evidence_incomplete:'承認証拠・変更内容・Owner確認が不足しています。',invalid_origin:'このテスト環境の操作許可はありません。',case_changed:'案件・認証が切り替わりました。'})[e.message]||'原本照合を完了できません。承認なし・成功とは扱いません。');};
 d.append(el('p',getCase().event_name||getCase().inquiry_number));
 const grid=el('div','','change-evidence-grid'),left=column(grid,'正式受注確認書'),middle=column(grid,'変更後の現行合意見積書'),right=column(grid,'変更承認メール');d.append(grid);
 const contract=select('元の正式受注確認書',[]),quote=select('変更見積の取得元',[]),approval=select('顧客承認メール',[]);
 const amount=input('変更見積金額（円）','number');setPrivateAmount(amount,'');
 const tax=select('変更見積税区分',[['tax_included','税込'],['tax_excluded','税別'],['tax_exempt','非課税']]);tax.value='tax_included';
 const local=input('手動提出の変更見積PDF','file');local.accept='application/pdf,.pdf';
 const copy=input('Gmail取得不能時のメール控えPDF','file');copy.accept='application/pdf,.pdf';
 const issued=input('見積発行日','date'),description=el('textarea'),reason=el('textarea');description.maxLength=5000;reason.maxLength=2000;
 const confirmed=input('元契約・変更見積・顧客承認を確認し採用します','checkbox'),relation=input('不足証拠・別thread・顧客と案件の対応を確認しました','checkbox');
 left.append(field('元の正式受注確認書',contract));middle.append(field('変更見積の取得元',quote),field('手動提出の変更見積PDF',local),field('見積発行日',issued),field('変更見積金額（円）',amount),field('変更見積税区分',tax));right.append(field('顧客承認メール',approval),field('Gmail取得不能時のメール控えPDF',copy));
 const search=el('details');search.append(el('summary','メールを手動検索・別threadを指定'));
 const sender=input('送信者メールアドレス'),after=input('受信日時・開始','date'),before=input('受信日時・終了','date'),subject=input('件名'),keywords=input('キーワード'),messageId=input('Gmail Message-IDを直接指定'),threadId=input('Gmail thread IDを直接指定');
 for(const [name,node]of [['送信者メールアドレス',sender],['受信日時・開始',after],['受信日時・終了',before],['件名',subject],['キーワード',keywords],['Gmail Message-IDを直接指定',messageId],['Gmail thread IDを直接指定',threadId]])search.append(field(name,node));
 const review=el('section'),history=el('details');history.append(el('summary','変更・見積発行・Gmail送信済み履歴'));d.append(search,field('変更内容',description),field('Owner採用・訂正理由と根拠',reason),field('不足証拠・別thread・顧客と案件の対応を確認しました',relation),field('元契約・変更見積・顧客承認を確認し採用します',confirmed));
 const invalidate=()=>{version++;payload=null;prepared=null;review.replaceChildren();for(const n of d.querySelectorAll('[data-selected-evidence],iframe'))n.remove();for(const release of releases.splice(0))release();setDirty(true);save.disabled=true;adopt.disabled=true;};
 for(const node of [contract,quote,approval,local,copy,amount,tax,issued,description,reason,relation,confirmed,messageId,threadId])node.addEventListener('input',invalidate);
 async function load(filters,detect=false){
  state=await request('change_evidence_candidates',{...(filters?{search:filters}:{}),detect});if(!safe())return;
  contract.replaceChildren(new Option('選択してください',''));for(const c of state.contracts)contract.append(new Option('正式確認 #'+c.version+' / '+c.confirmed_at,c.id));if(state.contracts.length===1)contract.value=state.contracts[0].id;
  quote.replaceChildren(new Option('選択してください',''));for(const e of state.estimates)quote.append(new Option('登録見積 第'+e.revision_number+'版 / '+(state.documents.find(x=>x.id===e.document_id)?.original_filename||e.id),'registered:'+e.id));
  for(const m of state.messages.filter(m=>m.direction==='outbound'))for(const a of m.attachment_metadata||[])if(a.mime_type==='application/pdf')quote.append(new Option('送信済み '+(a.original_filename||a.filename)+' / '+m.sent_at,'gmail:'+m.gmail_message_id+':'+a.id));quote.append(new Option('OwnerローカルPDF','local'));
  approval.replaceChildren(new Option('承認証拠未特定',''));for(const m of state.messages.filter(m=>m.direction==='inbound'))approval.append(new Option((m.received_at||'日時未取得')+' / '+m.subject,m.gmail_message_id));approval.append(new Option('Gmail Message-IDを直接指定','direct'),new Option('手動メール控えPDF（Gmail原本未確認）','manual_pdf'));
  history.replaceChildren(el('summary','変更・見積発行・Gmail送信済み履歴'));
  const existing=middle.querySelector('[data-current-agreement]');if(existing)existing.remove();if(state.current_agreement){const e=state.current_agreement,n=el('section');n.dataset.currentAgreement='';facts(n,[['採用状態','Owner採用済み・現行合意見積'],['見積',e.evidence.quote.filename],['金額',privateMoney(e.evidence.quote.amount_minor)],['SHA256',e.evidence.quote.sha256],['採用日時',e.created_at]]);middle.append(n);}
  for(const e of state.history){history.append(el('p',e.event_kind+' / '+e.created_at+' / '+e.reason));if(e.id===state.current_agreement?.id){const cur=el('p','Owner採用済み・現行合意見積 / '+e.evidence.quote.filename+' / '+privateMoney(e.evidence.quote.amount_minor));history.append(cur,btn('現行採用を取り消す・監査を残す',async()=>{
    if(working||!safe()||!reason.value.trim())return;working=true;setBusy(true);try{await request('change_evidence_append',{event_kind:'revoked',operation_id:crypto.randomUUID(),contract_id:e.contract_id,previous_event_id:state.history[0].id,reason:reason.value});if(safe()){setDirty(false);await load();}}catch(err){error(err);}finally{working=false;setBusy(false);}
   }));}}
  for(const e of state.estimates)history.append(el('p','登録revision '+e.revision_number+' / '+e.issued_at+' / '+privateMoney(e.amount_minor)+'（現行合意の判定とは別）'));
  for(const m of state.messages.filter(m=>m.direction==='outbound'))history.append(el('p','Gmail送信済み候補 / '+m.sent_at+' / '+m.subject));
  s.textContent=state.search_state==='search_unavailable'?'メール検索失敗。承認証拠の有無は未確認です。':state.candidate_state==='multiple_candidates'?'候補複数。自動的に1件へ絞りません。':'承認証拠未特定。原本を選んで照合してください。';
  if(!state.storage_available)s.textContent+=' 証拠台帳は未導入です。保存・採用はできません。';
  const oldFacts=left.querySelector('[data-contract-facts]');if(oldFacts)oldFacts.remove();const selectedContract=state.contracts.find(c=>c.id===contract.value);if(selectedContract){const n=el('section');n.dataset.contractFacts='';facts(n,[['契約identity',selectedContract.id],['顧客同意日時',selectedContract.confirmed_at],['正式受注時の見積',selectedContract.snapshot.estimate?.estimate_id||selectedContract.snapshot.quote?.sha256||'保存snapshot参照'],['取消・支払条件の同意',JSON.stringify(selectedContract.snapshot.explicit_consent||{})]]);left.append(n);}
  const old=d.querySelector('[data-detected-evidence]');if(old)old.remove();
  if(detect){const results=el('section');results.dataset.detectedEvidence='';results.append(el('p',state.detection_state==='incomplete'?'自動照合の一部原本を取得できません。承認証拠の有無は未確認です。':state.detected.length>1?'3点セット候補複数。選択して確認してください。':state.detected.length?'3点セット候補を検出しました。採用前に確認してください。':'承認証拠未特定。手動検索・選択を利用してください。'));
   for(const item of state.detected)results.append(btn('検出候補を選択: '+item.quote.filename+' / '+item.approval.message_id,()=>{invalidate();contract.value=item.contract_id;quote.value='gmail:'+item.quote.message_id+':'+item.quote.attachment_id;approval.value=item.approval.message_id;setPrivateAmount(amount,item.quote.amount_minor);tax.value=item.quote.tax_basis;}));d.append(results);}
 }
 search.append(btn('条件を指定してGmailを検索',async()=>{try{invalidate();await load({sender:sender.value,after:after.value,before:before.value,subject:subject.value,keywords:keywords.value});}catch(e){error(e);}}));
 async function build(){
  let q;const value=quote.value;
  if(value==='local')q={source:'local',...(local.files?.[0]?await fileValue(local.files[0]):presetQuote||await fileValue(null))};
  else if(value.startsWith('registered:'))q={source:'registered',estimate_id:value.slice(11)};
  else if(value.startsWith('gmail:')){const m=state.messages.find(m=>value.startsWith('gmail:'+m.gmail_message_id+':'));if(!m)throw Error('change_evidence_mismatch');const a=m.attachment_metadata.find(a=>value==='gmail:'+m.gmail_message_id+':'+a.id);q={source:'gmail',message_id:m.gmail_message_id,thread_id:m.gmail_thread_id,attachment_id:a.id,part_id:a.part_id||''};}
  else throw Error('invalid_change_evidence');
  const e=state.estimates.find(e=>e.id===q.estimate_id);q.amount_minor=Number(readPrivateAmount(amount)||e?.amount_minor);q.tax_basis=tax.value;q.issued_at=issued.value||null;
  let a={source:'missing'};if(approval.value==='manual_pdf')a={source:'manual_pdf',...(copy.files?.[0]?await fileValue(copy.files[0]):presetApproval||await fileValue(null))};
  else if(approval.value){const m=state.messages.find(m=>m.gmail_message_id===approval.value);a={source:'gmail',message_id:m?.gmail_message_id||messageId.value,thread_id:m?.gmail_thread_id||threadId.value};}
  return {contract_id:contract.value,quote:q,approval:a,change_description:description.value,reason:reason.value,owner_confirmed:confirmed.checked,owner_case_relation_confirmed:relation.checked};
 }
 const inspect=btn('3点の原本を照合（保存しない）',async()=>{if(working)return;working=true;setBusy(true);inspect.disabled=true;payload=null;prepared=null;save.disabled=true;adopt.disabled=true;const v=version;
  try{const draft=await build(),model=await request('change_evidence_preview',draft);if(!safe()||v!==version)return;payload=draft;prepared=model;review.replaceChildren();
   const e=model.evidence;facts(review,[['元契約identity',e.contract_id],['元契約snapshot SHA256',e.contract_sha256],['不足・警告',e.warnings.join(' / ')||'なし']]);
   for(const node of d.querySelectorAll('[data-selected-evidence]'))node.remove();const qm=el('section'),am=el('section');qm.dataset.selectedEvidence='';am.dataset.selectedEvidence='';
   facts(qm,[['採用状態','変更見積候補・未採用'],['変更見積',e.quote.filename],['登録revision',e.quote.revision_number||'未登録（ファイル名の改訂番号とは別）'],['金額',privateMoney(e.quote.amount_minor)],['原本SHA256',e.quote.sha256],['原本同一性',e.quote.registered_sha_match?'登録済み原本と一致':'同一登録原本は未特定'],['発行日',e.quote.issued_at||'未確認'],['送信日時',e.quote.sent_at||'未確認']]);middle.append(qm);
   facts(am,[['承認確認',model.status],['送信者',e.approval.from||'手動証拠'],['件名',e.approval.subject||'Gmail原本未確認'],['日時',e.approval.occurred_at||'未確認'],['Gmail Message-ID',e.approval.message_id||'Gmail原本未確認'],['対象見積との対応',e.approval.exact_quote_reference?'RFC返信参照一致':'要Owner確認']]);
   am.append(el('h4','顧客返信部分（原文）'),el('pre',e.approval.reply_body||e.approval.body||'証拠不足'),el('h4','過去の引用部分（原文）'),el('pre',e.approval.quoted_body||'引用境界未特定'));right.append(am);
   if(e.approval.message_id){const link=el('a','Gmail原本を開く');link.href='https://mail.google.com/mail/u/0/#all/'+e.approval.thread_id;link.target='_blank';link.rel='noopener noreferrer';review.append(link);}
   save.disabled=!model.storage_available||!reason.value.trim();adopt.disabled=!model.storage_available||!model.can_adopt;s.textContent='原本照合のみ完了。保存・採用・送信は行っていません。';
  }catch(e){error(e);}finally{working=false;setBusy(false);inspect.disabled=false;}
 });
 const save=btn('証拠候補を保存（採用しない）',()=>commit('saved')),adopt=btn('確認済みの3点を現行合意見積へ採用',()=>commit('adopted'));save.disabled=true;adopt.disabled=true;
 async function commit(kind){if(working||!payload||!prepared||!safe())return;working=true;setBusy(true);save.disabled=true;adopt.disabled=true;
  try{const evidenceSha=await sha(new window.TextEncoder().encode(canonical(prepared.evidence)));await request('change_evidence_append',{...payload,event_kind:kind,operation_id:crypto.randomUUID(),fingerprint:prepared.fingerprint,previous_event_id:prepared.previous_event_id,evidence_sha256:evidenceSha});if(safe()){setDirty(false);prepared=null;payload=null;review.replaceChildren();await load();await onChanged();}}
  catch(e){error(e);}finally{working=false;setBusy(false);}
 }
 left.append(btn('元の正式受注確認PDFを表示',async()=>{try{const selected=contract.value,blob=await request('change_evidence_contract_pdf',{contract_id:selected},true);if(safe()&&contract.value===selected)releases.push(showPdf(d,blob,'元の正式受注確認書',left));}catch(e){error(e);}}));
 contract.addEventListener('change',()=>{const c=state?.contracts.find(c=>c.id===contract.value);const old=left.querySelector('[data-contract-facts]');if(old)old.remove();if(c){const n=el('section');n.dataset.contractFacts='';facts(n,[['契約identity',c.id],['同意日時',c.confirmed_at],['当初見積',c.snapshot.estimate?.estimate_id||c.snapshot.quote?.sha256||'snapshot参照'],['取消条件等への同意',JSON.stringify(c.snapshot.explicit_consent||{})]]);left.append(n);}});
 d.append(btn('既存メールから3点セット候補を自動検出',async()=>{try{invalidate();await load(null,true);}catch(e){error(e);}}),inspect,btn('選択見積PDFを表示',async()=>{try{const v=version,draft=await build(),blob=await request('change_evidence_document',draft,true);if(safe()&&v===version)releases.push(showPdf(d,blob,'変更見積PDF原本',review));}catch(e){error(e);}}),btn('承認メール控えPDFを表示・取得',async()=>{try{const v=version,draft=await build(),blob=await request('change_evidence_mail_pdf',draft,true);if(safe()&&v===version){releases.push(showPdf(d,blob,'Gmail原本の閲覧用写し',review));const url=URL.createObjectURL(blob),a=el('a','メール控えPDFを保存');a.href=url;a.download='change-approval-email-copy.pdf';review.append(a);releases.push(()=>URL.revokeObjectURL(url));}}catch(e){error(e);}}),save,adopt,review,history);
 local.addEventListener('change',()=>{presetQuote=null;});copy.addEventListener('change',()=>{presetApproval=null;});quote.addEventListener('change',()=>{presetQuote=null;});approval.addEventListener('change',()=>{presetApproval=null;});
 d.addEventListener('close',()=>{for(const release of releases.splice(0))release();},{once:true});stop(d);d.showModal();try{
  await load();
  if(initialCandidate&&safe()){
   const c=initialCandidate,e=c.evidence;if(c.case_id!==getCase().id||e.case_id!==getCase().id||!state.contracts.some(v=>v.id===e.contract_id))throw Error('change_evidence_mismatch');
   contract.value=e.contract_id;setPrivateAmount(amount,e.quote.amount_minor||'');tax.value=e.quote.tax_basis;issued.value=(e.quote.issued_at||'').slice(0,10);
   if(e.quote.source==='gmail'){
    const m=state.messages.find(m=>m.gmail_message_id===e.quote.message_id&&m.gmail_thread_id===e.quote.thread_id),a=m?.attachment_metadata?.find(a=>e.quote.part_id?a.part_id===e.quote.part_id:a.id===e.quote.attachment_id);
    if(!a)throw Error('change_evidence_changed');quote.value='gmail:'+e.quote.message_id+':'+a.id;
   }else if(e.quote.source==='registered')quote.value='registered:'+e.quote.estimate_id;
   else{
    if(!quoteMonitor)throw Error('change_evidence_changed');const blob=await quoteMonitor.document(getCase().id,c);if(!safe())return;
    presetQuote=await fileValue(new File([blob],e.quote.filename,{type:'application/pdf'}));if(presetQuote.sha256!==e.quote.sha256)throw Error('change_evidence_mismatch');quote.value='local';
   }
   if(e.approval?.source==='gmail'){
    if(state.messages.some(m=>m.gmail_message_id===e.approval.message_id))approval.value=e.approval.message_id;
    else{approval.value='direct';messageId.value=e.approval.message_id;threadId.value=e.approval.thread_id;}
   }else if(e.approval?.source==='manual_pdf'&&quoteMonitor){
    const blob=await quoteMonitor.document(getCase().id,c,'approval');if(!safe())return;presetApproval=await fileValue(new File([blob],e.approval.filename||'manual-approval.pdf',{type:'application/pdf'}));if(presetApproval.sha256!==e.approval.manual_pdf_sha256)throw Error('change_evidence_mismatch');approval.value='manual_pdf';
   }
   description.value=e.change_description||'';confirmed.checked=false;relation.checked=false;s.textContent='候補を選択しました。元契約・見積原本・金額・税区分・顧客承認を再照合し、最終確認してから採用してください。';
  }
 }catch(e){error(e);}
}
