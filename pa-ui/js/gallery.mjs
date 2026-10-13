import {createPortalDocumentView} from './portal-document-view.mjs';
import {resetPrivacy} from './pa-workspace-privacy.mjs';
import {escape,publicScope} from './model.mjs';
import {fileType} from './mail-model.mjs';
let pdfjsPromise,serial=0;
async function getPdfjs(){
  if(!pdfjsPromise)pdfjsPromise=import('/pa-ui/vendor/pdf.mjs').then(m=>{m.GlobalWorkerOptions.workerSrc='/pa-ui/vendor/pdf.worker.mjs';return m;});
  return pdfjsPromise;
}
export function previewError(e){
  const codes={gmail_not_configured:'Gmail読取設定が未接続',provider_read_failed:'Gmail原本の読取に失敗しました',provider_read_denied:'権限拒否 / Gmail原本の閲覧が拒否されました',canonical_attachment_path_unavailable:'未取得 / 正規の添付読取経路が未接続',body_read_path_unavailable:'本文未取得 / 保存済み抜粋なし・正規の本文読取経路が未接続',not_found:'原本未取得 / 404（削除・期限切れ・対応不明）',asset_identity_mismatch:'原本の整合性検証に失敗',preview_type_refused:'内容プレビュー非対応',read_timeout_or_cancelled:'読取がタイムアウトまたは中断されました'};
  const bindings={attachment_mail_mismatch:'対応不明 / メールの添付索引との紐付けを検証できません',mail_binding_mismatch:'対応不明 / 案件・メールの紐付けを検証できません',case_binding_mismatch:'対応不明 / 案件・資料の紐付けを検証できません'};
  return codes[e.code]||bindings[e.code]||(e.status===403?'閲覧拒否 / 403（認証・ACLまたは資料の紐付け）':e.status===401?'認証が必要です':'原本未取得 / 読取失敗');
}
// Shared by portal documents and mail attachments. Only separate money fields expire.
export function createGallery({requestBlob,isCurrent}){
  const id='asset-preview-'+(++serial),urls=new Set(),records=new Map();
  let epoch=0,active=true,entries=[],root,view,dialog,observer,previewEpoch=0;
  const current=()=>active&&isCurrent();
  const supported=item=>['application/pdf','image/png','image/jpeg','image/webp'].includes(item.mime_type);
  async function attachmentRecord(item){
    const generation=epoch;
    if(!current())throw Error('stale_asset');
    if(records.has(item.key))return records.get(item.key);
    const pending=(async()=>{
      const blob=await requestBlob(item);
      if(!current()||epoch!==generation)throw Error('stale_asset');
      const url=URL.createObjectURL(blob);urls.add(url);return {blob,url};
    })();
    records.set(item.key,pending);return pending;
  }
  function ensureView(){
    if(!view)view=createPortalDocumentView({getAttachmentRecord:attachmentRecord,getPdfjs,orgText:key=>key,
      sourceLabel:()=>'',documentTime:()=>'',showToast:()=>{},dialogSelector:'#'+id,bodySelector:'#'+id+'-body',titleSelector:'#'+id+'-title',
      nextPreview:()=>++previewEpoch,isCurrentPreview:n=>n===previewEpoch&&current()});
    return view;
  }
  async function thumb(item,button,slot,generation){
    if(!item.asset_id){slot.textContent=item.original_state||'原本識別子未登録';return;}
    if(!supported(item)){slot.textContent=fileType(item);slot.className='file-icon';return;}
    try{
      if(item.mime_type==='application/pdf'){
        const canvas=document.createElement('canvas');canvas.setAttribute('aria-hidden','true');
        await ensureView().renderPdfPage(item,1,canvas,Math.max(button.clientWidth-12,90),button.clientHeight-10);
        if(current()&&epoch===generation&&slot.isConnected)slot.replaceWith(canvas);
      }else{
        const record=await attachmentRecord(item),img=document.createElement('img');img.alt=item.filename;img.src=record.url;await img.decode();
        if(current()&&epoch===generation&&slot.isConnected)slot.replaceWith(img);
      }
    }catch(e){if(current()&&epoch===generation&&slot.isConnected){slot.className='material-error';slot.textContent=previewError(e);button.dataset.error='true';}}
  }
  function scheduleThumbs(){
    observer?.disconnect();const generation=epoch;
    observer=new IntersectionObserver(changes=>{
      for(const change of changes)if(change.isIntersecting){
        const button=change.target;observer.unobserve(button);
        const item=entries.find(d=>d.key===button.dataset.materialKey),slot=button.firstElementChild;
        if(item&&slot)thumb(item,button,slot,generation);
      }
    },{root:null,rootMargin:'80px'});
    root.querySelectorAll('[data-material-key]').forEach(b=>observer.observe(b));
  }
  async function openPreview(item){
    if(!current()||!item.asset_id)return;
    resetPrivacy();if(dialog?.open)dialog.close();
    const generation=epoch;
    dialog=document.createElement('dialog');dialog.id=id;dialog.className='pa-material-preview-dialog';dialog.dataset.externalMoneyGuard='true';
    const title=document.createElement('h3');title.id=id+'-title';title.textContent=item.filename;
    const body=document.createElement('div');body.id=id+'-body';body.className='preview-content';body.textContent='原本を取得中…';
    const controls=document.createElement('div');controls.className='preview-controls';
    const close=document.createElement('button');close.textContent='閉じる';const opened=dialog;close.onclick=()=>opened.close();
    opened.append(title,controls,body,close);document.body.append(opened);opened.showModal();
    let renderId=0,page=1,zoom=1,pages=1;
    const alive=()=>current()&&epoch===generation&&opened.isConnected&&opened.open;
    opened.addEventListener('close',()=>{++renderId;opened.remove();if(dialog===opened)dialog=null;},{once:true});
    if(!supported(item)){body.textContent=fileType(item)+' / 内容プレビュー非対応。原本の取得・ダウンロードは行いません。';return;}
    try{
      if(item.mime_type!=='application/pdf'){
        const record=await attachmentRecord(item);if(!alive())return;
        const img=document.createElement('img');img.src=record.url;img.alt=item.filename;body.replaceChildren(img);return;
      }
      const pdf=await ensureView().getPdfDocument(item);if(!alive())return;pages=pdf.numPages;
      const prev=document.createElement('button'),next=document.createElement('button'),minus=document.createElement('button'),plus=document.createElement('button'),label=document.createElement('span');
      prev.textContent='前のページ';next.textContent='次のページ';minus.textContent='縮小';plus.textContent='拡大';label.setAttribute('aria-live','polite');controls.append(prev,label,next,minus,plus);
      async function draw(){
        if(!alive())return;
        const ticket=++renderId,canvas=document.createElement('canvas');canvas.setAttribute('aria-label','PDF '+page+'ページ');
        label.textContent=page+' / '+pages+'ページ · '+Math.round(zoom*100)+'%';prev.disabled=page===1;next.disabled=page===pages;minus.disabled=zoom<=.5;plus.disabled=zoom>=2;
        try{await ensureView().renderPdfPage(item,page,canvas,Math.max(280,body.clientWidth-28)*zoom,Infinity,Infinity);if(alive()&&ticket===renderId)body.replaceChildren(canvas);}
        catch(e){if(alive()&&ticket===renderId)body.textContent=previewError(e);}
      }
      prev.onclick=()=>{page=Math.max(1,page-1);draw();};next.onclick=()=>{page=Math.min(pages,page+1);draw();};minus.onclick=()=>{zoom=Math.max(.5,zoom-.25);draw();};plus.onclick=()=>{zoom=Math.min(2,zoom+.25);draw();};await draw();
    }catch(e){if(alive())body.textContent=previewError(e);}
  }
  function mount(target,items,{compact=false,showSource=false,warehouse=false}={}){
    root=target;entries=items;
    root.innerHTML=items.map(d=>`<article class="material-card ${compact?'attachment-card':''}"><button class="material-thumb" data-material-key="${escape(d.key)}" aria-label="${escape(d.filename)} の拡大プレビュー" ${d.asset_id?'':'disabled'}><span class="thumb-lock">${d.asset_id?'必要時に原本を取得':escape(d.original_state||'原本識別子未登録')}</span></button><div class="material-meta"><div class="material-name">${escape(d.title||d.filename)}</div>${compact||warehouse?'':`<div class="material-info">${d.filename!==d.title?escape(d.filename)+'<br>':''}更新 ${escape(d.updated_at?new Date(d.updated_at).toLocaleString('ja-JP'):'未提供')}<br>版 ${escape(d.version_label)}<br>公開区分 ${escape(d.access_scope||'未取得（既存ACLで制御）')}<br>所有者 ${escape(publicScope(d.owner_kind))}</div>`}${d.original_state?'<div class="material-info">'+escape(d.original_state)+'</div>':''}<div class="material-badges"><span class="tiny neutral">${escape(fileType(d))}</span>${Number.isFinite(Number(d.size))&&d.size!=null?'<span class="tiny neutral">'+Math.ceil(Number(d.size)/1024)+' KB</span>':''}${compact||warehouse?'':'<span class="tiny neutral">'+escape(d.change)+'</span>'}</div>${!warehouse&&(d.versions||[]).length>1?'<details class="material-info"><summary>版履歴 '+d.versions.length+'件</summary>'+d.versions.map(v=>`<div>版 ${escape(v.version_label||'未提供')} / ${escape(v.created_at||'日付未提供')}</div>`).join('')+'</details>':''}</div></article>`).join('')||'<div class="empty-state">取得済み資料はありません</div>';
    root.querySelectorAll('.material-card').forEach((card,index)=>{
      const item=items[index];const name=card.querySelector('.material-name');name.title=item.filename;if(!showSource&&!warehouse){const full=document.createElement('details');full.className='material-info';const label=document.createElement('summary');label.textContent='ファイル名全文';const text=document.createElement('div');text.textContent=item.filename;full.append(label,text);card.querySelector('.material-meta').append(full);}
      if(warehouse){
        const meta=document.createElement('div');meta.className='material-info warehouse-meta';
        const at=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ja-JP'):'未提供';
        const lines=[['種類・登録元',(item.kind||'その他')+' / '+(item.sources||[item.source_label]).join(' / ')],['版・最新',String(item.version_label??'未提供')+' / '+(item.latest_state||'未確認')+(item.portal_current?' / '+item.portal_current:'')],['現行有効版・契約正本',item.valid_state||'未確認']];
        if(item.issued_at)lines.push(['発行',at(item.issued_at)]);
        if(item.source_at)lines.push(['送受信・原資料日時',at(item.source_at)]);
        for(const [label,value]of lines){const line=document.createElement('div');line.textContent=label+'：'+(value||'未提供');meta.append(line);}
        const evidence=document.createElement('details'),summary=document.createElement('summary');summary.textContent='ファイル名全文・日時・原本identity';evidence.append(summary);
        for(const [label,value]of [['ファイル名全文',item.filename],['メール送受信先',item.source_address],['発行日時',at(item.issued_at)],['送受信・原資料日時',at(item.source_at)],['登録日時',at(item.updated_at)],['公開区分',item.access_scope||'未取得（既存ACLで制御）'],['所有者',publicScope(item.owner_kind)],['原本ID',item.asset_id],['メールID',item.message_id],['SHA-256',item.sha256||item.source_ref?.sha256]]){const line=document.createElement('div');line.textContent=label+'：'+(value||'未提供');evidence.append(line);}
        meta.append(evidence);card.querySelector('.material-meta').append(meta);
      }
      if(showSource){
        const source=document.createElement('details');source.className='attachment-source';
        const at=item.source_at&&Number.isFinite(Date.parse(item.source_at))?new Date(item.source_at).toLocaleString('ja-JP'):'日時未提供';
        const summary=document.createElement('summary');summary.textContent='送信元の記録・ファイル名';source.append(summary);const description=document.createElement('div');description.textContent=(item.source_direction==='outbound'?'送信':item.source_direction==='inbound'?'受信':'方向未取得')+' '+at+' / '+(item.source_subject||'件名未提供');
        source.append(description);const fullName=document.createElement('div');fullName.textContent=item.filename;source.append(fullName);source.dataset.sourceMessage=item.message_id;
        const ref=document.createElement('span');ref.className='attachment-source-ref';ref.textContent='メールID '+item.message_id;source.append(ref);card.querySelector('.material-meta').append(source);
      }
    });
    root.querySelectorAll('[data-material-key]').forEach(b=>b.onclick=()=>{const item=entries.find(d=>d.key===b.dataset.materialKey);if(item)openPreview(item);});scheduleThumbs();
  }
  function dispose(){
    active=false;++epoch;++previewEpoch;observer?.disconnect();if(view){view.clear();view=null;}if(dialog?.open)dialog.close();for(const url of urls)URL.revokeObjectURL(url);urls.clear();records.clear();root=null;entries=[];
  }
  return {mount,dispose,openPreview};
}
