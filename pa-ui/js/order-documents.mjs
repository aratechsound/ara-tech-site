export {resolveOrderDocuments,resolveMonitoredOrderDocuments} from './order-document-model.mjs';
import {createGallery} from './gallery.mjs';
import {privateText} from './pa-workspace-privacy.mjs';

const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=privateText(String(text));n.className=cls;return n;};
const button=(name,run)=>{const b=el('button',name,'lightbtn');b.type='button';b.onclick=()=>Promise.resolve(run()).catch(()=>{});return b;};
export function createOrderDocuments({host,mountFallback,previewScope,isCurrent,deferQuote=false}){
 let active=true,version=0,galleries=[],downloads=[],unsubscribe=null,monitorView=null,visibleKey=null;
 const mounted=new Map();
 const safe=()=>active&&isCurrent(),region=el('section','','change-evidence order-documents');region.setAttribute('aria-label','受注後の変更見積・顧客承認証拠');
 const heading=el('div','','order-documents-heading');heading.append(el('h2','受注関連書類'));const tools=el('div','','inlinebtns');heading.append(tools);
 const grid=el('div','','change-evidence-grid order-documents-grid'),note=el('p','変更見積・承認証拠を確認中。表示だけでは保存・採用しません。','order-reading-note');note.setAttribute('role','status');
 const columns=['正式受注確認書','変更見積書','顧客承認メール'].map((title,i)=>{
  const card=el('article','','change-evidence-column order-document order-document-'+i),top=el('div','','order-document-top'),label=el('p',['01 ／ 元の正式受注','02 ／ 変更見積・登録見積','03 ／ 対応する顧客返信'][i],'order-document-number'),h=el('h3',title),badge=el('p',i===0?'契約原本は未照合':i===1?'登録見積・最新発行版（有効版とは別）':'承認証拠は未特定','order-document-badge'),body=el('div','','order-document-preview'),links=el('div','','order-document-links');
  body.id=['formal-document-grid','current-estimate-grid','approval-document-grid'][i];top.append(label,h,badge);card.append(top,body,links);grid.append(card);return {card,h,badge,body,links};
 });
 columns[2].body.append(el('p','原本と対象見積の照合後に表示します。','empty-state'));
 region.append(heading,grid,note);host.replaceChildren(region);
 mountFallback(columns[0].body,'formal');if(!deferQuote)mountFallback(columns[1].body,'quote');else{columns[1].badge.textContent='現行合意の採用記録を確認中';columns[1].body.append(el('p','現行合意の原本を確認中です。旧見積を現行として代替表示しません。','empty-state'));}
 const clearDownloads=()=>{for(const release of downloads.splice(0))release();};
 function linkHistory(){const target=document.querySelector('.order-document-history');if(target){target.open=true;target.scrollIntoView({block:'start',behavior:'smooth'});}}
 tools.append(button('履歴を見る ↓',linkHistory));
 for(const c of columns)c.links.append(button('関連履歴',linkHistory));
 let wired=false,last=null;
 function connect({request,assets,resolve,openEvidence,adoptEvidence,monitor=null,caseId=null,onDecision=null}){
  if(!safe())return;
  if(!wired){wired=true;tools.append(button('変更見積・承認証拠を検索・確認',openEvidence));if(monitor)tools.append(button('変更見積を手動で登録・選択',()=>openEvidence()));}
  const ticket=++version;
  Promise.resolve(resolve()).then(model=>{
   if(!safe()||ticket!==version||last===model)return;last=model;
   unsubscribe?.();unsubscribe=null;for(const n of region.querySelectorAll('.quote-candidate-controls,.order-evidence-history'))n.remove();
   note.textContent=privateText(model.notice||'表示と正式採用は別です。既存契約・登録見積・請求情報は変更しません。');
   const make=(i,action,payload,filename,sha256)=>{
    const c=columns[i],item={key:action+':'+(sha256||payload.contract_id),asset_id:action+':'+(sha256||payload.contract_id),asset_kind:'evidence',mime_type:'application/pdf',filename,title:filename,sha256,source_ref:{action,payload}};
    const identity=action+':'+sha256+':'+filename;let record=mounted.get(i),gallery;
    if(record?.identity===identity){record.action=action;record.payload=payload;gallery=record.gallery;}
    else{record={identity,action,payload};gallery=createGallery({assets,previewScope,isCurrent:safe,requestBlob:()=>request(record.action,record.payload,true)});record.gallery=gallery;mounted.set(i,record);galleries.push(gallery);gallery.mount(c.body,[item],{compact:true});}
    c.links.replaceChildren(button('PDFを拡大',()=>gallery.openPreview(item)),button('PDFをダウンロード',async()=>{
     const record=await assets.record(item,{fresh:true});if(!safe()){assets.release(record);return;}
     const a=el('a');a.href=record.url;a.download=filename;document.body.append(a);a.click();a.remove();downloads.push(()=>assets.release(record));
    }),button('関連履歴',linkHistory));
   };
   if(model.original){columns[0].badge.textContent='正式受注済み・原本保全';make(0,'change_evidence_contract_pdf',{contract_id:model.original.id},'元の正式受注確認書.pdf',model.original.sha256);}
   const present=(model,key='baseline')=>{
   visibleKey=key;
   if(monitor)note.textContent=privateText(model.monitorCandidate?(model.stale?'前回の候補原本を表示中です。最新照合は未完了で、正式採用ではありません。':'未採用候補を表示中です。正式採用するまで現行合意見積は変更しません。'):model.adopted?'Owner採用済みの現行合意見積を表示しています。新しい候補を表示しても正式採用は変わりません。':model.notice||'正式登録見積を表示中です。変更候補は別に確認します。');
   if(!model.evidence){if(deferQuote){mounted.delete(1);mounted.delete(2);columns[1].body.replaceChildren();columns[1].badge.textContent='正式登録見積・最新発行版（現行合意採用とは別）';mountFallback(columns[1].body,'quote');columns[2].body.replaceChildren(el('p','対応する顧客承認は未特定です。','empty-state'));columns[2].links.replaceChildren();columns[2].badge.textContent='承認証拠は未特定';}return;}
   const e=model.evidence,payload=model.event_id?{event_id:model.event_id}:model.payload;
   columns[1].h.textContent='変更見積書';columns[1].badge.textContent=model.label;columns[2].badge.textContent=model.adopted?'Owner採用済み・証拠控え':'返信原本照合済み・Owner未採用';
   make(1,model.monitorCandidate?'quote_monitor_document':'change_evidence_document',payload,e.quote.filename,e.quote.sha256);
   columns[2].badge.textContent=model.stale?'前回の承認証拠・最新確認未完了':e.approval?.source==='missing'?'顧客承認待ち・正式採用不可':columns[2].badge.textContent;
   // Manual evidence remains explicitly distinct; an absent or uncertain
   // approval never borrows a different message from the same case.
   if(e.approval?.source==='gmail'&&(!model.monitorCandidate||model.adopted||e.approval.status==='verified')||(model.adopted||model.monitorCandidate)&&e.approval?.source==='manual_pdf'){
    if(e.approval.source==='manual_pdf')columns[2].badge.textContent=model.adopted?'Owner採用済み・手動提出控え（Gmail未照合）':'手動提出控え・Owner未採用（Gmail未照合）';
    make(2,model.monitorCandidate?'quote_monitor_document':'change_evidence_mail_pdf',model.monitorCandidate?{...payload,kind:'approval'}:payload,'顧客承認メール控え.pdf',e.approval.manual_pdf_sha256||e.quote.sha256+':'+e.approval.message_id);
    if(e.approval.thread_id){const a=el('a','Gmail原本を開く');a.href='https://mail.google.com/mail/u/0/#all/'+e.approval.thread_id;a.target='_blank';a.rel='noopener noreferrer';columns[2].links.append(a);}
   }else{mounted.delete(2);columns[2].body.replaceChildren(el('p','対応する顧客承認は未確認です。正式採用はできません。','empty-state'));columns[2].links.replaceChildren();}
   };
   present(model,model.event_id||'baseline');
   if(monitor){
    const controls=el('section','','quote-candidate-controls'),summary=el('p','','hint'),choices=el('div','','inlinebtns'),actions=el('div','','inlinebtns'),excluded=el('details');excluded.append(el('summary','変更見積の除外・保留履歴'));controls.append(summary,choices,actions,excluded);columns[1].card.append(controls);
    let selectedCandidate=null;
    const loadHistory=async(before=null)=>{try{const page=await monitor.history(caseId,before);if(!safe()||page.case_id!==caseId)return;excluded.replaceChildren(el('summary','変更見積の除外・保留履歴（20件ずつ）'));excluded.open=true;for(const d of page.events){excluded.append(el('p',d.event_kind+' / '+d.created_at+' / '+d.reason));if(d.event_kind==='excluded')excluded.append(button('この除外を解除: '+d.candidate.evidence.quote.filename,()=>onDecision?.({...d.candidate,decision:d},'restored')));}if(page.next_before)excluded.append(button('以前の判断履歴',()=>loadHistory(page.next_before)));if(before)excluded.append(button('最新の判断履歴',()=>loadHistory()));}catch{if(safe())summary.textContent='判断履歴の取得は未完了です。保存済み判断を変更しません。';}};
    const select=c=>{
     if(!safe()||c.case_id!==caseId||c.evidence?.case_id!==caseId)return;
     selectedCandidate=c;const payload={candidate_key:c.key,quote_sha256:c.evidence.quote.sha256};
     present({evidence:c.evidence,payload,label:c.stale?'前回の照合候補・最新確認未完了':c.decision?.event_kind==='deferred'?'あとで確認・Owner未採用':c.evidence.approval?.status==='verified'?'送信済み・Owner未採用':'変更見積候補・承認待ち',monitorCandidate:true,stale:c.stale},c.key);
     for(const i of [1,2]){columns[i].badge.replaceChildren(document.createTextNode(columns[i].badge.textContent));if(adoptEvidence){const entry=button('この見積を採用',()=>adoptEvidence(c));entry.disabled=c.stale||c.evidence.approval?.status!=='verified'||!c.evidence.approval.exact_quote_reference||!c.evidence.approval.linked;columns[i].badge.append(entry);}}
     actions.replaceChildren(button('この見積を現行合意見積として採用',()=>(adoptEvidence||openEvidence)(c)),button('この案件の変更見積ではない',()=>onDecision?.(c,'excluded')),button('あとで確認',()=>onDecision?.(c,'deferred')));
    };
    const update=value=>{
     if(!safe()||value?.case_id!==caseId)return;monitorView=value;
     summary.textContent=privateText((value.error?'変更見積の確認未完了':value.label||'保存済み検査結果')+(value.checked_at?' / 最終確認 '+value.checked_at:'')+(value.index_truncated?' / 検査範囲未完了':''));
     choices.replaceChildren(button(value.partial?'未確認の原本検査を続ける':'変更見積を再確認',async()=>{try{await monitor.check(caseId,{force:true,resume:value.partial===true});}catch{if(safe())summary.textContent='再確認は未完了です。保存済み状態を保持します。';}}));
     if(!value.candidates)return;
     const candidates=value.candidates.filter(c=>c.decision?.event_kind!=='excluded');
     for(const c of candidates)choices.append(button('候補を確認: '+c.evidence.quote.filename,()=>select(c)));
     if(model.adopted)choices.append(button('採用済み見積を表示',()=>{selectedCandidate=null;actions.replaceChildren();present(model,model.event_id);}));
     excluded.replaceChildren(el('summary','変更見積の除外・保留履歴'));
     excluded.append(button('判断履歴を取得（20件ずつ）',()=>loadHistory()));
     for(const d of value.decisions||[]){excluded.append(el('p',d.event_kind+' / '+d.created_at+' / '+d.reason));if(d.event_kind==='excluded')excluded.append(button('除外を解除: '+d.candidate.evidence.quote.filename,()=>onDecision?.({...d.candidate,decision:d},'restored')));}
     if(selectedCandidate){const current=candidates.find(c=>c.key===selectedCandidate.key);if(!current){selectedCandidate=null;actions.replaceChildren();visibleKey=null;present(model,model.event_id||'baseline');}else select(current);}
     else if(!model.adopted&&candidates.length===1&&value.state!=='incomplete'&&value.scan?.state==='ready')select(candidates[0]);
     if(candidates.length>1)summary.textContent+=' / 候補複数。自動で1件へ確定しません。';
    };
    unsubscribe?.();unsubscribe=monitor.subscribe(caseId,update);const cached=monitor.getFull(caseId)||monitor.get(caseId);if(cached)update(cached);void monitor.ensure(caseId).then(update).catch(()=>{if(safe())summary.textContent='変更見積の確認は未完了です。現行見積と履歴を保持しています。';});
   }
   const history=el('details','','order-evidence-history');history.append(el('summary','変更証拠の保存・採用・取消・訂正履歴'));
   for(const event of model.state.history||[])history.append(el('p',event.event_kind+' / '+event.created_at));
   if(!(model.state.history||[]).length)history.append(el('p','保存済みの変更証拠イベントはありません。'));
   region.append(history);
  }).catch(e=>{if(safe()&&ticket===version)note.textContent=privateText(e.message==='invalid_origin'?'このPreviewの操作許可はありません。原本照合は未完了です。':'変更証拠の取得・照合を完了できません。登録見積と履歴を保持しています。');});
 }
 return {connect,dispose(){if(!active)return;active=false;++version;unsubscribe?.();unsubscribe=null;monitorView=null;mounted.clear();clearDownloads();for(const g of galleries)g.dispose();galleries=[];}};
}
