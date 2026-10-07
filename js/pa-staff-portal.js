import {applyTranslations,setVenueMap,translate} from "./portal-ui-contract.mjs";
import {createLocaleController,languagePicker,eventDate,eventInstant} from './portal-i18n.mjs';
import {createPortalDocumentView} from './portal-document-view.mjs';
const $=id=>document.getElementById(id);let model=null;let refreshPromise=null;let errorKey='';const records=new Map();let pdfjs;
const locale=createLocaleController(()=>render());$('staff-language').append(languagePicker(locale));
async function request(action,extra={}){const response=await fetch('/api/staff-portal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra}),cache:'no-store',credentials:'same-origin'});if(!response.ok)throw new Error(response.status===401?'invalid':'error');return action==='download'?response.blob():(await response.json()).result;}
const documentView=createPortalDocumentView({
 getAttachmentRecord:async(d,{fresh=false}={})=>{const key=`${d.asset_kind}:${d.asset_id}`;if(!fresh&&records.has(key))return records.get(key);const blob=await request('download',{asset_ref:d.asset_id,asset_kind:d.asset_kind});const record={blob,url:URL.createObjectURL(blob)};if(!fresh)records.set(key,record);return record;},
 getPdfjs:async()=>{pdfjs ||= await import('/pdfjs/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.min.mjs?v=6.3.289';return pdfjs;},
 orgText:(key,params)=>locale.t(key,params),
 sourceLabel:()=>locale.t('latest'),documentTime:d=>eventInstant(d.updated_at,locale.locale,model?.event.timezone),
 showToast:()=>{$('staff-status').hidden=false;$('staff-status').textContent=locale.t('orgOriginalError');},
 dialogSelector:'#staff-preview',bodySelector:'#staff-preview-pages',titleSelector:'#staff-preview-title'
});
function clearPreview(){documentView.clear();records.forEach(({url})=>URL.revokeObjectURL(url));records.clear();}
function showError(error){clearPreview();$('staff-preview').close();model=null;$('staff-content').hidden=true;errorKey=error.message==='invalid'?'invalid':'error';render();}
async function refresh(){if(refreshPromise)return refreshPromise;refreshPromise=(async()=>{try{clearPreview();$('staff-preview').close();model=null;$('staff-content').hidden=true;model=await request('read');errorKey='';render();}catch(error){showError(error);}})();try{await refreshPromise;}finally{refreshPromise=null;}}
function render(){
 document.title=`${locale.t('title')} | ARA-TECH`;applyTranslations(locale.locale);
 $('staff-refresh').textContent=locale.t('refresh');$('staff-preview-close').textContent=locale.t('close');
 $('staff-status').hidden=!errorKey;$('staff-status').textContent=errorKey?locale.t(errorKey):'';if(errorKey)$('staff-loading').hidden=true;
 if(!model)return;const e=model.event;$('staff-loading').hidden=true;$('staff-content').hidden=false;
 $('portal-event-name').textContent=e.name;$('portal-date').textContent=eventDate(e.date,locale.locale);$('portal-time').textContent=e.time||'—';setVenueMap(e);
 $('staff-grade-note').textContent=`${locale.t(model.grade)} · ${locale.t('readOnly')} · ${translate(locale.locale,model.grade==='GENERAL'?'generalScope':'technicalScope')}`;
 $('performer-section').hidden=model.grade!=='TECHNICAL';
 for(const [id,category] of [['timetable-content','timetable'],['script-content','script'],['layout-content','layout'],['photo-content','photo'],['other-content','other'],['performer-content','performer']]){
  const root=$(id);root.replaceChildren();
  // Older responses have no category: retain common/performer fallback without filename inference.
  const docs=model.documents.filter(d=>d.category===category||(!d.category&&(category==='other'&&d.section==='common'&&d.kind!=='photo'||category==='photo'&&d.kind==='photo'||category==='performer'&&d.section==='performer')));
  if(!docs.length){root.append(documentView.makeEmptyCard({title:locale.t({timetable:'orgTimetable',script:'orgScript',layout:'orgLayout',photo:'orgPhotos',other:'orgOther',performer:'orgPerformer'}[category]),message:locale.t('empty'),icon:category==='photo'?'▧':'PDF',fixed:['timetable','script'].includes(category),collection:['layout','other'].includes(category)}));}
  for(const d of docs){const item={...d,asset_id:d.ref,asset_kind:d.kind};
   if(category==='photo'){root.append(documentView.makePhotoTile(item));continue;}
   if(category==='performer'){
    const card=document.createElement('article');card.className='performer-item performer-item--integrated';
    const order=document.createElement('span');order.className='performer-order';order.textContent=String(docs.indexOf(d)+1);
    const info=document.createElement('div');info.className='performer-info';const title=document.createElement('h3');title.textContent=d.title||d.filename;info.append(title);
    const documents=document.createElement('div');documents.className='performer-documents';documents.append(documentView.makePerformerDocument(item));
    card.append(order,info,documents);root.append(card);continue;
   }
   root.append(documentView.makeDocumentCard(item,{fixed:['timetable','script'].includes(category),collection:['layout','other'].includes(category)}));
  }
 }
}

$('staff-preview-close').addEventListener('click',()=>documentView.closePreview());$('staff-preview').addEventListener('cancel',documentView.closePreview);$('staff-refresh').addEventListener('click',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('pageshow',e=>{if(e.persisted)refresh();});window.addEventListener('pagehide',clearPreview);
render();const token=location.hash.slice(1);history.replaceState(null,'','/staff-portal');try{if(token)await request('exchange',{token});await refresh();}catch(error){showError(error);}
