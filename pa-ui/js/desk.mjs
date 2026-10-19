import {warehouseItems,filterWarehouse,inquiryFields,inquiryAttachmentItems} from './document-warehouse.mjs';
import {workspaceAuth, readUrl, legacyUrl} from './integration.mjs';
import {requiresReauthentication} from './auth-session.mjs';
import {privateText,privateMoney,resetPrivacy} from './pa-workspace-privacy.mjs';
import {downloadFilename} from './original-download.mjs';
import {createPrivateAssets} from './private-assets.mjs';
import {createGallery,createPreviewScope,previewError} from './gallery.mjs';
import {createCaseTrash,createCaseTrashRequest} from './case-trash.mjs';
import {createReplyDocumentView} from './reply-documents.mjs';
import {createMailBodyView} from './mail-body-view.mjs';
import {mailRow} from './mail-row.mjs';
import {createCaseMailComposer,createCaseMailRequest} from './case-mail-compose.mjs';
import {createCandidateMailView} from './mail-candidate-view.mjs';
import {createWorkflowRequest,createPortalCandidateBridge} from './case-workflows.mjs';
import {createOrderDocuments} from './order-documents.mjs';
import {createCommercialWorkflows} from './commercial-workflows.mjs';
import {createQuoteMonitor} from './quote-monitor.mjs';
import {createQuoteHistory} from './quote-history.mjs';
import {createCaseNameView} from './case-name-view.mjs';
import {createMailAttachmentCarousel} from './mail-carousel.mjs';
import {savedExcerpt,mailAttachments,messageAttention} from './mail-model.mjs';
import {escape,STATUS,STEPS,statusText,statusColor,displayStatus,eventDate,sortCases,filterCases,attention,reviewCounts,scheduleState,scheduleResponseLabel,flattenMaterials,commercialMaterials,isClosedCase,statusBasis,eventLabel,deliveryUnknown} from './model.mjs';

const $=id=>document.getElementById(id),central=$('detail-card');
const tx=value=>escape(privateText(String(value??'未提供')));
const addresses=v=>Array.isArray(v)?v.join(', '):String(v||'未取得');
const date=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未提供';return new Date(value).toLocaleString('ja-JP');};
// The index timestamps describe ingestion, never when a mail was sent/received.
function mailDateValue(row){
  const values=row.direction==='outbound'?[row.sent_at,row.received_at]:[row.received_at,row.sent_at];
  return values.find(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||null;
}
function newestMessages(rows){
  return rows.map((row,index)=>({row,index,at:Date.parse(mailDateValue(row))}))
    .sort((a,b)=>{
      const knownA=Number.isFinite(a.at),knownB=Number.isFinite(b.at);
      if(knownA!==knownB)return knownA?-1:1;
      return (knownA?b.at-a.at:0)||a.index-b.index;
    }).map(item=>item.row);
}
const shortDate=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未定';return new Date(value).toLocaleDateString('ja-JP',{month:'2-digit',day:'2-digit'});};
const flag=(type,text)=>`<span class="pill ${escape(type)}">${tx(text)}</span>`;
const button=(text,act,style='',legacy=false)=>`<button class="action ${style}" ${legacy?'data-legacy title="既存の業務操作画面で確認"':'data-action="'+escape(act)+'"'}>${escape(text)}${legacy?' ↗':''}</button>`;
const moneyBar=label=>`<div class="money-bar"><button class="lightbtn" data-money-toggle aria-pressed="false">${escape(label||'この画面の金額を表示')}</button><small>30秒・画面切替・非アクティブで再非表示</small></div>`;
let quoteMonitorEnabled=false,commercialOriginalsRead=false;
let session=null,cases=[],selected=null,tab='overview',selectionEpoch=0,listEpoch=0,detail={},gallery=null,features=[],listError=null,attentionError=null;
const requests=new Set();
class ReadFailure extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}
function failText(error){return error.status===403?'403 / 認証・ACL未解決':error.status===401?'認証・ACLまたは既存商務参照が未解決':error.code==='incomplete_result'?'一覧を完全に取得できませんでした':'読取に失敗しました';}
function errorBlock(error,label=''){
  return `<div class="read-error" role="status">${escape(label)} ${escape(failText(error))}<small>取得不能を「なし」「未入金」「確認済み」と扱いません。再取得は明示操作です。</small></div>`;
}
function abortRequests(){for(const controller of requests)controller.abort();requests.clear();}
async function api(url,{blob=false}={}){
  if(!session)throw new ReadFailure('login_required',401);
  if(session.expires_at&&session.expires_at*1000<=Date.now()){
    try{session=await workspaceAuth.current();}catch{signOut(false);throw new ReadFailure('login_required',401);}
  }
  const controller=new AbortController();requests.add(controller);
  let timer=setTimeout(()=>controller.abort(),25000);
  try{
    const response=await fetch(readUrl(url),{method:'GET',cache:'no-store',headers:{authorization:'Bearer '+session.access_token},signal:controller.signal});
    if(!response.ok){let data;try{data=await response.json();}catch{}const code=data?.code||'read_unavailable';if(response.status===401)clearAssets();if(requiresReauthentication(code,response.status))signOut(false);throw new ReadFailure(code,response.status);}
    if(blob){
      const value=await response.blob(),proof=response.headers.get('X-PA-Attachment-Identity');
      const disposition=response.headers.get('Content-Disposition');if(disposition)value.originalFilename=downloadFilename(disposition);
      const digest=response.headers.get('X-PA-Original-SHA256');if(digest)value.originalSha256=digest;
      // Sanitized proof flags only, retained with the existing session Blob.
      if(proof){try{value.identityProof=JSON.parse(proof);}catch{}}
      return value;
    }
    const data=await response.json();if(data.ok!==true)throw new ReadFailure('invalid_read_response',503);return data.result;
  }catch(error){if(error.name==='AbortError')throw new ReadFailure('read_timeout_or_cancelled',503);throw error;}
  finally{clearTimeout(timer);requests.delete(controller);}
}
let privateAssets=null,previewScope=null,quoteHistory=null,simpleAdoptionEnabled=false;
function clearAssets(){replyDocuments.clear();quoteHistory?.dispose();quoteHistory=null;previewScope?.dispose();previewScope=null;privateAssets?.clear();privateAssets=null;}
function viewPreviewScope(){
  if(previewScope&&!previewScope.current()){previewScope.dispose();previewScope=null;}
  if(!previewScope){const id=selected,epoch=selectionEpoch,viewTab=tab;
    previewScope=createPreviewScope({expiresAt:session?.expires_at?session.expires_at*1000:Infinity,isCurrent:()=>!!session&&selected===id&&selectionEpoch===epoch&&tab===viewTab});
  }
  return previewScope;
}
function assetRoute(id,item){return item.asset_kind==='mail'?(item.read_route==='sent-estimate'?'/data/sent-estimate-attachment/':'/data/mail-attachment/')+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id):item.asset_kind==='document'?'/data/document/'+id+'/'+item.asset_id:'/data/material/'+id+'/'+item.asset_kind+'/'+item.asset_id;}
function caseAssets(){
  if(!privateAssets){const id=selected,epoch=selectionEpoch,token=session?.access_token;
    privateAssets=createPrivateAssets({isCurrent:()=>selected===id&&selectionEpoch===epoch&&!!session,
      authorize:async()=>{let value;try{value=await workspaceAuth.current();}catch{signOut(false);throw new ReadFailure('login_required',401);}if(value?.access_token!==token){clearAssets();throw new ReadFailure('login_required',401);}},
      requestDownload:item=>item.asset_kind==='document'||item.download_ref?commercial.downloadOriginal({case_id:id,...(item.download_ref?{contract_id:item.download_ref.id}:{document_id:item.asset_id})}):api(assetRoute(id,item).replace('/data/','/data/download/'),{blob:true}),
      requestBlob:item=>commercialOriginalsRead&&(item.asset_kind==='document'||item.asset_kind==='receipt')?commercial.downloadOriginal({case_id:id,...(item.download_ref?{contract_id:item.download_ref.id}:{document_id:item.asset_id})}):api(assetRoute(id,item),{blob:true})});
  }
  privateAssets.commercialOriginals=commercialOriginalsRead;return privateAssets;
}
function current(){return cases.find(c=>c.id===selected)||null;}
function getRows(surface){const state=detail[surface];return state?.state==='ready'?state.value:null;}
function readBlock(surface,label,render){
  const state=detail[surface];
  if(!state||state.state==='loading')return `<div class="load-state">${escape(label)}を取得中…</div>`;
  if(state.state==='error')return errorBlock(state.error,label);
  return render(state.value);
}
function rowsHtml(rows,{title,body,time,kind}={}){
  if(!rows.length)return '<div class="empty-state">保存済み記録なし</div>';
  return '<div class="rows">'+rows.map(row=>`<article class="record"><div class="record-head"><strong>${tx(title?.(row)||'保存済み記録')}</strong><span class="record-date">${escape(date(time?.(row)))}</span></div>${kind?'<div class="stage-info">'+tx(kind(row))+'</div>':''}${body?'<div class="record-body">'+tx(body(row))+'</div>':''}</article>`).join('')+'</div>';
}
function fact(label,value){return `<div class="fact"><span>${escape(label)}</span><b>${tx(value||'未提供')}</b></div>`;}
function pair(label,value){return `<div class="label-pair"><span>${escape(label)}</span><b>${tx(value||'未提供')}</b></div>`;}
const bodyView=createMailBodyView({request:(id,row)=>api('/data/mail-body/'+id+'/'+encodeURIComponent(row.gmail_message_id)),isAuthenticated:()=>!!session});
const workflowRequest=createWorkflowRequest(async()=>{const value=await workspaceAuth.current();if(!session||value?.access_token!==session.access_token)throw Error('login_required');return value;});
const portalStatuses=new Map();
function portalStatus(id,text){portalStatuses.set(id,text);if(selected===id){const host=$('portal-candidate-status');if(host)host.textContent=text;}}
const portalBridge=createPortalCandidateBridge({request:workflowRequest,isCurrent:id=>!!session&&selected===id,onStatus:portalStatus});
const caseMail=createCaseMailComposer({request:createCaseMailRequest(async()=>{const value=await workspaceAuth.current();if(!session||value?.access_token!==session.access_token)throw Error('login_required');return value;},()=>signOut(false)),getCase:()=>session?current():null,getMessages:()=>getRows('messages')||[],getFiles:()=>materialItems(),readFile:async item=>(await caseAssets().record(item,{fresh:true})).blob,isAuthenticated:()=>!!session&&(!session.expires_at||session.expires_at*1000>Date.now()),onSent:async id=>{if(selected!==id)return;replyDocuments.clear();const epoch=selectionEpoch;const attentionRows=await api('/data/attention');if(selected!==id||selectionEpoch!==epoch)return;const attentionRow=attentionRows.find(row=>row.inquiry_id===id);cases=cases.map(c=>c.id===id?{...c,attention:attentionRow||null,attentionLoaded:true}:c);renderList();await Promise.all([loadSurface('messages','/data/mail/'+id,epoch),loadSurface('deliveries','/data/case/'+id+'/deliveries',epoch),loadSurface('audit','/data/case/'+id+'/audit',epoch)]);if(selected===id&&selectionEpoch===epoch&&['messages','deliveries'].some(name=>detail[name]?.state!=='ready'))throw Error('reply_history_unconfirmed');}});
const quoteMonitor=createQuoteMonitor({read:api,getSession:async()=>{session=await workspaceAuth.current();return session;},onAuthFailure:()=>signOut(false),onUpdate:()=>{if(session&&cases.length)renderList();}});
const commercial=createCommercialWorkflows({getCase:()=>session?current():null,getSession:async()=>{session=await workspaceAuth.current();return session;},onAuthFailure:()=>signOut(false),onChanged:async id=>{if(selected===id)await loadSurface('commercial','/data/commercial/'+id,selectionEpoch);}});
const trash=createCaseTrash({getCase:()=>session?current():null,request:createCaseTrashRequest(async()=>{const value=await workspaceAuth.current();if(!session||value?.access_token!==session.access_token)throw Error('login_required');return value;},()=>signOut(false)),onTrashed:async saved=>{await refresh();if(cases.some(c=>c.id===saved.inquiry_id)||listError){openInfo('ゴミ箱の保存結果','<p>保存応答は受領しましたが、一覧の反映は未確認です。再移動しないでください。</p>');return;}openInfo('ゴミ箱へ移動しました','<p>'+escape(saved.inquiry_number)+' / 通常一覧からの除外を読戻し確認しました。記録は保持しています。</p>');}});
const replyDocuments=createReplyDocumentView({getCase:()=>session?current():null,requestReply:workflowRequest,requestCommercial:(action,input)=>commercial.replyDocument(action,input),readBody:(id,row)=>api('/data/mail-body/'+id+'/'+encodeURIComponent(row.gmail_message_id))});
const discovery=createCandidateMailView({read:api,getSession:async()=>{session=await workspaceAuth.current();return session;},isCurrent:id=>!!session&&selected===id&&tab==='conversation',onIndexed:async id=>{if(selected===id){const before=new Set((getRows('messages')||[]).map(row=>row.gmail_message_id));const epoch=selectionEpoch;await loadSurface('messages','/data/mail/'+id,epoch);if(selected===id&&selectionEpoch===epoch)await portalBridge.newlyIndexed(id,before,getRows('messages'));}}});
const caseNames=createCaseNameView();
let mailGalleries=[],orderDocuments=null;
function disposePreviews(){discovery.detach();quoteHistory?.unmount();orderDocuments?.dispose();orderDocuments=null;bodyView.detach();gallery?.dispose();gallery=null;for(const g of mailGalleries)g.dispose();mailGalleries=[];}
function clearDetail(){discovery.cancel();clearAssets();resetPrivacy();disposePreviews();detail={};central.replaceChildren();$('inspector').replaceChildren();}
function renderCounts(){
  const counts=reviewCounts(cases);
  $('global-unread').textContent=cases.length&&cases.some(c=>c.attentionLoaded)?String(counts.needsReview):'—';
  $('global-unread').title='保存済み顧客返信の未確認案件数。Gmail未読メール件数ではありません。';
  const c=current(),att=c?attention(c):null;$('tab-unread').textContent=att?.needsReview===true?'NEW':'';
  $('case-count').textContent=cases.length?'('+cases.length+')':'(—)';
  $('case-summary').textContent=listError?'一覧取得失敗':cases.length?`未確認案件 ${counts.needsReview}件${counts.unknown?' / 未取得・未登録 '+counts.unknown+'件':''}`:'案件未取得';
}
function options(select,values,label){
  const previous=select.value;select.replaceChildren(new Option(label,''));
  for(const [value,name]of values)select.append(new Option(name,value));select.value=previous;
}
function updateFilters(){
  options($('type-filter'),[...new Set(cases.map(c=>c.case_type).filter(Boolean))].sort().map(t=>[t,t==='PA_EVENT'?'PAイベント':t]),'すべての種別');
  options($('status-filter'),[...new Set(cases.map(displayStatus).filter(Boolean))].map(s=>[s,STATUS[s]||s]),'すべての状態');
  options($('year-filter'),[...new Set(cases.map(eventDate).filter(Boolean).map(x=>x.slice(0,4)))].sort().map(y=>[y,y+'年']),'すべての年');
  options($('step-filter'),STEPS.map((name,i)=>[String(i+1),(i+1)+' '+name]),'すべての工程');
}
function visibleCases(){return sortCases(filterCases(cases,{term:$('search').value,review:$('filter').value,type:$('type-filter').value,status:$('status-filter').value,year:$('year-filter').value,step:$('step-filter').value}),$('order').value);}
function renderList(){
  renderCounts();updateFilterSummary();if(listError){$('case-list').innerHTML=errorBlock(listError,'案件一覧');return;}
  const list=visibleCases();let month='',html='';
  for(const c of list){
    const d=eventDate(c),group=$('order').value==='event'?(d?d.slice(0,7):'開催日未定'):'';
    if(group&&group!==month){month=group;html+=`<div class="month">${escape(group.replace('-','年 '))}${d?'月':''}</div>`;}
    const a=attention(c),quoteStatus=quoteMonitor.get(c.id);html+=`<div class="quote-case-row"><button class="case ${c.id===selected?'selected':''}" data-case="${escape(c.id)}" aria-pressed="${c.id===selected}"><span class="caldate">${escape(shortDate(d))}<small>${escape(d?d.slice(0,4):'')}</small></span><span style="min-width:0"><span class="casename" title="${escape(privateText(c.event_name||'イベント名未設定'))}"><span class="case-name-track"><span>${tx(c.event_name||'イベント名未設定')}</span><span aria-hidden="true" hidden>${tx(c.event_name||'イベント名未設定')}</span></span></span><span class="caseline" style="display:block">${tx(c.organization_name||c.customer_name||c.contact_name||'顧客未設定')}</span>${a.label!==statusText(c)?'<span class="casefoot">'+(a.needsReview===true?'<span class="newdot" aria-label="顧客返信未確認"></span>':'')+'<span>'+escape(a.label)+'</span></span>':''}</span><span class="rightbadges"><span class="tiny ${statusColor(c)==='green'?'success':statusColor(c)==='amber'?'warning':'neutral'}">${escape(statusText(c))}</span>${['new','new_inquiry'].includes(c.status)||a.needsReview===true?'<span class="tiny new">NEW</span>':''}</span></button>${quoteStatus?.label?'<button type="button" class="quote-notice '+(quoteStatus.deferred?'deferred':'')+'" data-quote-case="'+escape(c.id)+'" title="'+escape(quoteStatus.checked_at?'最終確認 '+quoteStatus.checked_at:'変更見積の確認未完了')+'">'+escape(quoteStatus.label)+(quoteStatus.deferred?'・あとで確認':'')+'</button>':''}</div>`;
  }
  $('case-list').innerHTML=html||'<div class="empty-state">該当する案件はありません</div>';
  caseNames.mount($('case-list'));
  const closed=cases.filter(isClosedCase).length;
  document.querySelector('.asidebottom').innerHTML=`<span>表示 ${list.length} / ${cases.length}件</span><span>進行 ${cases.length-closed} / 完了等 ${closed}</span>`;
  if(quoteMonitorEnabled){const known=cases.filter(c=>quoteMonitor.get(c.id)),pending=known.filter(c=>quoteMonitor.get(c.id).state==='incomplete').length;document.querySelector('.asidebottom').insertAdjacentHTML('beforeend','<span>変更見積：保存結果 '+known.length+'/'+cases.length+'件・未確認 '+(pending+cases.length-known.length)+'件（自動検査4件まで）</span>');}
}
function renderHeader(){
  const c=current();$('case-ref').textContent=c?'受付 '+(c.inquiry_number||'番号未提供'):'CASE —';
  $('title').textContent=privateText(c?.event_name||'案件を選択');
  $('head-state').textContent=c?statusText(c):'未選択';$('head-state').className='pill '+(c?statusColor(c):'blue');
  $('head-meta').innerHTML=c?`<span>開催 <b>${tx(eventDate(c)||'未定')}</b></span><span>会場 <b>${tx(c.venue||'未設定')}</b></span>`:'';
  $('open-schedule').disabled=!c;
  const portal=$('open-portal');
  if(c){portal.href='/pa/cases/'+encodeURIComponent(c.id)+'/portal';portal.removeAttribute('aria-disabled');portal.title='既存の案件別管理者ポータルを新しいタブで開く';}
  else{portal.removeAttribute('href');portal.setAttribute('aria-disabled','true');}
  document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.disabled=!c;b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
  renderCounts();
}
function deliveryNotice(){
  const state=detail.deliveries;
  const policy='<p class="hint">全案件共通の安全ルール：配送UNKNOWNは自動再送せず停止します。</p>';
  if(!state||state.state==='loading')return '<div class="stage-info">この案件の配送記録を取得中…</div>'+policy;
  if(state.state==='error')return '<div class="read-error">この案件の配送記録を取得できません<small>UNKNOWNの有無は未確認です。</small></div>'+policy;
  const rows=state.value,unknown=rows.filter(deliveryUnknown);
  return (unknown.length?'<div class="notice">この案件の配送UNKNOWN: '+unknown.length+'件 / 再送停止'+unknown.map(row=>'<div>'+tx(row.message_type||'種別未提供')+' / '+tx(date(row.sent_at||row.requested_at))+' / 配送ID '+tx(row.id||'未提供')+'</div>').join('')+'</div>':'<div class="stage-info">取得した配送記録にUNKNOWNはありません<small>他の商務配送や未取得の記録は判定対象外です。</small></div>')+policy;
}
function renderInspector(){
  const c=current();if(!c){$('inspector').replaceChildren();return;}
  const commercial=detail.commercial;
  const state=commercial?.state==='ready'?commercial.value:null;
  $('inspector').innerHTML=`<section class="sidesection"><h3 class="sidehead">業務の進行状態</h3>${pair('見積',state?state.estimates?.length?state.estimates.length+'版':'保存済み記録なし':'未取得')}${pair('案件状態',statusText(c))}<p class="hint">${escape(statusBasis(c))}</p>${pair('請求',state?state.billings?.length?state.billings.length+'記録':'保存済み記録なし':'未取得')}${pair('入金',detail.payments?.state==='ready'?getRows('payments').length+'記録':'未取得')}</section><section class="sidesection"><h3 class="sidehead">保存済み新着状態</h3>${pair('顧客返信',attention(c).label)}<p class="hint">メール未読件数は提供されていません。選択・閲覧では確認状態を変更しません。</p></section>${deliveryNotice()}`;
}
function overview(c){
  const p=c.progress||{},a=attention(c),f=c.first_form_data||{};
  const next=p.next_action||p.next_action_memo||c.next_action||'次の対応は未登録';
  const step=Number(p.current_step),original=inquiryFields(c);
  return `<div class="inlinebtns"><button class="action quiet" data-case-trash>ゴミ箱へ移動</button></div><section class="group event-information"><h2 class="sectiontitle">イベント基本情報</h2><div class="facts">${fact('イベント名',c.event_name)}${fact('開催日',eventDate(c))}${fact('本番時間',p.confirmed_event_time||c.event_time)}${fact('会場',c.venue)}${fact('主催者',f.organizer_name||c.organization_name)}${fact('顧客',c.customer_name)}${fact('連絡担当者',c.contact_name||f.contact_name)}${fact('社内担当',p.assigned_to||p.owner_name||c.assigned_to)}${fact('電話番号',c.phone||f.contact_phone)}${fact('メール',c.email||f.contact_email)}</div></section>
  <section class="group inquiry-original"><h2 class="sectiontitle">お客様からの依頼内容</h2><p class="hint">問い合わせ受付の保存値を全文表示します。後日の変更は下の回答記録・やり取りで確認してください。</p>${original.length?original.map(o=>`<article class="request-field"><h3>${escape(o.label)}</h3><div class="request-original">${tx(o.value)}</div></article>`).join(''):'<div class="empty-state">問い合わせ原文は未提供</div>'}<details class="subsequent-requests"><summary>受付後の回答・追加依頼・変更記録</summary>${readBlock('responses','受付後の回答',rows=>rows.map(row=>`<article class="request-field"><time>${escape(date(row.submitted_at||row.responded_at||row.created_at))}</time>${['request_summary','additional_notes','notes','question_details'].filter(key=>row[key]).map(key=>`<h3>${escape(({request_summary:'依頼内容',additional_notes:'追加備考',notes:'備考',question_details:'確認事項'})[key])}</h3><div class="request-original">${tx(row[key])}</div>`).join('')||'<p class="hint">この回答に依頼本文の提供はありません。日程調整画面で回答を確認できます。</p>'}</article>`).join('')||'<div class="empty-state">取得した回答記録に保存値なし。追加メールはやり取りで確認してください。</div>')}</details></section>
  <section class="group"><h2 class="sectiontitle">問い合わせ添付資料 ${button('資料倉庫を開く','documents','quiet')}</h2>${detail.materials?.state==='error'?errorBlock(detail.materials.error,'問い合わせ添付のポータル索引'):detail.materials?.state!=='ready'?'<div class="load-state">添付索引を取得中…</div>':''}<div id="inquiry-attachment-grid" class="material-grid"></div><p class="hint">問い合わせ由来を保存記録から確認できる資料のみ表示。対応不明の資料は資料倉庫で確認できます。</p></section>
  <section class="group case-current"><h2 class="sectiontitle">現在の案件状態</h2><div class="stage-info"><strong>現在の案件状態：${escape(statusText(c))}</strong><p>${escape(statusBasis(c))}</p></div><div class="brief ${a.needsReview===true?'warn':''}"><div><span class="kicker">次に必要な対応</span><strong>${tx(next)}</strong><small>メール返信確認：${escape(a.label)}</small></div>${button('やり取りを確認','conversation','blue')}</div><p class="hint">${c.attention?.attention_state==='waiting_customer'?'顧客回答待ちは保存済みメール確認状態です。何への回答かはこの索引では未提供。契約の同意・成立状態とは別に確認します。':'案件・契約の状態とメール返信の確認状態は別の記録です。'}</p>${attentionError?errorBlock(attentionError,'新着状態'):''}</section>
  <details class="group internal-history"><summary>内部履歴・Gmail同期・旧14工程・監査</summary><details class="legacy-workflow"><summary>旧14工程の保存値：${Number.isInteger(step)&&step>0&&step<=14?step+' / 14（'+escape(STEPS[step-1])+'）':'未取得'}${p.is_on_hold?' / 保留':''}</summary><p class="hint">旧工程の位置は契約成立・入金・案件完了の証明ではありません。前の工程を完了と推定しません。</p><div class="workflow">${STEPS.map((name,i)=>`<span class="${step===i+1?'current':''}">${i+1} ${escape(name)}</span>`).join('')}</div></details><div class="case-delivery">${deliveryNotice()}</div><h2 class="sectiontitle">最近の動き ${button('履歴を表示 ›','history','quiet')}</h2>${readBlock('audit','監査履歴',rows=>rowsHtml(rows.slice(0,4),{title:r=>eventLabel(r.action),time:r=>r.occurred_at}))}</details>`;
}

function conversation(c){
  return `<div class="toolbar">${flag('purple','メール・やり取り')}${flag(attention(c).needsReview===true?'red':'blue',attention(c).label)}${button('確認済みにする','mark-read','quiet',true)}</div><div id="mail-discovery"></div><h2 class="sectiontitle">メール <small>保存済み情報 / 閲覧で既読にしません</small></h2>${readBlock('messages','メール索引',rows=>rows.length?'<div class="mail-list">'+newestMessages(rows).map(r=>{
    return mailRow(r,{dateText:date(mailDateValue(r)),isNew:messageAttention(r,c.attention,rows),headingActions:r.direction==='outbound'?'<button class="lightbtn" data-case-mail-message="'+escape(r.gmail_message_id)+'">顧客へ連絡</button>':''});
  }).join('')+'</div>':'<div class="empty-state">取得成功 / 保存済みメールなし</div>')}<details class="group"><summary>案内・配送記録</summary>${readBlock('deliveries','配送記録',rows=>rowsHtml(rows,{title:r=>r.subject||r.message_type,body:r=>deliveryUnknown(r)?'UNKNOWN / 再送停止':r.status||'状態未取得',time:r=>r.sent_at||r.failed_at||r.requested_at}))}</details><div class="inlinebtns" style="margin-top:10px">${button('メール作成・返信','case-mail-compose','quiet')}${button('Gmail同期','sync','quiet',true)}${button('未紐付けメール','unlinked','quiet',true)}</div><p class="hint">NEWは保存済みのメール別根拠がある場合のみ表示。添付は資料候補へ連携できます。採用・最新版切替・公開はOwnerが資料ポータルで判断します。</p>`;
}
function estimate(c){
  return button('メール作成','case-mail-compose','quiet')+moneyBar()+`${detail.commercial?.state==='error'?errorBlock(detail.commercial.error,'商務・原本'):''}${detail.messages?.state==='error'?errorBlock(detail.messages.error,'正式確認PDFのメール索引'):''}<section id="order-documents"></section><details class="group order-document-history" open><summary>見積・正式受注・変更承認の履歴</summary>
  <section class="group"><h2 class="sectiontitle">Gmail送信済み見積（過去履歴・正式登録未照合）</h2><p class="hint">期限切れを含む過去資料です。有効性は未確認。現行見積への登録・有効化は行いません。</p>${readBlock('sentEstimates','送信済み見積索引',value=>`<div id="sent-estimate-grid" class="material-grid"></div>${rowsHtml(value.messages||[],{title:r=>r.subject,time:r=>r.sent_at,body:r=>'宛先 '+addresses(r.to_addresses)})}${value.unknown?.length?'<div class="read-error">一部メールの対応不明 / '+value.unknown.length+'件</div>':''}`)}</section>
  <details class="group estimate-history"><summary>見積書の発行履歴・全版</summary>${readBlock('commercial','見積発行履歴',state=>{const estimates=state.estimates||[];return `<div class="tablewrap"><table class="table"><thead><tr><th>見積版 / 発行</th><th>金額</th><th>原本</th></tr></thead><tbody>${estimates.map(e=>`<tr><td>版 ${tx(e.revision_number)} / ${tx(date(e.issued_at))}</td><td>${escape(privateMoney(e.amount_minor,e.currency||'JPY'))}</td><td>${e.document_id?'原本参照あり':'原本参照未提供'}</td></tr>`).join('')||'<tr><td colspan="3">取得した正式登録見積は0件（Gmail送信履歴は上部）</td></tr>'}</tbody></table></div>`;})}<div id="estimate-history-grid" class="material-grid"></div></details>
  <details class="group formal-history"><summary>正式受注確認の発行・同意等の履歴</summary>${readBlock('commercial','正式確認履歴',state=>{const offers=Array.isArray(state.offers)?state.offers:null;return `${offers===null?'<div class="read-error">正式確認の発行記録は未取得</div>':offers.length?rowsHtml(offers,{title:o=>'版 '+o.version+' / 発行記録',body:o=>'有効期限（保存値） '+date(o.expires_at),time:o=>o.issued_at}):'<div class="empty-state">取得できた正式確認の発行記録は0件</div>'}<p class="hint">ここは正式確認の発行日時・期限の索引です。同意・契約成立記録の不存在を意味しません。同意状態・失効・配送結果はこの取得範囲では未確認です。</p>`;})}<div id="formal-document-history-grid" class="material-grid"></div></details></details><section id="commercial-actions" class="group"></section><p class="hint">${escape(statusBasis(c))}</p><div class="inlinebtns">${button('見積登録・送信','issue-estimate','quiet',true)}${button('正式受注発行','issue-contract','quiet',true)}${button('再送・失効','resend','quiet',true)}</div><p class="hint">商務取得不能時は「契約なし」「未送信」と判定しません。</p>`;
}

function invoice(){
  return moneyBar()+`<h2 class="sectiontitle">請求状態</h2><button class="action" data-invoice-dispatch>請求書を送付</button><p class="hint">共通のメール作成画面を開きます。添付は任意です。正式請求登録・請求書送付記録・契約額更新とは別です。</p>`+button('現行合意見積の証拠を参照','estimate')+readBlock('commercial','請求',s=>rowsHtml(s.billings||[],{title:b=>b.invoice_policy==='no_separate_invoice'?'請求書を別途発行しない':b.invoice_delivery_state||b.state||'請求記録',body:b=>'期限 '+(b.due_date||'未提供')+' / 支払予定 '+(b.customer_planned_payment_on||'未提供'),time:b=>b.created_at}))+`<div class="group"><h2 class="sectiontitle">保存済み入金記録</h2>`+readBlock('payments','入金記録',rows=>rows.length?'<div class="rows">'+rows.map(p=>`<article class="record">${pair('入金日',date(p.confirmed_at))}<div class="label-pair"><span>金額</span><b>${escape(privateMoney(p.amount,p.currency||'JPY'))}</b></div>${pair('支払方法',p.payment_method||'未提供')}</article>`).join('')+'</div>':'<div class="empty-state">取得成功 / 保存済み入金記録なし（未入金の判定ではありません）</div>')+`</div><div class="inlinebtns" style="margin-top:12px">${button('請求発行・入金更新','billing-write','quiet',true)}${button('案件完了','close-case','quiet',true)}</div>`;
}
function schedule(c){
  const p=c.progress||{};
  return `<div class="toolbar">${button('‹ 概要に戻る','overview','quiet')}${flag('amber','日程調整')}</div><div class="schedule-hero"><div><div class="kicker" style="color:var(--amber)">SCHEDULE COORDINATION</div><strong>${escape(statusText(c))}</strong></div></div><div class="facts">${fact('確保日',p.confirmed_event_date)}${fact('確保時間',p.confirmed_event_time)}${fact('予約確定',p.booking_confirmed_on)}${fact('確定状況',p.schedule_status||c.status)}</div><div class="group"><h2 class="sectiontitle">URL・期限・失効状態</h2>${readBlock('tokens','日程URL状態',rows=>{const latest=rows[0];return latest?pair('URL状態',scheduleState(latest))+pair('発行',date(latest.issued_at))+pair('期限',date(latest.expires_at))+pair('回答',date(latest.answered_at))+`<p class="hint">既存GETは秘密のURL tokenを返しません。URL再表示・発行・失効は無効です。</p>`:'<div class="empty-state">取得成功 / 保存済み日程URL記録なし</div>';})}</div><div class="group"><h2 class="sectiontitle">顧客回答</h2>${readBlock('responses','日程回答',rows=>rowsHtml(rows,{title:scheduleResponseLabel,body:r=>[r.respondent_name?'回答者 '+r.respondent_name:null,r.organization?'団体 '+r.organization:null,r.question_details?'確認事項 '+r.question_details:null,r.authority?'条件同意の権限 '+({yes:'ある',no:'ない',unknown:'分からない'}[r.authority]||r.authority):null,r.confirmation_name?'確認者 '+r.confirmation_name:null,r.terms_version?'規約版 '+r.terms_version:null,r.event_date,r.event_time,r.venue,r.request_summary,r.additional_notes,r.notes].filter(Boolean).join(' / '),time:r=>r.submitted_at||r.responded_at||r.created_at}))}</div><div class="group"><h2 class="sectiontitle">日程案内・確定通知</h2>${readBlock('deliveries','案内記録',rows=>rowsHtml(rows.filter(r=>/schedule|日程/i.test(r.message_type||'')),{title:r=>r.message_type,body:r=>deliveryUnknown(r)?'UNKNOWN / 再送停止':r.status,time:r=>r.sent_at||r.requested_at}))}</div><div class="inlinebtns" style="margin-top:12px">${button('リンク発行・失効','schedule-link','quiet',true)}${button('案内・確定送信','schedule-send','quiet',true)}</div>`;
}
function protectAudit(value,key=''){
  if(/amount|price|total|balance|subtotal|fee|cost|金額|請求額|見積額/i.test(key)&&value!==null&&value!==undefined)return typeof value==='number'||/^\d+(?:\.\d+)?$/.test(String(value))?privateMoney(Number(value)):privateText(value);
  if(/token|password|secret|authorization|credential|refresh/i.test(key))return '非表示';
  if(Array.isArray(value))return value.map(v=>protectAudit(v,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,protectAudit(v,k)]));
  return typeof value==='string'?privateText(value):value;
}
function history(){return moneyBar()+`<h2 class="sectiontitle">案件・工程・メール監査</h2>`+readBlock('audit','監査履歴',rows=>rowsHtml(rows,{title:r=>eventLabel(r.action),kind:r=>'監査識別子: '+r.action,body:r=>typeof r.details==='string'?r.details:JSON.stringify(protectAudit(r.details||{})),time:r=>r.occurred_at}));}
function materialItems(){
  return warehouseItems({materials:getRows('materials')||{},commercial:getRows('commercial')||{},messages:getRows('messages')||[],sentEstimates:getRows('sentEstimates')||{},inquiry:current()||{}});
}
function documents(){
  return `<h2 class="sectiontitle">全資料倉庫</h2><div class="files-controls"><input id="material-search" class="search" type="search" placeholder="ファイル名・登録元で検索" aria-label="資料名で検索"><select id="material-kind" aria-label="資料種別"><option value="">すべての種類</option></select><select id="material-source" aria-label="登録元"><option value="">すべての登録元</option></select><label>日時から <input type="date" id="material-from"></label><label>日時まで <input type="date" id="material-to"></label><span class="file-count" id="file-count"></span></div><p class="hint">全種類・全取得版を表示。最新登録版・ポータル現在版・契約上の有効版を区別します。原本を保存し直しません。</p>${['materials','commercial','messages','sentEstimates'].map(name=>detail[name]?.state==='error'?errorBlock(detail[name].error,({materials:'資料ポータル',commercial:'商務原本',messages:'Gmail添付',sentEstimates:'送信済み見積'})[name]):detail[name]?.state!=='ready'?'<div class="load-state">'+escape(name)+'索引を取得中…</div>':'').join('')}<div id="material-grid" class="material-grid"></div><p class="hint">資料種別はファイル名等による検索補助です。名称だけで同一原本・契約正本と判定しません。取得元の索引に含まれない資料は未収容です。</p>`;
}

function renderMailPreviews(){
  const id=selected,epoch=selectionEpoch,rows=getRows('messages')||[];
  for(const row of rows){
    const container=[...central.querySelectorAll('[data-message]')].find(n=>n.dataset.message===row.gmail_message_id);
    if(!container)continue;
    const items=mailAttachments(row),strip=container.querySelector('[data-attachments]');
    if(strip){
      const g=createMailAttachmentCarousel({previewActions:replyDocuments.previewActions,assets:caseAssets(),previewScope:viewPreviewScope(),isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='conversation',requestBlob:item=>api('/data/mail-attachment/'+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id),{blob:true})});
      mailGalleries.push(g);g.mount(strip,items);
    }
    bodyView.mount(container,id,row,()=>selected===id&&selectionEpoch===epoch&&tab==='conversation');
  }
}
function mountGallery(target,items,track=true){
  const id=selected,epoch=selectionEpoch,viewTab=tab;
  const g=createGallery({previewActions:replyDocuments.previewActions,assets:caseAssets(),previewScope:viewPreviewScope(),isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab===viewTab,requestBlob:item=>api(item.asset_kind==='mail'?(item.read_route==='sent-estimate'?'/data/sent-estimate-attachment/':'/data/mail-attachment/')+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id):item.asset_kind==='document'?'/data/document/'+id+'/'+item.asset_id:'/data/material/'+id+'/'+item.asset_kind+'/'+item.asset_id,{blob:true})});
  if(track)mailGalleries.push(g);g.mount(target,items,{warehouse:true});return g;
}
function renderGallery(){
  gallery?.dispose();
  const items=materialItems();
  for(const [id,values]of [['material-kind',items.map(d=>d.kind)],['material-source',items.map(d=>d.source)]]){
    const el=$(id);if(el.options.length===1)for(const value of [...new Set(values)])el.append(new Option(id==='material-source'?({portal:'資料ポータル',gmail:'Gmail添付',commercial:'商務原本',intake:'問い合わせ添付'})[value]||value:value,value));
  }
  const filtered=filterWarehouse(items,{term:$('material-search').value,kind:$('material-kind').value,source:$('material-source').value,from:$('material-from').value,to:$('material-to').value});
  $('file-count').textContent='表示 '+filtered.length+' / 取得索引 '+items.length+'資料'+(['materials','commercial','messages','sentEstimates'].some(n=>detail[n]?.state==='error')?' / 一部未取得':'');
  gallery=mountGallery($('material-grid'),filtered,false);
  for(const id of ['material-search','material-kind','material-source','material-from','material-to'])$(id)[id==='material-search'?'oninput':'onchange']=()=>{resetPrivacy();renderGallery();};
}

function openLegacy(){if(current())window.open(legacyUrl(selected), '_blank', 'noopener,noreferrer');}
function render(){
  resetPrivacy();if(previewScope&&!previewScope.current()){previewScope.dispose();previewScope=null;}disposePreviews();renderHeader();renderInspector();
  const c=current();if(!c){central.innerHTML='<div class="empty-state">案件を選択すると、保存済みの実案件情報を表示します。</div>';return;}
  const html=({overview,conversation,estimate,invoice,documents,history,schedule}[tab]||overview)(c);
  central.innerHTML=(html.includes('PRIVATE_MONEY_')&&!html.includes('data-money-toggle')?moneyBar():'')+html;
  central.insertAdjacentHTML('beforeend','<div class="inlinebtns"><button class="action quiet" data-legacy>既存の業務操作を開く ↗</button></div>');
  if(tab==='documents')renderGallery();
  if(['estimate','documents'].includes(tab)&&!detail.sentEstimates)loadSurface('sentEstimates','/data/sent-estimates/'+selected,selectionEpoch);
  if(tab==='conversation'){renderMailPreviews();discovery.mount(selected);const host=document.createElement('p');host.id='portal-candidate-status';host.setAttribute('role','status');host.textContent=portalStatuses.get(selected)||'';const recheck=document.createElement('button');recheck.type='button';recheck.className='lightbtn';recheck.textContent='索引済み添付を再照合（最大20通）';recheck.dataset.portalRecheck='';central.prepend(host,recheck);}
  const items=materialItems();
  if(tab==='overview')mountGallery($('inquiry-attachment-grid'),inquiryAttachmentItems(items));
  if(tab==='estimate'){
    const id=selected,epoch=selectionEpoch;
    orderDocuments=createOrderDocuments({host:$('order-documents'),previewScope:viewPreviewScope(),isCurrent:()=>!!session&&selected===id&&selectionEpoch===epoch&&tab==='estimate',deferQuote:quoteMonitorEnabled,mountFallback:(host,kind)=>mountGallery(host,items.filter(d=>kind==='formal'?d.kind==='正式受注確認書'&&d.mime_type==='application/pdf':d.source==='commercial'&&d.kind==='見積書'&&d.latest_state==='最新発行版'))});
    commercial.mount($('commercial-actions'),orderDocuments);
    if(!simpleAdoptionEnabled)mountGallery($('estimate-history-grid'),items.filter(d=>d.kind==='見積書'&&d.source!=='gmail'));
    else{quoteHistory ||= createQuoteHistory({caseId:id,assets:caseAssets(),isCurrent:()=>!!session&&selected===id&&selectionEpoch===epoch,previewScope:viewPreviewScope(),monitor:quoteMonitor,onAdopt:c=>commercial.adoptQuote(c),registrationActions:replyDocuments.registrationActions});quoteHistory.mount($('estimate-history-grid'),items.filter(d=>d.kind==='見積書'&&(d.source==='commercial'||d.source_direction==='outbound')));$('sent-estimate-grid')?.closest('section').setAttribute('hidden','');}
    mountGallery($('formal-document-history-grid'),items.filter(d=>d.kind==='正式受注確認書'&&d.mime_type==='application/pdf'));
    if(!simpleAdoptionEnabled&&$('sent-estimate-grid')){const id=selected,epoch=selectionEpoch;
      const g=createGallery({previewActions:replyDocuments.previewActions,assets:caseAssets(),previewScope:viewPreviewScope(),isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='estimate',requestBlob:item=>api((item.read_route==='sent-estimate'?'/data/sent-estimate-attachment/':'/data/mail-attachment/')+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id),{blob:true})});
      mailGalleries.push(g);g.mount($('sent-estimate-grid'),items.filter(d=>d.source==='gmail'&&d.kind==='見積書'&&d.source_direction==='outbound'),{compact:true,showSource:true});
    }
  }
}
async function loadSurface(name,url,epoch,reader=null){
  detail[name]={state:'loading'};
  try{const value=await (reader?reader():api(url));if(epoch!==selectionEpoch)return;detail[name]={state:'ready',value};}
  catch(error){if(epoch!==selectionEpoch)return;detail[name]={state:'error',error};}
  if(epoch===selectionEpoch)render();
}
async function selectCase(id,initialTab='overview'){
  if(!cases.some(c=>c.id===id))return;
  if(!trash.beforeLeave()||!await caseMail.beforeLeave())return;
  if(!await commercial.beforeLeave())return;
  commercial.clear();
  portalBridge.cancel();++selectionEpoch;abortRequests();clearDetail();selected=id;tab=initialTab;const epoch=selectionEpoch;
  renderList();render();
  // No mark-read, Gmail sync, lazy contract PDF generation or token issuance here.
  await Promise.all(['tokens','responses','audit','deliveries','payments','links'].map(name=>loadSurface(name,'/data/case/'+id+'/'+name,epoch)).concat([loadSurface('messages','/data/mail/'+id,epoch),loadSurface('commercial','/data/commercial/'+id,epoch,commercialOriginalsRead?()=>commercial.originalIndex(id):null),loadSurface('materials','/data/materials/'+id,epoch)]));
}
async function refresh(){
  if(!trash.beforeLeave()||!await caseMail.beforeLeave())return;
  if(!await commercial.beforeLeave())return;
  commercial.clear();
  quoteMonitor.clear();portalBridge.cancel();++selectionEpoch;const epoch=++listEpoch;abortRequests();clearDetail();selected=null;cases=[];listError=null;attentionError=null;
  renderList();render();$('case-list').innerHTML='<div class="load-state">案件一覧を取得中…</div>';$('refresh-cases').disabled=true;
  try{
    const attPromise=api('/data/attention').then(value=>({value}),error=>({error}));
    const list=await api('/data/cases');if(epoch!==listEpoch)return;
    commercialOriginalsRead=list.commercial_originals_read===true;simpleAdoptionEnabled=list.quote_adoption_simple===true;commercial.setSimpleAdoption(simpleAdoptionEnabled);quoteMonitorEnabled=list.quote_monitor===true;commercial.setQuoteMonitor(quoteMonitorEnabled?quoteMonitor:null);
    const map=new Map(list.progress.map(p=>[p.inquiry_id,p]));
    cases=list.cases.map(c=>({...c,progress:map.get(c.id)||null,attention:null,attentionLoaded:false}));
    updateFilters();renderList();render();
    if(quoteMonitorEnabled)void quoteMonitor.start(cases.map(c=>({...c,monitorActive:!isClosedCase(c)})));
    const attentionReady=attPromise.then(att=>{if(epoch!==listEpoch)return;attentionError=att.error||null;const indexed=new Map((att.value||[]).map(a=>[a.inquiry_id,a]));cases=cases.map(c=>({...c,attention:indexed.get(c.id)||null,attentionLoaded:!att.error}));renderList();renderCounts();});
    const requested=new URL(location.href).searchParams.get('case');if(requested&&cases.some(c=>c.id===requested))await selectCase(requested);
    await attentionReady;
  }catch(error){if(epoch!==listEpoch)return;cases=[];listError=error;renderList();render();}
  finally{if(epoch===listEpoch)$('refresh-cases').disabled=false;}
}
async function setTab(name){
  if(!['overview','conversation','estimate','invoice','documents','history','schedule'].includes(name)||!current())return;
  if(name!==tab){if(!trash.beforeLeave()||!await caseMail.beforeLeave())return;
  if(!await commercial.beforeLeave())return;commercial.clear();if(tab==='conversation')discovery.cancel();}
  resetPrivacy();tab=name;render();central.scrollTop=0;
  document.querySelectorAll('[data-top]').forEach(b=>b.classList.toggle('active',b.dataset.top==='files'?name==='documents':b.dataset.top==='inbox'?name==='conversation':!['documents','conversation'].includes(name)));
  if(name==='conversation')discovery.check(selected);
}
function openDrawer(){resetPrivacy();$('drawer-wrap').classList.add('open');$('feature-search').value='';renderFeatures();$('drawer-close').focus();}
function renderFeatures(){
  const q=$('feature-search').value.toLocaleLowerCase('ja'),place=$('feature-place').value,status=$('feature-status').value;
  const shown=features.filter(f=>(!q||(f.id+' '+f.name+' '+f.scope).toLocaleLowerCase('ja').includes(q))&&(!place||f.place===place)&&(!status||f.status===status));
  $('feature-summary').textContent=`表示 ${shown.length}件 / 全 ${features.length}件`;
  $('feature-list').innerHTML=shown.map(f=>`<div class="feature"><span class="fid">${escape(f.id)}</span><span><strong>${escape(f.name)}</strong><small>${escape(f.place)} / <span class="features-status ${f.status==='新UIから利用可能'?'available':f.status==='認証・ACL未解決'?'acl':f.status==='内部機能'?'internal':''}">${escape(f.status)}</span></small><div class="feature-detail">${escape(f.scope)}</div></span><button data-feature="${escape(f.id)}">対応を見る ›</button></div>`).join('');
}
async function featureJump(id){const f=features.find(x=>x.id===id);if(!f)return;$('drawer-wrap').classList.remove('open');if(['PAUI-D-001','PAUI-D-002','PAUI-E-001','PAUI-E-003','PAUI-E-004'].includes(id)&&current()){await setTab('estimate');return;}if(current())setTab(f.target||'overview');openInfo(f.id+' '+f.name,`<button class="action quiet" data-legacy ${current()?'':'disabled'}>既存の業務操作を開く ↗</button><p>${escape(f.status)} / ${escape(f.scope)}</p><p class="hint">既存source：${escape(f.source)}<br>既存経路：${escape(f.api)}<br>機能実証：${escape(f.validation)}</p>`);}
function openInfo(title,html){resetPrivacy();$('modal-title').textContent=title;$('modal-content').innerHTML=html;$('modal-wrap').classList.add('open');$('modal-close-top').focus();}
function signOut(callAuth=true){trash.clear();quoteMonitor.clear();commercial.clear();caseMail.clear();portalBridge.clear();portalStatuses.clear();discovery.cancel();bodyView.clear();++selectionEpoch;++listEpoch;abortRequests();clearDetail();session=null;cases=[];selected=null;renderList();render();$('workspace').hidden=true;$('login-screen').hidden=false;$('sign-out').hidden=true;$('login-form').reset();$('login-status').textContent=callAuth?'ログアウト処理中…':'セッションまたは管理者権限を確認できません。再認証してください。';if(callAuth)workspaceAuth.logout().then(()=>{$('login-status').textContent='ログアウトしました。';}).catch(()=>{$('login-status').textContent='ログアウトを完了できませんでした。通信状態を確認して再実行してください。';});}

const extra=document.createElement('div');extra.className='search-extra';extra.innerHTML='<select id="type-filter" aria-label="案件種別"><option value="">すべての種別</option></select><select id="status-filter" aria-label="案件状態"><option value="">すべての状態</option></select><select id="year-filter" aria-label="開催年"><option value="">すべての年</option></select><select id="step-filter" aria-label="工程"><option value="">すべての工程</option></select>';
$('advanced-filters').append(extra);
const filterIds=['order','filter','type-filter','status-filter','year-filter','step-filter'];
function updateFilterSummary(){
  const labels=filterIds.filter(id=>$(id).value!==({order:'event',filter:'active'}[id]||'')).map(id=>$(id).selectedOptions[0]?.textContent||'');
  $('filter-summary').textContent=labels.length?'適用中: '+labels.join(' / '):'表示対象: 進行中';
}
function toggleFilters(open){$('advanced-filters').hidden=!open;$('toggle-filters').setAttribute('aria-expanded',String(open));$('toggle-filters').textContent=open?'詳細条件 ▲':'詳細条件 ▼';}
$('toggle-filters').onclick=()=>toggleFilters($('advanced-filters').hidden);
const reset=document.createElement('button');reset.className='lightbtn';reset.textContent='条件をリセット';reset.onclick=()=>{for(const id of filterIds)$(id).value=({order:'event',filter:'active'}[id]||'');$('search').value='';renderList();};
const close=document.createElement('button');close.className='lightbtn';close.textContent='詳細条件を閉じる ▲';close.onclick=()=>{toggleFilters(false);$('toggle-filters').focus();};
$('advanced-filters').append(reset,close);
for(const id of filterIds){const label=document.createElement('label');label.textContent=({order:'並び順',filter:'表示対象','type-filter':'案件種別','status-filter':'案件状態','year-filter':'開催年','step-filter':'工程'})[id];$(id).before(label);label.append($(id));}
const featureStatus=document.createElement('select');featureStatus.id='feature-status';featureStatus.setAttribute('aria-label','機能対応区分');featureStatus.append(new Option('全対応区分',''));for(const s of ['新UIから利用可能','現時点で無効','認証・ACL未解決','内部機能'])featureStatus.append(new Option(s,s));document.querySelector('.drawer-filters').append(featureStatus);
fetch('/pa-ui/features.json',{cache:'no-store'}).then(r=>r.json()).then(data=>{features=data;$('feature-count').textContent=data.length;options($('feature-place'),[...new Set(data.map(f=>f.place))].sort().map(p=>[p,p]),'全配置');}).catch(()=>{$('feature-count').textContent='未取得';});
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,submit=form.querySelector('button'),data=new FormData(form);submit.disabled=true;$('login-status').textContent='既存Auth・管理者ACLを確認中…';
  try{
    session=await workspaceAuth.login(String(data.get('email')),String(data.get('password')));form.reset();$('login-screen').hidden=true;$('workspace').hidden=false;$('sign-out').hidden=false;await refresh();
  }catch{$('login-status').textContent='ログインできません。既存管理者認証・閲覧権限を確認してください。';form.elements.password.value='';}
  finally{submit.disabled=false;}
});
document.addEventListener('click',async e=>{
  if(e.target.closest('[data-case-trash]')){if(await caseMail.beforeLeave()&&await commercial.beforeLeave())trash.open();return;}
  const contact=e.target.closest('[data-case-mail-message]');if(contact){const row=(getRows('messages')||[]).find(m=>m.gmail_message_id===contact.dataset.caseMailMessage);if(row)await caseMail.open('contact',row);return;}
  if(e.target.closest('[data-invoice-dispatch]')){await caseMail.open('invoice');return;}
  if(e.target.closest('[data-action="case-mail-compose"]')){await caseMail.open('new');return;}
  const replying=e.target.closest('[data-reply-message]');if(replying){const row=(getRows('messages')||[]).find(m=>m.gmail_message_id===replying.dataset.replyMessage);if(row)await caseMail.open('reply',row);return;}
  const recheck=e.target.closest('[data-portal-recheck]');if(recheck){const id=selected;recheck.disabled=true;portalBridge.recheck(id,getRows('messages')).catch(()=>{}).finally(()=>{if(recheck.isConnected)recheck.disabled=false;});return;}
  const linking=e.target.closest('[data-portal-message]');if(linking){const id=selected,messageId=linking.dataset.portalMessage;if(!(getRows('messages')||[]).some(m=>m.gmail_message_id===messageId))return;linking.disabled=true;portalBridge.link(id,messageId,{threadId:getRows('messages').find(m=>m.gmail_message_id===messageId)?.gmail_thread_id}).catch(()=>{}).finally(()=>{if(linking.isConnected)linking.disabled=false;});return;}
  if(e.target.closest('[data-legacy]')){openLegacy();return;}
  const quote=e.target.closest('[data-quote-case]');if(quote){if(quote.dataset.quoteCase===selected)await setTab('estimate');else await selectCase(quote.dataset.quoteCase,'estimate');const target=central.querySelector('.quote-candidate-controls')||$('order-documents');if(target){target.tabIndex=-1;target.focus();}return;}
  const c=e.target.closest('[data-case]');if(c){selectCase(c.dataset.case);return;}
  const t=e.target.closest('[data-tab]');if(t){setTab(t.dataset.tab);return;}
  const feature=e.target.closest('[data-feature]');if(feature){featureJump(feature.dataset.feature);return;}
  const a=e.target.closest('[data-action]');if(a&&!a.disabled){setTab(a.dataset.action);return;}
  const top=e.target.closest('[data-top]');if(top)setTab(top.dataset.top==='files'?'documents':top.dataset.top==='inbox'?'conversation':'overview');
});
for(const id of ['search','order','filter','type-filter','status-filter','year-filter','step-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{resetPrivacy();renderList();});
$('refresh-cases').onclick=refresh;$('sign-out').onclick=async()=>{if(trash.beforeLeave()&&await caseMail.beforeLeave()&&await commercial.beforeLeave())signOut();};$('open-schedule').onclick=()=>setTab('schedule');$('open-portal').onclick=()=>resetPrivacy();
$('new-case').disabled=false;$('new-case').title='既存の登録画面を開く';$('new-case').onclick=()=>window.open('/pa-admin-legacy.html','_blank','noopener,noreferrer');
$('open-more').onclick=()=>openInfo('その他の管理機能',`<div class="inlinebtns"><button class="action quiet" id="more-features">103機能の対応状況</button></div><button class="action quiet" data-legacy>既存の業務操作を開く ↗</button><p class="hint">更新・送信・発行は既存画面で内容を確認して操作してください。</p>`);
document.addEventListener('click',e=>{if(e.target.closest('#more-features')){$('modal-wrap').classList.remove('open');openDrawer();}});
$('features-trigger').onclick=openDrawer;$('feature-search').oninput=renderFeatures;$('feature-place').onchange=renderFeatures;$('feature-status').onchange=renderFeatures;
$('drawer-close').onclick=()=>{$('drawer-wrap').classList.remove('open');$('features-trigger').focus();};
function closeInfo(){$('modal-wrap').classList.remove('open');resetPrivacy();}
$('modal-close').onclick=closeInfo;$('modal-close-top').onclick=closeInfo;
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('drawer-wrap').classList.remove('open');closeInfo();}});
window.addEventListener('pagehide',()=>{trash.clear();discovery.cancel();commercial.clear();caseMail.clear();portalBridge.clear();bodyView.clear();session=null;abortRequests();clearDetail();});
render();

workspaceAuth.subscribe?.((event,value)=>{if(session&&value?.access_token!==session.access_token){discovery.cancel();quoteMonitor.clear();commercial.clear();clearAssets();}if(event==='TOKEN_REFRESHED'&&session)session=value;if(event==='SIGNED_OUT')signOut(false);});
window.addEventListener('focus',async()=>{if(!session)return;const epoch=listEpoch;try{const restored=await workspaceAuth.restore();if(epoch!==listEpoch||!session)return;if(!restored)signOut(false);else session=restored;}catch{if(epoch===listEpoch&&session)signOut(false);}});
workspaceAuth.restore().then(async restored=>{if(!restored)return;session=restored;$('login-screen').hidden=true;$('workspace').hidden=false;$('sign-out').hidden=false;await refresh();}).catch(()=>{$('login-status').textContent='既存セッションを確認できません。管理者でログインしてください。';});
