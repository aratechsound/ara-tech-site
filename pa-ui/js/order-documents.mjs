export {resolveOrderDocuments} from './order-document-model.mjs';
import {createGallery} from './gallery.mjs';
import {privateText} from './pa-workspace-privacy.mjs';

const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=privateText(String(text));n.className=cls;return n;};
const button=(name,run)=>{const b=el('button',name,'lightbtn');b.type='button';b.onclick=()=>Promise.resolve(run()).catch(()=>{});return b;};
export function createOrderDocuments({host,mountFallback,previewScope,isCurrent}){
 let active=true,version=0,galleries=[],downloads=[];
 const safe=()=>active&&isCurrent(),region=el('section','','change-evidence order-documents');region.setAttribute('aria-label','受注後の変更見積・顧客承認証拠');
 const heading=el('div','','order-documents-heading');heading.append(el('h2','受注関連書類'));const tools=el('div','','inlinebtns');heading.append(tools);
 const grid=el('div','','change-evidence-grid order-documents-grid'),note=el('p','変更見積・承認証拠を確認中。表示だけでは保存・採用しません。','order-reading-note');note.setAttribute('role','status');
 const columns=['正式受注確認書','変更見積書','顧客承認メール'].map((title,i)=>{
  const card=el('article','','change-evidence-column order-document order-document-'+i),top=el('div','','order-document-top'),label=el('p',['01 ／ 元の正式受注','02 ／ 変更見積・登録見積','03 ／ 対応する顧客返信'][i],'order-document-number'),h=el('h3',title),badge=el('p',i===0?'契約原本は未照合':i===1?'登録見積・最新発行版（有効版とは別）':'承認証拠は未特定','order-document-badge'),body=el('div','','order-document-preview'),links=el('div','','order-document-links');
  body.id=['formal-document-grid','current-estimate-grid','approval-document-grid'][i];top.append(label,h,badge);card.append(top,body,links);grid.append(card);return {card,h,badge,body,links};
 });
 columns[2].body.append(el('p','原本と対象見積の照合後に表示します。','empty-state'));
 region.append(heading,grid,note);host.replaceChildren(region);
 mountFallback(columns[0].body,'formal');mountFallback(columns[1].body,'quote');
 const clearDownloads=()=>{for(const release of downloads.splice(0))release();};
 function linkHistory(){const target=document.querySelector('.order-document-history');if(target){target.open=true;target.scrollIntoView({block:'start',behavior:'smooth'});}}
 tools.append(button('履歴を見る ↓',linkHistory));
 for(const c of columns)c.links.append(button('関連履歴',linkHistory));
 let wired=false,last=null;
 function connect({request,assets,resolve,openEvidence}){
  if(!safe())return;
  if(!wired){wired=true;tools.append(button('変更見積・承認証拠を検索・確認',openEvidence));}
  const ticket=++version;
  Promise.resolve(resolve()).then(model=>{
   if(!safe()||ticket!==version||last===model)return;last=model;
   note.textContent=privateText(model.notice||'表示と正式採用は別です。既存契約・登録見積・請求情報は変更しません。');
   const make=(i,action,payload,filename,sha256)=>{
    const c=columns[i],item={key:action+':'+(sha256||payload.contract_id),asset_id:action+':'+(sha256||payload.contract_id),asset_kind:'evidence',mime_type:'application/pdf',filename,title:filename,sha256,source_ref:{action,payload}};
    const gallery=createGallery({assets,previewScope,isCurrent:safe,requestBlob:()=>request(action,payload,true)});galleries.push(gallery);gallery.mount(c.body,[item],{compact:true});
    c.links.replaceChildren(button('PDFを拡大',()=>gallery.openPreview(item)),button('PDFをダウンロード',async()=>{
     const record=await assets.record(item,{fresh:true});if(!safe()){assets.release(record);return;}
     const a=el('a');a.href=record.url;a.download=filename;document.body.append(a);a.click();a.remove();downloads.push(()=>assets.release(record));
    }),button('関連履歴',linkHistory));
   };
   if(model.original){columns[0].badge.textContent='正式受注済み・原本保全';make(0,'change_evidence_contract_pdf',{contract_id:model.original.id},'元の正式受注確認書.pdf',model.original.sha256);}
   if(!model.evidence)return;
   const e=model.evidence,payload=model.event_id?{event_id:model.event_id}:model.payload;
   columns[1].h.textContent='変更見積書';columns[1].badge.textContent=model.label;columns[2].badge.textContent=model.adopted?'Owner採用済み・証拠控え':'返信原本照合済み・Owner未採用';
   make(1,'change_evidence_document',payload,e.quote.filename,e.quote.sha256);
   // Manual evidence remains explicitly distinct; an absent or uncertain
   // approval never borrows a different message from the same case.
   if(e.approval?.source==='gmail'||model.adopted&&e.approval?.source==='manual_pdf'){
    if(e.approval.source==='manual_pdf')columns[2].badge.textContent='Owner採用済み・手動提出控え（Gmail未照合）';
    make(2,'change_evidence_mail_pdf',payload,'顧客承認メール控え.pdf',e.approval.manual_pdf_sha256||e.quote.sha256+':'+e.approval.message_id);
    if(e.approval.thread_id){const a=el('a','Gmail原本を開く');a.href='https://mail.google.com/mail/u/0/#all/'+e.approval.thread_id;a.target='_blank';a.rel='noopener noreferrer';columns[2].links.append(a);}
   }
   const history=el('details','','order-evidence-history');history.append(el('summary','変更証拠の保存・採用・取消・訂正履歴'));
   for(const event of model.state.history||[])history.append(el('p',event.event_kind+' / '+event.created_at));
   if(!(model.state.history||[]).length)history.append(el('p','保存済みの変更証拠イベントはありません。'));
   region.append(history);
  }).catch(e=>{if(safe()&&ticket===version)note.textContent=privateText(e.message==='invalid_origin'?'このPreviewの操作許可はありません。原本照合は未完了です。':'変更証拠の取得・照合を完了できません。登録見積と履歴を保持しています。');});
 }
 return {connect,dispose(){if(!active)return;active=false;++version;clearDownloads();for(const g of galleries)g.dispose();galleries=[];}};
}
