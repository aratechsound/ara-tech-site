import {applyTranslations,setVenueMap,translate} from "./portal-ui-contract.mjs";
import {createLocaleController,languagePicker,eventDate,eventInstant} from './portal-i18n.mjs';
const $=id=>document.getElementById(id);let model=null;let refreshPromise=null;let previewGeneration=0;let errorKey='';const urls=new Set();let pdfjs;
const locale=createLocaleController(()=>render());$('staff-language').append(languagePicker(locale));
async function request(action,extra={}){const response=await fetch('/api/staff-portal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra}),cache:'no-store',credentials:'same-origin'});if(!response.ok)throw new Error(response.status===401?'invalid':'error');return action==='download'?response.blob():(await response.json()).result;}
function clearPreview(){previewGeneration++;urls.forEach(url=>URL.revokeObjectURL(url));urls.clear();$('staff-preview-pages').replaceChildren();}
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
  if(!docs.length){const card=document.createElement('article');card.className='empty-document-card document-card--placeholder';const inner=document.createElement('div');inner.className='empty-card';inner.textContent=locale.t('empty');card.append(inner);root.append(card);}
  for(const d of docs){const card=document.createElement('article');card.className='document-card';
   const previewButton=document.createElement('button');previewButton.className='document-card__preview';previewButton.type='button';previewButton.textContent=d.mime_type==='application/pdf'?'PDF':locale.t('preview');
   const body=document.createElement('div');body.className='document-card__body';const title=document.createElement('h3');title.className='document-title';title.textContent=d.filename;
   const meta=document.createElement('p');meta.className='document-meta';meta.textContent=`${locale.t('latest')} ${d.version_label||''} · ${eventInstant(d.updated_at,locale.locale,e.timezone)}`;
   const actions=document.createElement('div');actions.className='staff-actions';
   const action=async key=>{try{const blob=await request('download',{asset_ref:d.ref,asset_kind:d.kind});if(key==='preview')await preview(d,blob);else{const url=URL.createObjectURL(blob);urls.add(url);const a=document.createElement('a');a.href=url;a.download=d.filename;a.click();setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},1000);}}catch(error){showError(error);}};
   previewButton.addEventListener('click',()=>action('preview'));
   if(category==='photo'){
    card.className='photo-tile';previewButton.className='photo-tile photo-tile__preview';
    const label=document.createElement('span');label.textContent=d.filename;previewButton.replaceChildren(label);
    card.append(previewButton);root.append(card);continue;
   }
   if(category==='performer'){
    card.className='performer-item performer-item--integrated';const order=document.createElement('span');order.className='performer-order';order.textContent=String(docs.indexOf(d)+1);
    body.className='performer-info';title.textContent=d.title||d.filename;body.append(title,meta);
    const documents=document.createElement('div');documents.className='performer-documents';previewButton.className='performer-document';
    const label=document.createElement('span');label.className='performer-document__label';label.textContent=d.filename;previewButton.replaceChildren(label);documents.append(previewButton);
    card.append(order,body,documents);root.append(card);continue;
   }
   const icon=document.createElement('span');icon.className='document-icon';icon.textContent=previewButton.textContent;
   const zoom=document.createElement('span');zoom.className='zoom-label';zoom.textContent=locale.t('preview');previewButton.replaceChildren(icon,zoom);
   for(const key of ['preview','download']){const button=document.createElement('button');button.className='view-button';button.type='button';button.textContent=locale.t(key);button.addEventListener('click',()=>action(key));actions.append(button);}
   body.append(title,meta,actions);card.append(previewButton,body);root.append(card);
  }
 }
}

async function preview(d,blob){clearPreview();const generation=previewGeneration;$('staff-preview-title').textContent=d.title;$('staff-preview').showModal();if(d.mime_type==='application/pdf'){pdfjs ||= await import('/pdfjs/pdf.min.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.min.mjs?v=6.3.289';const task=pdfjs.getDocument({data:await blob.arrayBuffer()});const pdf=await task.promise;try{for(let n=1;n<=pdf.numPages;n++){if(generation!==previewGeneration)break;const page=await pdf.getPage(n),v=page.getViewport({scale:1.2}),canvas=document.createElement('canvas');canvas.width=v.width;canvas.height=v.height;await page.render({canvasContext:canvas.getContext('2d'),viewport:v}).promise;if(generation===previewGeneration)$('staff-preview-pages').append(canvas);}}finally{await task.destroy();}}else{const url=URL.createObjectURL(blob);urls.add(url);const img=document.createElement('img');img.src=url;img.alt=d.title;$('staff-preview-pages').append(img);}}
$('staff-preview-close').addEventListener('click',()=>{$('staff-preview').close();clearPreview();});$('staff-preview').addEventListener('cancel',clearPreview);$('staff-refresh').addEventListener('click',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});window.addEventListener('pageshow',e=>{if(e.persisted)refresh();});window.addEventListener('pagehide',clearPreview);
render();const token=location.hash.slice(1);history.replaceState(null,'','/staff-portal');try{if(token)await request('exchange',{token});await refresh();}catch(error){showError(error);}
