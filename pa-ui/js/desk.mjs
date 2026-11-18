import {workspaceAuth, readUrl, legacyUrl} from './integration.mjs';
import {requiresReauthentication} from './auth-session.mjs';
import {privateText,privateMoney,privateFrame,releasePrivateFrame,setPrivateAmount,readPrivateAmount,releasePrivateAmount,resetPrivacy} from './pa-workspace-privacy.mjs';
import {createGallery,previewError} from './gallery.mjs';
import {createMailBodyView} from './mail-body-view.mjs';
import {createMailHtmlView} from './mail-html-view.mjs';
import {createCaseBasicsEditor} from './case-basics.mjs';
import {createCaseCalendar} from './case-calendar.mjs';
import {createManualIntake} from './manual-intake.mjs';
import {createCaseNameView} from './case-name-view.mjs';
import {createMailAttachmentCarousel} from './mail-carousel.mjs';
import {createThreadLink} from './manual-thread-link.mjs';
import {createReplyState,createAttemptStore} from './reply-state.mjs';
import {createReplyComposer} from './reply-composer.mjs';
import {createIntakeComposer,followUpType} from './intake-composer.mjs';
const intakeCompletions = new Map();
import {createCaseMailSync} from './case-mail-sync.mjs';
import {savedExcerpt,mailAttachments,messageAttention} from './mail-model.mjs';
import {conversationTimeline,customerInbound,deliveryDate,deliveryLabel,deliveryOutcome,timelineDate} from './conversation-timeline.mjs';
import {escape,STATUS,STEPS,statusText,statusColor,displayStatus,paymentClosureBasis,eventDate,sortCases,filterCases,attention,reviewCounts,scheduleState,scheduleResponseLabel,flattenMaterials,commercialMaterials,isClosedCase} from './model.mjs';

const $=id=>document.getElementById(id),central=$('detail-card');
const tx=value=>escape(privateText(String(value??'未提供')));
const addresses=v=>Array.isArray(v)?v.join(', '):String(v||'未取得');
const date=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未提供';return new Date(value).toLocaleString('ja-JP');};
const shortDate=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未定';return new Date(value).toLocaleDateString('ja-JP',{month:'2-digit',day:'2-digit'});};
const flag=(type,text)=>`<span class="pill ${escape(type)}">${tx(text)}</span>`;
const button=(text,act,style='',legacy=false)=>legacy&&passiveMail?'':`<button class="action ${style}" ${legacy?'data-legacy title="既存の業務操作画面で確認"':'data-action="'+escape(act)+'"'}>${escape(text)}${legacy?' ↗':''}</button>`;
const moneyBar=label=>`<div class="money-bar"><button class="lightbtn" data-money-toggle aria-pressed="false">${escape(label||'この画面の金額を表示')}</button><small>30秒・画面切替・非アクティブで再非表示</small></div>`;
let session=null,authEpoch=0,cases=[],selected=null,tab='overview',selectionEpoch=0,listEpoch=0,detail={},gallery=null,features=[],listError=null,attentionError=null;
let lastAuthSignal=null;
const requests=new Set(),mailSyncRequests=new Set(),replyRequests=new Set();let threadLink=null,replyState=null,replyComposer=null,caseMailSync=null,caseLoad=null;
// Explicit passive mail viewing for audits: no mail POST or auto-import.
const passiveMail=new URL(location.href).searchParams.get('mail-view')==='readonly';
class ReadFailure extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}
function failText(error){return error.status===403?'403 / 認証・ACL未解決':error.status===401?'認証・ACLまたは既存商務参照が未解決':error.code==='incomplete_result'?'一覧を完全に取得できませんでした':'読取に失敗しました';}
function errorBlock(error,label=''){
  return `<div class="read-error" role="status">${escape(label)} ${escape(failText(error))}<small>取得不能を「なし」「未入金」「確認済み」と扱いません。再取得は明示操作です。</small></div>`;
}
function abortRequests(){for(const controller of requests)controller.abort();requests.clear();}
function acceptActiveSession(next,epoch){
  if(epoch!==authEpoch||!session)return false;
  if(!next?.access_token||next.user?.id!==session.user?.id){signOut(false);return false;}
  session=next;
  return true;
}
async function api(url,{blob=false,track=requests}={}){
  if(!session)throw new ReadFailure('login_required',401);
  const epoch=authEpoch;
  if(session.expires_at&&session.expires_at*1000<=Date.now()){
    const fresh=await workspaceAuth.current().catch(()=>null);
    if(!acceptActiveSession(fresh,epoch))throw new ReadFailure('login_required',401);
  }
  const requestToken=session.access_token,controller=new AbortController();track.add(controller);
  let timer=setTimeout(()=>controller.abort(),25000);
  try{
    const response=await fetch(readUrl(url),{method:'GET',cache:'no-store',headers:{authorization:'Bearer '+session.access_token},signal:controller.signal});
    if(!response.ok){let data;try{data=await response.json();}catch{}const code=data?.code||'read_unavailable';if(epoch===authEpoch&&session?.access_token===requestToken&&requiresReauthentication(code,response.status))signOut(false);throw new ReadFailure(code,response.status);}
    if(blob)return response.blob();
    const data=await response.json();if(data.ok!==true)throw new ReadFailure('invalid_read_response',503);return data.result;
  }catch(error){if(error.name==='AbortError')throw new ReadFailure('read_timeout_or_cancelled',503);throw error;}
  finally{clearTimeout(timer);track.delete(controller);}
}
function current(){return cases.find(c=>c.id===selected)||null;}
function getRows(surface){const state=detail[surface];return state?.state==='ready'?state.value:null;}
function readBlock(surface,label,render){
  const state=detail[surface];
  if(!state||state.state==='loading')return `<div class="load-state">${escape(label)}を取得中…</div>`;
  if(state.state==='error')return errorBlock(state.error,label);
  return render(state.value);
}
function rowsHtml(rows,{title,body,time,kind,formatTime=date}={}){
  if(!rows.length)return '<div class="empty-state">保存済み記録なし</div>';
  return '<div class="rows">'+rows.map(row=>`<article class="record"><div class="record-head"><strong>${tx(title?.(row)||'保存済み記録')}</strong><span class="record-date">${escape(formatTime(time?.(row)))}</span></div>${kind?'<div class="stage-info">'+tx(kind(row))+'</div>':''}${body?'<div class="record-body">'+tx(body(row))+'</div>':''}</article>`).join('')+'</div>';
}
function fact(label,value){return `<div class="fact"><span>${escape(label)}</span><b>${tx(value||'未提供')}</b></div>`;}
function pair(label,value){return `<div class="label-pair"><span>${escape(label)}</span><b>${tx(value||'未提供')}</b></div>`;}
const requestMailBody=(id,row)=>api(row.read_route==='live'?'/data/mail-live-body/'+id+'/'+encodeURIComponent(row.gmail_thread_id)+'/'+encodeURIComponent(row.gmail_message_id):'/data/mail-body/'+id+'/'+encodeURIComponent(row.gmail_message_id));
const bodyView=createMailBodyView({request:requestMailBody,isAuthenticated:()=>!!session});
const htmlView=createMailHtmlView();
const caseBasicsEditor=createCaseBasicsEditor();
const manualIntake=createManualIntake();
const caseCalendar=createCaseCalendar({displayText:privateText,onSelect:async id=>{
  const epoch=selectionEpoch+1;
  await selectCase(id);
  if(selected===id&&selectionEpoch===epoch)setTab('schedule');
}});
const caseNames=createCaseNameView();
let mailGalleries=[];
function disposePreviews(){replyComposer?.detach();bodyView.detach();gallery?.dispose();gallery=null;for(const g of mailGalleries)g.dispose();mailGalleries=[];}
function clearDetail(){detail.commercialPanel?.controller.abort();replyState?.setCase(null);htmlView.close();caseBasicsEditor.close();caseCalendar.close();closeInfo();disposePreviews();detail={};central.replaceChildren();$('inspector').replaceChildren();}
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
  $('new-case').disabled=passiveMail||!session;
  renderCounts();updateFilterSummary();if(listError){$('case-list').innerHTML=errorBlock(listError,'案件一覧');return;}
  const list=visibleCases();let month='',html='';
  for(const c of list){
    const d=eventDate(c),group=$('order').value==='event'?(d?d.slice(0,7):'開催日未定'):'';
    if(group&&group!==month){month=group;html+=`<div class="month">${escape(group.replace('-','年 '))}${d?'月':''}</div>`;}
    const a=attention(c);html+=`<button class="case ${c.id===selected?'selected':''}" data-case="${escape(c.id)}" aria-pressed="${c.id===selected}"><span class="caldate">${escape(shortDate(d))}<small>${escape(d?d.slice(0,4):'')}</small></span><span style="min-width:0"><span class="casename" title="${escape(privateText(c.event_name||'イベント名未設定'))}"><span class="case-name-track"><span>${tx(c.event_name||'イベント名未設定')}</span><span aria-hidden="true" hidden>${tx(c.event_name||'イベント名未設定')}</span></span></span><span class="caseline" style="display:block">${tx(c.organization_name||c.customer_name||c.contact_name||'顧客未設定')}</span>${a.label!==statusText(c)?'<span class="casefoot">'+(a.needsReview===true?'<span class="newdot" aria-label="顧客返信未確認"></span>':'')+'<span>'+escape(a.label)+'</span></span>':''}</span><span class="rightbadges"><span class="tiny ${statusColor(c)==='green'?'success':statusColor(c)==='amber'?'warning':'neutral'}">${escape(statusText(c))}</span>${a.needsReview===true?'<span class="tiny new">返信未確認</span>':''}</span></button>`;
  }
  $('case-list').innerHTML=html||'<div class="empty-state">該当する案件はありません</div>';
  caseNames.mount($('case-list'));
  const closed=cases.filter(isClosedCase).length;
  document.querySelector('.asidebottom').innerHTML=`<span>表示 ${list.length} / ${cases.length}件</span><span>進行 ${cases.length-closed} / 完了等 ${closed}</span>`;
}
function renderHeader(){
  const c=current();$('case-ref').textContent=c?'受付 '+(c.inquiry_number||'番号未提供'):'CASE —';
  $('title').textContent=privateText(c?.event_name||'案件を選択');
  $('head-state').textContent=c?statusText(c):'未選択';$('head-state').className='pill '+(c?statusColor(c):'blue');
  $('head-meta').innerHTML=c?`<span>開催 <b>${tx(eventDate(c)||'未定')}</b></span><span>会場 <b>${tx(c.venue||'未設定')}</b></span>`:'';
  $('open-schedule').disabled=!c;
  const portal=$('open-portal');
  portal.hidden=passiveMail;
  if(c&&!passiveMail){portal.href='/pa/cases/'+encodeURIComponent(c.id)+'/portal';portal.removeAttribute('aria-disabled');portal.title='既存の案件別管理者ポータルを新しいタブで開く';}
  else{portal.removeAttribute('href');portal.setAttribute('aria-disabled','true');}
  document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.disabled=!c;b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
  renderCounts();
}
const unconfirmedOfferLabel='発行記録あり・同意未確認';
const acceptedOfferLabel='顧客同意の記録あり';
function formalOrderReadback(progress,commercial){
  if(progress?.formal_contract_id)return acceptedOfferLabel;
  if(progress?.estimate_approved_on&&progress?.booking_confirmed_on)return '旧工程に見積承認・予約確定あり';
  if(!commercial||commercial.state==='loading')return '発行記録を取得中…';
  const offers=commercial.state==='ready'?commercial.value?.offers:null;
  if(!Array.isArray(offers))return '発行記録を取得できません';
  return offers.length?unconfirmedOfferLabel:'保存済み発行記録なし';
}
function renderInspector(){
  const c=current();if(!c){$('inspector').replaceChildren();return;}
  const commercial=detail.commercial;
  const state=commercial?.state==='ready'?commercial.value:null;
  $('inspector').innerHTML=`<section class="sidesection"><h3 class="sidehead">業務の進行状態</h3>${pair('見積',state?state.estimates?.length?state.estimates.length+'版':'保存済み記録なし':'未取得')}${pair('正式受注',formalOrderReadback(c.progress,commercial))}${pair('請求',state?state.billings?.length?state.billings.length+'記録':'保存済み記録なし':'未取得')}${pair('入金',detail.payments?.state==='ready'?getRows('payments').length+'記録':'未取得')}</section><section class="sidesection"><h3 class="sidehead">保存済み新着状態</h3>${pair('顧客返信',attention(c).label)}<p class="hint">メール未読件数は提供されていません。選択・閲覧では確認状態を変更しません。</p></section><div class="notice">配送結果UNKNOWNは安全停止。結果確認と業務操作は既存画面で確認してください。</div>`;
}
function canEditCaseBasics(c){
  return Boolean(c&&!passiveMail&&session?.user?.id&&!isClosedCase(c)&&!c.deleted_at&&
    c.status!=='on_hold'&&!c.progress?.is_on_hold&&Number.isSafeInteger(c.revision)&&c.revision>0);
}
function openCaseBasics(){
  const inquiry=current(),ownerId=session?.user?.id,epoch=selectionEpoch;
  if(tab!=='overview'||!canEditCaseBasics(inquiry))return;
  const stillCurrent=()=>epoch===selectionEpoch&&selected===inquiry.id&&tab==='overview'&&session?.user?.id===ownerId;
  caseBasicsEditor.open({
    inquiry,stillCurrent,
    save:async input=>{
      const {updateCaseBasics}=await import('./integration.mjs');
      return updateCaseBasics({...input,ownerId,stillCurrent});
    },
    readback:async(result,changes)=>{
      const snapshot=await api('/data/cases');
      if(!stillCurrent())return;
      const row=snapshot.cases.find(item=>item.id===inquiry.id);
      if(!Number.isSafeInteger(row?.revision)||row.revision<result.revision||
        Object.entries(changes).some(([key,value])=>row[key]!==value)){
        throw Error('case_basics_readback_unknown');
      }
      cases=cases.map(item=>item.id===inquiry.id?{...item,...row,
        progress:snapshot.progress.find(progress=>progress.inquiry_id===inquiry.id)||null}:item);
      detail.caseBasicsSaved=true;
      void loadSurface('audit','/data/case/'+inquiry.id+'/audit',epoch);
      renderList();
      render();
    }
  });
}
function overview(c){
  const p=c.progress||{},a=attention(c);
  const next=p.next_action||p.next_action_memo||c.next_action||p.memo||'保存済みの進行状況を確認';
  const step=Number(p.current_step);
  return `<div class="brief ${a.needsReview===true?'warn':''}"><div><span class="kicker">次に必要な対応</span><strong>${tx(next)}</strong><small>${escape(a.label)}</small></div>${button('やり取りを確認','conversation','blue')}</div><div class="group"><h2 class="sectiontitle">案件の基本情報 <small>開催日・会場は上部に表示</small></h2>${canEditCaseBasics(c)?button('基本情報を編集','case-basics','quiet'):''}${detail.caseBasicsSaved?'<p class="notice" role="status">基本情報を保存しました。</p>':''}<div class="facts">${fact('本番時間',p.confirmed_event_time||c.event_time)}${fact('顧客',c.organization_name||c.customer_name||c.contact_name)}${c.organization_name?fact('お客様・担当者',c.customer_name||c.contact_name):''}${fact('案件種別',c.case_type)}${fact('担当',p.assigned_to||p.owner_name||c.assigned_to)}${fact('連絡先',c.email)}${fact('電話',c.phone)}</div><div class="stage-info">${tx(c.request_summary||'依頼概要未提供')}</div><div class="workflow">${STEPS.map((s,i)=>`<span class="${step===i+1?'current':step>i+1?'done':''}">${i+1} ${escape(s)}</span>`).join('')}</div><div class="stage-info">工程 ${Number.isInteger(step)&&step>0&&step<=14?step+' / 14':'未取得'}${p.is_on_hold?' / 保留':''}</div></div><div class="group"><h2 class="sectiontitle">最近の動き <button class="lightbtn" data-action="history">履歴を表示 ›</button></h2>${readBlock('audit','監査履歴',rows=>rowsHtml(rows.slice(0,4),{title:r=>r.action,time:r=>r.occurred_at}))}</div>${attentionError?errorBlock(attentionError,'新着状態'):''}`;
}
function syncStatusHtml(){
  if(passiveMail)return '<strong data-mail-sync-state="readonly">メール閲覧モード：保存済み履歴とGmailの候補・原本を確認できます。</strong>';
  const state=caseMailSync.get(selected),labels={idle:'保存済みメールを読み込み後、この案件を同期します。',syncing:'この案件の最新メールを同期中…',success:'同期完了：関連付け済みスレッドの最新メールを反映しました。',unlinked:'関連付け済みスレッドがありません。顧客メールを関連付けてください。',error:'同期失敗：最新は未確認です。保存済みメールを保持しています。'};
  const pending=detail.intakeThreadLink==='pending', disabled=state.promise||replyState?.pending(selected)||pending;
  const followUp=unlinkedIntakeFollowUp();
  const action=followUp?`<button type="button" class="action quiet" data-action="link-intake-follow-up" ${disabled?'disabled':''}>${pending?'初回返信を照合中…':'初回返信のスレッドを紐付けて同期'}</button>`:'';
  const error=detail.intakeThreadLink==='error'?'<p>初回返信の紐付けを確認できませんでした。再確認するか「顧客メールを関連付け」から確認してください。</p>':'';
  return `<strong data-mail-sync-state="${escape(state.phase)}">${escape(labels[state.phase])}</strong><p>最終成功：<time data-mail-sync-success>${escape(state.lastSuccess?date(state.lastSuccess):'未記録')}</time></p><div class="inlinebtns"><button type="button" class="action quiet" data-action="mail-sync" ${disabled?'disabled':''}>この案件のメールを再取得</button>${action}</div>${error}`;
}
function unlinkedIntakeFollowUp(){
  const links=getRows('links'), deliveries=getRows('deliveries');
  if(current()?.submission_source!=='public_form'||!Array.isArray(links)||!Array.isArray(deliveries))return null;
  const sent=deliveries.filter(row=>row.message_type===followUpType&&row.status==='sent');
  if(sent.length!==1||!sent[0].gmail_message_id||!sent[0].gmail_thread_id||links.some(link=>
    link.conversation_role==='primary_conversation'||link.gmail_thread_id===sent[0].gmail_thread_id))return null;
  return sent[0];
}
function renderMailSyncStatus(){const host=$('case-mail-sync');if(host&&current()&&caseMailSync)host.innerHTML=syncStatusHtml();}
async function linkIntakeFollowUp(){
  const id=selected, epoch=selectionEpoch, followUp=unlinkedIntakeFollowUp();
  if(passiveMail||!followUp||tab!=='conversation'||!session||detail.intakeThreadLink==='pending'||
    caseMailSync.get(id).promise||replyState.pending(id))return;
  const sameCase=()=>id===selected&&epoch===selectionEpoch;
  detail.intakeThreadLink='pending';renderMailSyncStatus();
  try{
    const {result}=await authenticatedMailRequest({
      action:'link_intake_follow_up',inquiry_id:id,delivery_id:followUp.id
    },()=>sameCase()&&tab==='conversation');
    if(!sameCase())return;
    if(result?.inquiry_id!==id||result.gmail_thread_id!==followUp.gmail_thread_id)throw Error('mail_link_conflict');
    await loadSurface('links','/data/case/'+id+'/links',epoch);
    if(!sameCase())return;
    if(!getRows('links')?.some(link=>link.inquiry_id===id&&link.gmail_thread_id===result.gmail_thread_id)){
      throw Error('mail_link_readback_unverified');
    }
    delete detail.intakeThreadLink;renderMailSyncStatus();
    await syncSelectedMail();
  }catch{
    if(sameCase()){detail.intakeThreadLink='error';renderMailSyncStatus();}
  }
}
async function syncSelectedMail(){
  const id=selected,epoch=selectionEpoch;if(passiveMail||!id||tab!=='conversation'||!session||replyState.pending(id))return;
  if(caseLoad?.id===id&&caseLoad.epoch===epoch)await caseLoad.promise;
  if(id!==selected||epoch!==selectionEpoch||tab!=='conversation'||!session||replyState.pending(id)||detail.intakeThreadLink==='pending')return;
  return caseMailSync.run(id);
}
function persistCaseView(){const url=new URL(location.href);url.searchParams.set('case',selected);if(tab==='conversation')url.searchParams.set('tab','conversation');else url.searchParams.delete('tab');window.history.replaceState(null,'',url);}
function conversation(c){
  const live=detail.liveMail,candidates=detail.mailCandidates;
  const labels={no_thread_links:'承認済みスレッドなし / 未紐付けメールは未確認',partial_unknown:'Gmail取得・帰属照合が一部失敗 / 最新は未確認',index_gap:'索引未更新あり / 承認済みスレッドから表示',linked_threads_current:'承認済みスレッドの索引に欠落なし'};
  const status=live?.state==='ready'?labels[live.value.status]||'取得状態UNKNOWN':live?.state==='loading'?'Gmailを読取確認中…':live?.state==='error'?'Gmail取得失敗 / 最新は未確認':'保存済みメール（最新照合は上の同期状態を確認）';
  const linkLabel=passiveMail?'顧客メール候補を確認':'顧客メールを関連付け';
  const syncHint=passiveMail?'検索・原本確認は読み取り専用です。':'やり取りを開くと、この案件に関連付け済みのスレッドを取り込みます。同期ではGmailを既読・確認済みにはしません。';
  return `<div class="toolbar">${flag('purple','メール・やり取り')}${flag(attention(c).needsReview===true?'red':'blue',attention(c).label)}${button('確認済みにする','mark-read','quiet',true)}</div><h2 class="sectiontitle">メール <small>閲覧で既読にしません</small></h2><div class="group" role="status" id="case-mail-sync">${syncStatusHtml()}</div><div class="group"><strong>${escape(status)}</strong><p class="hint">${syncHint}</p><button class="action quiet" data-action="mail-live" ${live?.state==='loading'?'disabled':''}>取込せず原本を確認</button><button class="action quiet" data-action="mail-link">${linkLabel}</button>${live?.state==='ready'?'<small>確認 '+escape(date(live.value.checked_at))+' / DB保存なし</small>':''}${live?.state==='error'?errorBlock(live.error,'Gmail'):''}</div>${candidates?.state==='ready'?'<p class="hint">顧客メール候補 '+(candidates.value.candidates||[]).length+'スレッド / 同じ顧客アドレスの案件 '+candidates.value.matching_case_count+'件</p>':candidates?.state==='error'?errorBlock(candidates.error,'顧客メール候補'):'<p class="hint">顧客メール候補を確認中…</p>'}<div id="reply-composer-host"></div>${renderConversationTimeline(c)}`;
}

function conversationEntries(inquiry) {
  return conversationTimeline(inquiry, getRows('messages') || [], getRows('deliveries') || []);
}

function openHistoryMailHtml(button) {
  const inquiry=current(),epoch=selectionEpoch,owner=session?.user?.id;
  if(!inquiry||tab!=='conversation'||!owner)return;
  const card=button.closest('article');
  const entry=conversationEntries(inquiry).find(row=>row.kind!=='form'&&(row.message
    ? row.message.gmail_message_id===card?.dataset.message
    : row.deliveries[0]?.id===card?.dataset.deliveryId));
  if(!entry||customerInbound(entry))return;
  const message=entry.message;
  const delivery=entry.deliveries.find(deliveredHtml);
  if(!message&&!delivery)return;
  return htmlView.open({
    isCurrent:()=>epoch===selectionEpoch&&selected===inquiry.id&&tab==='conversation'&&session?.user?.id===owner,
    request:async()=>{
      if(message){
        const original=await requestMailBody(inquiry.id,message);
        if(original.gmail_message_id!==message.gmail_message_id||(original.inquiry_id&&original.inquiry_id!==inquiry.id)){
          throw Error('mail_binding_mismatch');
        }
        if(original.body_html||!delivery)return original;
      }
      const result=await api('/data/mail-delivery-html/'+inquiry.id+'/'+encodeURIComponent(delivery.id));
      if(result.inquiry_id!==inquiry.id||result.delivery_id!==delivery.id||result.source!=='delivery_template'){
        throw Error('mail_binding_mismatch');
      }
      return result;
    }
  });
}

function replyableMessages() {
  if (!current() || passiveMail || detail.deliveries?.state !== 'ready') return [];
  return conversationEntries(current()).filter(customerInbound)
    .map(entry => entry.message).filter(row => row.index_state !== 'not_indexed');
}

function deliveryAttempts(deliveries) {
  if (!deliveries.length) return '';
  return `<details class="timeline-attempts"><summary>配送記録 ${deliveries.length}件</summary>
    ${deliveries.map(row => `<p>${escape(deliveryLabel(row))}・${escape(deliveryOutcome(row))}
      / ${escape(timelineDate(deliveryDate(row)))} / 試行 ${escape(row.attempt_number ?? '未取得')}
      ${row.error_summary ? ' / ' + escape(row.error_summary) : ''}
      ${row.gmail_message_id ? '<br>Gmail ID ' + escape(row.gmail_message_id) : ''}
    </p>`).join('')}</details>`;
}

function canStartFollowUp(inquiry) {
  return Boolean(!passiveMail && inquiry?.submission_source==='public_form' &&
    inquiry.email?.trim() && !isClosedCase(inquiry) &&
    ['new','new_inquiry','follow_up_pending'].includes(inquiry.status) &&
    detail.deliveries?.state==='ready' &&
    !detail.deliveries.value.some(row=>row.message_type===followUpType));
}

function formEntry(inquiry, entry) {
  const form = inquiry.first_form_data || {};
  const fields = [
    ['受付番号', inquiry.inquiry_number],
    ['イベント', form.event_name || inquiry.event_name],
    ['開催希望', [form.event_date || inquiry.event_date, form.event_time || inquiry.event_time].filter(Boolean).join(' ')],
    ['会場', form.venue_name || inquiry.venue],
    ['依頼内容', addresses(form.requested_services || inquiry.requested_services)],
    ['概要', form.event_overview || inquiry.request_summary],
    ['質問・相談', form.questions]
  ];
  const followUp = canStartFollowUp(inquiry) && !detail.intakeComposer
    ? '<div class="inlinebtns"><button type="button" class="action blue" data-intake-reply>お客様に返信</button></div>'
    : '';
  return `<article class="mail-row no-attachments" data-timeline-kind="form"><div class="mail-text">
    <div class="mail-heading"><strong>お問い合わせ受付</strong><time>${escape(timelineDate(entry.at))}</time></div>
    <p class="mail-address">申込者 ${escape(inquiry.contact_name || inquiry.customer_name || '未取得')} / ${escape(inquiry.email || '未取得')}<br>受付先 ARA-TECH</p>
    <dl class="timeline-form">${fields.filter(([, value]) => value).map(([name, value]) =>
      `<div><dt>${escape(name)}</dt><dd>${tx(value)}</dd></div>`).join('')}</dl>${followUp}<div id="intake-composer-host"></div></div></article>`;
}

function openIntakeComposer() {
  const inquiry = current();
  if (!canStartFollowUp(inquiry) || detail.intakeComposer) return;
  try {
    if (intakeAttempts.has(inquiry.id)) {
      openInfo('初回フォローメール','<p>送信は試行済みです。配送記録とGmail履歴を確認してください。</p>');
      return;
    }
  } catch {
    openInfo('初回フォローメール','<p>送信の試行記録を確認できません。配送記録を確認してください。</p>');
    return;
  }
  const caseDetail = detail;
  const owner = session?.user?.id;
  const epoch = selectionEpoch;
  const isCurrent = () => epoch===selectionEpoch && selected===inquiry.id;
  const form = createIntakeComposer({inquiry, requestPreview:({recipient,subject,body})=>
    authenticatedMailRequest({
      action:'preview_content_hearing', inquiry_id:inquiry.id, expected_recipient:recipient, subject, body
    }, ()=>isCurrent() && tab==='conversation', {endpoint:'/api/pa-mail'}), close:()=>{
    delete detail.intakeComposer;
    render();
    central.querySelector('[data-intake-reply]')?.focus();
  }, send:async ({recipient,subject,body})=>{
    const key = inquiry.id;
    intakeAttempts.begin(key,inquiry.id);
    try {
      const result = await authenticatedMailRequest({
        action:'send_content_hearing', inquiry_id:inquiry.id, expected_recipient:recipient, subject, body
      }, ()=>isCurrent() && tab==='conversation', {endpoint:'/api/pa-mail', track:replyRequests, timeout:65000});
      if (result.delivery?.message_type!==followUpType ||
          result.delivery.recipient?.trim()!==recipient || result.delivery.subject!==subject) {
        throw Error('follow_up_delivery_mismatch');
      }
      if (result.ok!==true || result.delivery.status!=='sent' || !result.delivery.id ||
          !result.delivery.gmail_message_id) throw Error('follow_up_delivery_unknown');
      intakeAttempts.finish(key,'sent');
      if (session?.user?.id!==owner) return result;
      intakeCompletions.set(key,{delivery:result.delivery,phase:'pending'});
      delete caseDetail.intakeComposer;
      if (result.case_state?.result_status==='waiting_customer_reply') {
        cases = cases.map(row=>row.id===key ? {...row,status:'waiting_customer_reply'} : row);
        renderList();
      }
      if (selected===key) void refreshIntakeDelivery(key);
      return result;
    } catch (error) {
      if (error.message==='follow_up_recipient_changed') intakeAttempts.release(key);
      else intakeAttempts.finish(key,'unknown');
      throw error;
    }
  }});
  detail.intakeComposer = form;
  render();
  form.scrollIntoView({block:'nearest'});
  form.elements.body.focus({preventScroll:true});
}

async function refreshIntakeDelivery(id) {
  const completion = intakeCompletions.get(id);
  if (!completion || selected!==id || completion.phase==='loading') return;
  const epoch = selectionEpoch;
  const {delivery} = completion;
  completion.phase = 'loading';
  render();
  try {
    if (caseLoad?.id===id) await caseLoad.promise;
    if (epoch!==selectionEpoch) return;
    const rows = await api('/data/case/'+id+'/deliveries');
    if (epoch!==selectionEpoch) return;
    if (!Array.isArray(rows) || !rows.some(row=>row.inquiry_id===id &&
        row.id===delivery.id && row.gmail_message_id===delivery.gmail_message_id &&
        row.message_type===followUpType && row.status==='sent' && row.body?.trim())) {
      throw Error('delivery_readback_unverified');
    }
    detail.deliveries = {state:'ready',value:rows};
    completion.phase = 'ready';
  } catch {
    // Keep the confirmed send separate from history availability.
  } finally {
    if (completion.phase==='loading') completion.phase = 'pending';
    if (epoch===selectionEpoch) {
      render();
      if (tab==='conversation') {
        const card = Array.from(central.querySelectorAll('[data-delivery-id],[data-message]')).find(row=>
          row.dataset.deliveryId===delivery.id || row.dataset.message===delivery.gmail_message_id);
        const notice = central.querySelector('[data-intake-notice]');
        const target = card?.previousElementSibling===notice ? notice : card || notice;
        target?.scrollIntoView({block:'start'});
      }
    }
  }
}

function intakeCompletionNotice(id) {
  const completion = intakeCompletions.get(id);
  if (!completion) return '';
  if (completion.phase==='ready') return '<div class="notice" role="status" data-intake-notice>送信しました。</div>';
  if (completion.phase==='loading') return '<div class="notice" role="status" data-intake-notice>送信しました。履歴を確認中です…</div>';
  return '<div class="notice" role="status" data-intake-notice>送信は完了しましたが、履歴表示を更新できませんでした。 <button type="button" class="lightbtn" data-intake-recheck>履歴を再取得</button></div>';
}

const deliveredHtml = row => row.status==='sent'&&deliveryOutcome(row)==='送信済み'&&row.body&&
  ['customer_receipt',followUpType].includes(row.message_type);
const historyHtmlButton = '<button type="button" class="lightbtn body-read" data-history-mail-html>HTML本文を表示</button>';

function deliveryEntry(entry) {
  const row = entry.deliveries[0];
  const label = deliveryLabel(row);
  const outcome = deliveryOutcome(row);
  const heading = `${escape(label)}・${escape(outcome)} <time>${escape(timelineDate(entry.at))}</time>`;
  const content = `<div class="mail-address">差出人 ARA-TECH<br>宛先 ${escape(row.recipient || '未取得')}</div>
    <strong class="mail-subject">${escape(row.subject || '件名未取得')}</strong>
    ${row.body ? '<p class="timeline-body">' + tx(row.body) + '</p>' : '<p class="hint">配送記録の件名と結果を表示</p>'}
    ${deliveredHtml(row)?historyHtmlButton:''}<p class="hint">添付情報未取得</p>${deliveryAttempts(entry.deliveries)}`;
  const inner = label === '内部通知'
    ? `<details><summary>${heading}</summary>${content}</details>`
    : `<div class="mail-heading">${heading}</div>${content}`;
  return `<article class="mail-row no-attachments sent" data-timeline-kind="delivery" data-delivery-id="${escape(row.id)}"><div class="mail-text">${inner}</div></article>`;
}

function renderConversationTimeline(inquiry) {
  const entries = conversationEntries(inquiry);
  const inbound = entries.filter(customerInbound).map(entry => entry.message);
  const newest = inbound.find(message => messageAttention(message, inquiry.attention, inbound));
  const status = detail.messages?.state === 'ready'
    ? (inbound.length ? '' : '<p class="hint" data-customer-mail-empty>確認できた顧客メールはありません。</p>')
    : readBlock('messages', 'メール索引', () => '');
  const deliveries = readBlock('deliveries', '配送記録', () => '');
  const completion = intakeCompletions.get(inquiry.id);
  const notice = intakeCompletionNotice(inquiry.id);
  return (completion?.phase==='ready' ? '' : notice) + status + deliveries + '<div class="mail-list" aria-label="やり取りの時系列">' +
    entries.map(entry => {
      if (entry.kind === 'form') return formEntry(inquiry, entry);
      const prefix = completion?.phase==='ready' && entry.deliveries.some(row=>row.id===completion.delivery.id) ? notice : '';
      if (entry.kind === 'delivery') return prefix + deliveryEntry(entry);
      return prefix + renderTimelineMail(entry, entry.message === newest);
    }).join('') + '</div>';
}

function renderTimelineMail(entry, isNew) {
  const r = entry.message;
  const inbound = customerInbound(entry);
  const dir = inbound ? 'received' : r.direction === 'outbound' || entry.deliveries.length ? 'sent' : 'unknown';
  const delivery = entry.deliveries[0];
  const label = delivery ? deliveryLabel(delivery) + '・' + deliveryOutcome(delivery)
    : inbound ? 'お客様からのメール' : dir === 'sent' ? 'ARA-TECHからの送信' : '方向未取得';
  const followUpBody = entry.deliveries.find(row=>row.message_type===followUpType && row.status==='sent')?.body;
  const body = followUpBody || savedExcerpt(r);
  const atts = mailAttachments(r);
  return `<article class="mail-row ${dir} ${atts.length?'has-attachments':'no-attachments'}" data-message="${escape(r.gmail_message_id)}" style="--attachment-slots:${Math.min(atts.length,4)}"><div class="mail-layout"><div class="mail-text"><div class="mail-heading"><span class="mail-direction ${dir}">${label}</span>${isNew?'<span class="tiny new">NEW・要確認</span>':''}${r.index_state==='not_indexed'?'<span class="tiny warning">索引未保存・確認状態未取得</span>':''}<time>${escape(timelineDate(entry.at))}</time><span class="mail-attachment-count">添付 ${Array.isArray(r.attachment_metadata)?atts.length+'件':'未取得'}</span></div><div class="mail-address" title="${escape('差出人 '+(r.from_address||'未取得')+' / 宛先 '+addresses(r.to_addresses)+(r.cc_addresses?.length?' / CC '+addresses(r.cc_addresses):''))}">差出人 ${escape(r.from_address||'未取得')}<br>宛先 ${escape(addresses(r.to_addresses))}${r.cc_addresses?.length?'<br>CC '+escape(addresses(r.cc_addresses)):''}</div><strong class="mail-subject">${escape(r.subject||'件名未提供')}</strong><p class="${followUpBody?'timeline-body':'mail-excerpt'} ${body?'':'unavailable'}">${escape(body||'表示時に本文を取得します…')}</p>${'<button class="lightbtn body-read" data-body-read="'+escape(r.gmail_message_id)+'">全文を表示</button>'}${dir==='sent'?historyHtmlButton:''}${inbound&&detail.deliveries?.state==='ready'?'<button type="button" class="action quiet mail-reply-button" data-reply-message="'+escape(r.gmail_message_id)+'" '+(r.index_state==='not_indexed'?'disabled title="索引未登録のため返信元を確定できません"':'')+'>返信</button>':''}</div>${atts.length?'<aside class="mail-attachments" aria-label="このメールの添付資料"><div class="mail-attachments-title"><strong>添付 '+atts.length+'件</strong>'+(atts.length>4?'<span class="carousel-arrows"><button type="button" class="carousel-arrow" data-carousel-left aria-label="添付を左へ" title="続きの添付を表示">‹</button><button type="button" class="carousel-arrow" data-carousel-right aria-label="添付を右へ" title="先頭の添付へ戻る">›</button></span>':'')+'</div><div class="attachment-strip" data-attachments="'+escape(r.gmail_message_id)+'"></div></aside>':''}</div>${deliveryAttempts(entry.deliveries)}</article>`;
}
function commercialControls(c,label){
  if(passiveMail||c?.case_type!=='PA_EVENT'||isClosedCase(c)||c.status==='on_hold'||c.progress?.is_on_hold)return '';
  return `<div class="inlinebtns">${button(label,'commercial-actions','quiet')}</div><div id="commercial-actions-host"></div>`;
}
function estimate(c){
  return moneyBar()+`<h2 class="sectiontitle">見積・正式受注</h2>`+readBlock('commercial','商務・原本',s=>{
    const estimates=s.estimates||[],offers=s.offers||[],acceptedId=c.progress?.formal_contract_id;
    const confirmationHistory=rowsHtml(offers,{
      title:offer=>'版 '+offer.version+' / '+(acceptedId&&offer.id===acceptedId?acceptedOfferLabel:unconfirmedOfferLabel),
      body:offer=>'有効期限 '+date(offer.expires_at),
      time:offer=>offer.issued_at
    });
    return `<div class="tablewrap"><table class="table"><thead><tr><th>見積版 / 発行</th><th>金額</th><th>送達</th></tr></thead><tbody>${estimates.map(e=>`<tr><td>版 ${tx(e.revision_number)} / ${tx(date(e.issued_at))}</td><td>${escape(privateMoney(e.amount_minor,e.currency||'JPY'))}</td><td>${tx(e.delivery?.state||'未取得')}</td></tr>`).join('')||'<tr><td colspan="3">保存済み見積なし</td></tr>'}</tbody></table></div><div class="group"><h2 class="sectiontitle">正式確認の履歴</h2>${confirmationHistory}</div>`;
  })+`<div class="inlinebtns" style="margin-top:12px">${button('再送・失効','resend','quiet',true)}</div>${commercialControls(c,'正式受注の操作')}<div class="group"><h2 class="sectiontitle">Gmail送信済み見積（過去履歴・正式登録未照合）</h2><p class="hint">期限切れを含む過去資料です。有効性は未確認。現行見積への登録・有効化は行いません。</p>${readBlock('sentEstimates','Gmail送信履歴',s=>rowsHtml(s.messages||[],{title:r=>r.subject,time:r=>r.sent_at,body:r=>'宛先 '+addresses(r.to_addresses)})+(s.unknown?.length?'<div class="read-error">紐付け不明 '+s.unknown.length+'スレッド / 自動確定しません</div>':''))}<div id="sent-estimate-grid" class="material-grid"></div></div><p class="hint">商務取得不能時は「契約なし」「未送信」と判定しません。</p>`;
}
async function openDeskCommercial(){
  const c=current(),epoch=selectionEpoch,owner=session?.user?.id;
  const activeTab=tab,label=activeTab==='invoice'?'請求・入金の操作':'見積・正式受注の操作';
  const host=$('commercial-actions-host');
  if(!host||!owner||detail.commercialPanel?.loading)return;
  const controller=new AbortController();
  const previous=detail.commercialPanel;
  previous?.controller.abort();
  const panel=previous?.panel||document.createElement('section');
  panel.className='group';
  panel.setAttribute('aria-label',label);
  panel.textContent='状態を取得中…';
  const operation={controller,panel,loading:true};
  detail.commercialPanel=operation;
  host.append(panel);
  const stillCurrent=()=>!controller.signal.aborted&&epoch===selectionEpoch&&selected===c.id
    &&tab===activeTab&&session?.user?.id===owner;
  try{
    const {renderDeskConfirmationActions,renderDeskBillingActions}=await import('/js/pa-commercial-admin.js?v=paui095-desk-pdf-mail');
    if(!stillCurrent())return;
    const renderActions=activeTab==='invoice'?renderDeskBillingActions:renderDeskConfirmationActions;
    await renderActions(panel,{
      case:c, signal:controller.signal, getCurrentCase:()=>stillCurrent()?current():null,
      privacy:{money:privateMoney,text:privateText,frame:privateFrame,releaseFrame:releasePrivateFrame,reset:resetPrivacy,
        setAmount:setPrivateAmount,readAmount:readPrivateAmount,releaseAmount:releasePrivateAmount},
      getAccessToken:async()=>{
        if(!stillCurrent())return null;
        let fresh;
        try{fresh=await workspaceAuth.restore();}
        catch{if(stillCurrent())signOut(false);return null;}
        if(!stillCurrent())return null;
        if(fresh?.user?.id!==owner){signOut(false);return null;}
        session=fresh;
        return fresh.access_token;
      },
      refreshCommercial:async({closed=false}={})=>{
        if(!stillCurrent())return;
        if(closed)panel.textContent='案件は完了しました。';
        const reload=[loadSurface('commercial','/data/commercial/'+c.id,epoch)];
        if(activeTab==='invoice')reload.push(loadSurface('payments','/data/case/'+c.id+'/payments',epoch));
        if(closed)reload.push(reloadBilledCase(c.id,epoch),loadSurface('audit','/data/case/'+c.id+'/audit',epoch));
        await Promise.all(reload);
        if(!closed&&stillCurrent())await openDeskCommercial();
      }
    });
  }catch{if(stillCurrent())panel.textContent=label+'を開けませんでした。もう一度お試しください。';}
  finally{operation.loading=false;}
}
async function reloadBilledCase(id,epoch){
  try{
    const result=await api('/data/cases');
    if(epoch!==selectionEpoch||selected!==id)return;
    const row=result.cases.find(item=>item.id===id);
    if(!row)throw Error('case_unavailable');
    cases=cases.map(item=>item.id===id?{...item,...row,progress:result.progress.find(p=>p.inquiry_id===id)||null}:item);
    renderList();
    render();
  }catch{
    if(epoch!==selectionEpoch||selected!==id||!detail.commercialPanel)return;
    const message=document.createElement('p');
    message.className='notice';
    message.textContent='保存済みの案件状態を再取得できませんでした。案件一覧を更新してください。';
    detail.commercialPanel.panel.append(message);
  }
}
function invoice(c){
  const closure=displayStatus(c)==='owner_payment_completed'
    ? '<div class="group"><h2 class="sectiontitle">完了の根拠</h2>'+
      readBlock('audit','完了の監査履歴',rows=>'<p class="stage-info">'+
        escape(paymentClosureBasis(c,rows)||'今回の完了の根拠を確認できる監査記録がありません')+'</p>')+'</div>'
    : '';
  return moneyBar()+closure+`<h2 class="sectiontitle">請求状態</h2>`+readBlock('commercial','請求',s=>rowsHtml(s.billings||[],{title:b=>b.invoice_policy==='no_separate_invoice'?'請求書を別途発行しない':b.invoice_delivery_state||b.state||'請求記録',body:b=>'期限 '+(b.due_date||'未提供')+' / 支払予定 '+(b.customer_planned_payment_on||'未提供'),time:b=>b.created_at}))+`<div class="group"><h2 class="sectiontitle">保存済み入金記録</h2>`+readBlock('payments','入金記録',rows=>rows.length?'<div class="rows">'+rows.map(p=>`<article class="record">${pair('入金日',date(p.confirmed_at))}<div class="label-pair"><span>金額</span><b>${escape(privateMoney(p.amount,p.currency||'JPY'))}</b></div>${pair('支払方法',p.payment_method||'未提供')}</article>`).join('')+'</div>':'<div class="empty-state">取得成功 / 保存済み入金記録なし（未入金の判定ではありません）</div>')+`</div>`+commercialControls(c,'請求・入金の操作');
}
const scheduleNoticeLabels = {
  schedule_request:'日程調整の案内',
  schedule_response_agree_customer:'条件同意の受付確認',
  schedule_response_agree_internal:'条件同意の内部通知',
  schedule_response_question_customer:'確認事項の受付確認',
  schedule_response_question_internal:'確認事項の内部通知',
  schedule_response_decline_customer:'見送りの受付確認',
  schedule_response_decline_internal:'見送りの内部通知',
  schedule_result_confirmed:'日程確定の通知',
  schedule_result_unavailable:'日程確保不可の通知'
};
function schedule(c){
  const p=c.progress||{};
  const tokens=readBlock('tokens','日程URL状態',rows=>{
    const latest=rows[0];
    if(!latest)return '<div class="empty-state">取得成功 / 保存済み日程URL記録なし</div>';
    return pair('URL状態',scheduleState(latest))+pair('発行',timelineDate(latest.issued_at))+
      pair('期限',timelineDate(latest.expires_at))+pair('回答',timelineDate(latest.answered_at))+
      '<p class="hint">発行済みURLの確認・発行・失効は既存の業務操作から行えます。</p>';
  });
  const answers=readBlock('responses','日程回答',rows=>rowsHtml(rows,{
    title:scheduleResponseLabel,
    body:r=>[r.respondent_name?'回答者 '+r.respondent_name:null,r.organization?'団体 '+r.organization:null,
      r.question_details?'確認事項 '+r.question_details:null,
      r.authority?'条件同意の権限 '+({yes:'ある',no:'ない',unknown:'分からない'}[r.authority]||r.authority):null,
      r.confirmation_name?'確認者 '+r.confirmation_name:null,r.terms_version?'規約版 '+r.terms_version:null,
      r.event_date,r.event_time,r.venue,r.request_summary,r.additional_notes,r.notes].filter(Boolean).join(' / '),
    time:r=>r.submitted_at||r.responded_at||r.created_at,formatTime:timelineDate
  }));
  const notices=readBlock('deliveries','案内記録',rows=>rowsHtml(rows.filter(r=>/schedule|日程/i.test(r.message_type||'')),{
    title:r=>scheduleNoticeLabels[r.message_type]||'日程連絡',
    body:r=>{
      const outcome=deliveryOutcome(r);
      return outcome==='配送結果未確定'?outcome+' / 再送前に履歴を確認':outcome;
    },
    time:deliveryDate,formatTime:timelineDate
  }));
  return `<div class="toolbar">${button('‹ 概要に戻る','overview','quiet')}${flag('amber','日程調整')}</div>
    <div class="schedule-hero"><strong>${escape(statusText(c))}</strong></div>
    <div class="facts">${fact('確保日',p.confirmed_event_date)}${fact('確保時間',p.confirmed_event_time)}${fact('予約確定',p.booking_confirmed_on)}</div>
    <div class="group"><h2 class="sectiontitle">URL・期限・失効状態</h2>${tokens}</div>
    <div class="group"><h2 class="sectiontitle">顧客回答</h2>${answers}</div>
    <div class="group"><h2 class="sectiontitle">日程案内・確定通知</h2>${notices}</div>
    <div class="inlinebtns" style="margin-top:12px">${button('リンク発行・失効','schedule-link','quiet',true)}${button('案内・確定送信','schedule-send','quiet',true)}</div>`;
}
function protectAudit(value,key=''){
  if(/amount|price|total|balance|subtotal|fee|cost|金額|請求額|見積額/i.test(key)&&value!==null&&value!==undefined)return typeof value==='number'||/^\d+(?:\.\d+)?$/.test(String(value))?privateMoney(Number(value)):privateText(value);
  if(/token|password|secret|authorization|credential|refresh/i.test(key))return '非表示';
  if(Array.isArray(value))return value.map(v=>protectAudit(v,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,protectAudit(v,k)]));
  return typeof value==='string'?privateText(value):value;
}
function history(){return moneyBar()+`<h2 class="sectiontitle">案件・工程・メール監査</h2>`+readBlock('audit','監査履歴',rows=>rowsHtml(rows,{title:r=>r.action,body:r=>typeof r.details==='string'?r.details:JSON.stringify(protectAudit(r.details||{})),time:r=>r.occurred_at}));}
function materialItems(){
  const portal=detail.materials?.state==='ready'?flattenMaterials(detail.materials.value):[];
  const commercial=detail.commercial?.state==='ready'?commercialMaterials(detail.commercial.value):[];
  const unique=new Map([...portal,...commercial].map(d=>[d.key,d]));return [...unique.values()];
}
function materialIndexStatus(){
  return [['materials','資料ポータルの索引','資料索引'],['commercial','商務原本の索引','商務原本の索引']].map(([name,label,loadingLabel])=>{
    const state=detail[name];
    if(state?.state==='error')return errorBlock(state.error,label);
    return state?.state==='ready'?'':`<div class="load-state">${loadingLabel}を取得中…</div>`;
  }).join('');
}
function documents(){
  return `<div class="files-controls"><input id="material-search" class="search" type="search" placeholder="資料名で検索" aria-label="資料名で検索"><span class="file-count" id="file-count"></span></div><p class="hint" style="margin:0 0 10px">PDF・画像は通常表示。原本の閲覧権限は取得時に検証します。</p><div id="material-index-status"></div><div id="material-grid" class="material-grid"></div><p class="hint">未取得・権限拒否・原本未登録を区別。公開区分が未提供の場合は所有者から推定しません。</p>`;
}
function renderMailPreviews(){
  const id=selected,epoch=selectionEpoch;
  const containers=new Map([...central.querySelectorAll('[data-message]')].map(node=>[node.dataset.message,node]));
  for(const {message:row} of conversationEntries(current())){
    if(!row)continue;
    const container=containers.get(row.gmail_message_id);
    if(!container)continue;
    const items=mailAttachments(row),strip=container.querySelector('[data-attachments]');
    if(strip){
      const g=createMailAttachmentCarousel({isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='conversation',requestBlob:item=>api(item.read_route==='live'?'/data/mail-live-attachment/'+id+'/'+encodeURIComponent(item.gmail_thread_id)+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id):'/data/mail-attachment/'+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id),{blob:true})});
      mailGalleries.push(g);g.mount(strip,items);
    }
    bodyView.mount(container,id,row,()=>selected===id&&selectionEpoch===epoch&&tab==='conversation');
  }
}
function renderGallery(){
  const id=selected,epoch=selectionEpoch;
  delete detail.materialIndexPending;
  $('material-index-status').innerHTML=materialIndexStatus();
  gallery?.dispose();gallery=createGallery({
    isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='documents',
    requestBlob:item=>api(item.asset_kind==='document'?'/data/document/'+id+'/'+item.asset_id:'/data/material/'+id+'/'+item.asset_kind+'/'+item.asset_id,{blob:true}),
    onPreviewClose:item=>{
      if(!detail.materialIndexPending)return;
      renderGallery();
      $('material-grid').querySelector(`[data-material-key="${CSS.escape(item.key)}"]`)?.focus({preventScroll:true});
    }
  });
  const items=materialItems(),q=($('material-search')?.value||'').toLocaleLowerCase('ja');
  const filtered=items.filter(d=>(d.title+' '+d.filename).toLocaleLowerCase('ja').includes(q));
  $('file-count').textContent='取得済み '+filtered.length+'資料'+(detail.materials?.state==='error'||detail.commercial?.state==='error'?' / 一部未取得':'');
  gallery.mount($('material-grid'),filtered);
  $('material-search').oninput=()=>{resetPrivacy();renderGallery();};
}
function openLegacy(){if(!passiveMail&&current())window.open(legacyUrl(selected), '_blank', 'noopener,noreferrer');}
function render(){
  const intakeFocus = detail.intakeComposer?.contains(document.activeElement) ? document.activeElement : null;
  resetPrivacy();disposePreviews();renderHeader();renderInspector();
  const c=current();if(!c){central.innerHTML='<div class="empty-state">案件を選択すると、保存済みの実案件情報を表示します。</div>';return;}
  const html=({overview,conversation,estimate,invoice,documents,history,schedule}[tab]||overview)(c);
  central.innerHTML=(html.includes('PRIVATE_MONEY_')&&!html.includes('data-money-toggle')?moneyBar():'')+html;
  if(detail.commercialPanel) ($('commercial-actions-host')||central).append(detail.commercialPanel.panel);
  if(!passiveMail)central.insertAdjacentHTML('beforeend','<div class="inlinebtns">'+button('既存の業務操作を開く','','quiet',true)+'</div>');
  if(tab==='documents')renderGallery();
  if(tab==='estimate'&&!detail.sentEstimates)loadSurface('sentEstimates','/data/sent-estimates/'+selected,selectionEpoch);
  if(tab==='conversation'){
    renderMailPreviews();replyComposer.mount($('reply-composer-host'));
    if (detail.intakeComposer) $('intake-composer-host')?.append(detail.intakeComposer);
    intakeFocus?.focus({preventScroll:true});
  }
  if(tab==='estimate'&&detail.sentEstimates?.state==='ready'){
    const id=selected,epoch=selectionEpoch,items=detail.sentEstimates.value.messages.flatMap(mailAttachments);
    gallery=createGallery({isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='estimate',requestBlob:item=>api('/data/sent-estimate-attachment/'+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id),{blob:true})});
    gallery.mount($('sent-estimate-grid'),items,{compact:true,showSource:true});
  }
}
async function loadSurface(name,url,epoch){
  if(epoch!==selectionEpoch)return;
  const pending={state:'loading'};
  detail[name]=pending;
  let result;
  try{result={state:'ready',value:await api(url)};}
  catch(error){result={state:'error',error};}
  // A newer read can start for the same surface without changing the case.
  if(epoch!==selectionEpoch||detail[name]!==pending)return;
  detail[name]=result;
  if(tab==='documents'){
    renderInspector();
    if(name!=='materials'&&name!=='commercial')return;
    const previewSource=gallery?.previewSource(),updatedSource=name==='materials'?'portal':'commercial';
    // An independent index cannot invalidate the open original. Defer rebuilding
    // the grid until it closes. A refresh of its own index must still replace it.
    if(previewSource&&previewSource!==updatedSource){detail.materialIndexPending=true;return;}
    renderGallery();
    return;
  }
  render();
}
function discoverMail(){if(current()&&detail.mailCandidates?.state!=='loading')void loadSurface('mailCandidates','/data/mail-candidates/'+selected,selectionEpoch);}
async function checkLiveMail(){
  if(!current()||detail.liveMail?.state==='loading'||replyState.pending(selected))return;
  const id=selected,initialLoad=caseLoad;
  const pending={state:'loading'};
  detail.liveMail=pending;
  discoverMail();
  if(tab==='conversation')render();
  // A completed sync or verified send clears the live view. A late response
  // belongs to its original loading state, even if another live read has begun.
  try{
    if(initialLoad?.id===id&&initialLoad.epoch===selectionEpoch)await initialLoad.messages;
    if(detail.liveMail!==pending)return;
    const value=await api('/data/mail-live/'+id);
    if(detail.liveMail!==pending)return;
    if(!value||!Array.isArray(value.messages)||value.messages.some(m=>m.inquiry_id!==id))throw new ReadFailure('mail_binding_mismatch',403);
    bodyView.clear();
    detail.liveMail={state:'ready',value};
    detail.messages={state:'ready',value:value.messages};
  }catch(error){
    if(detail.liveMail!==pending)return;
    detail.liveMail={state:'error',error};
  }
  if(tab==='conversation')render();
}
async function selectCase(id,{restoreTab=false}={}){
  if(!cases.some(c=>c.id===id))return;
  ++selectionEpoch;abortRequests();clearDetail();selected=id;replyState.setCase(id);tab=restoreTab&&new URL(location.href).searchParams.get('tab')==='conversation'?'conversation':'overview';persistCaseView();const epoch=selectionEpoch;
  renderList();render();
  // Read surfaces first. Restored conversation view then runs only its linked-case sync.
  const messages=loadSurface('messages','/data/mail/'+id,epoch);
  const promise=Promise.all(['tokens','responses','audit','deliveries','payments','links'].map(name=>loadSurface(name,'/data/case/'+id+'/'+name,epoch)).concat([messages,loadSurface('commercial','/data/commercial/'+id,epoch),loadSurface('materials','/data/materials/'+id,epoch)]));
  caseLoad={id,epoch,promise,messages};await promise;if(epoch===selectionEpoch){await replyState.resumeSent();if(tab==='conversation')void syncSelectedMail();}
}
async function refresh({openCaseId}={}){
  ++selectionEpoch;const epoch=++listEpoch;abortRequests();clearDetail();selected=null;cases=[];listError=null;attentionError=null;
  renderList();render();$('case-list').innerHTML='<div class="load-state">案件一覧を取得中…</div>';$('refresh-cases').disabled=true;
  try{
    const [list,att]=await Promise.allSettled([api('/data/cases'),api('/data/attention')]);
    if(epoch!==listEpoch)return;
    if(list.status!=='fulfilled')throw list.reason;
    const map=new Map(list.value.progress.map(p=>[p.inquiry_id,p]));
    if(att.status==='rejected')attentionError=att.reason;
    const attentionMap=new Map(att.status==='fulfilled'?att.value.map(a=>[a.inquiry_id,a]):[]);
    cases=list.value.cases.map(c=>({...c,progress:map.get(c.id)||null,attention:attentionMap.get(c.id)||null,attentionLoaded:att.status==='fulfilled'}));
    updateFilters();renderList();render();const requested=openCaseId||new URL(location.href).searchParams.get('case');if(requested&&cases.some(c=>c.id===requested))await selectCase(requested,{restoreTab:!openCaseId});
  }catch(error){if(epoch!==listEpoch)return;cases=[];listError=error;renderList();render();}
  finally{if(epoch===listEpoch)$('refresh-cases').disabled=false;}
}
function setTab(name){
  if(!['overview','conversation','estimate','invoice','documents','history','schedule'].includes(name)||!current())return;
  const changed=tab!==name;
  if(changed){htmlView.close();caseBasicsEditor.close();}
  if(changed&&detail.commercialPanel){detail.commercialPanel.controller.abort();delete detail.commercialPanel;}
  resetPrivacy();tab=name;persistCaseView();render();central.scrollTop=0;
  if(name==='conversation'&&changed)void syncSelectedMail();
  if(name==='conversation'&&!detail.mailCandidates)discoverMail();
  document.querySelectorAll('[data-top]').forEach(b=>b.classList.toggle('active',b.dataset.top==='files'?name==='documents':b.dataset.top==='inbox'?name==='conversation':!['documents','conversation'].includes(name)));
}
function openDrawer(){
  resetPrivacy();$('feature-search').value='';renderFeatures();
  $('drawer-wrap').showModal();
}
function renderFeatures(){
  const q=$('feature-search').value.toLocaleLowerCase('ja'),place=$('feature-place').value,status=$('feature-status').value;
  const shown=features.filter(f=>(!q||(f.id+' '+f.name+' '+f.scope).toLocaleLowerCase('ja').includes(q))&&(!place||f.place===place)&&(!status||f.status===status));
  $('feature-summary').textContent=`表示 ${shown.length}件 / 全 ${features.length}件`;
  $('feature-list').innerHTML=shown.map(f=>`<div class="feature"><span class="fid">${escape(f.id)}</span><span><strong>${escape(f.name)}</strong><small>${escape(f.place)} / <span class="features-status ${f.status==='新UIから利用可能'?'available':f.status==='認証・ACL未解決'?'acl':f.status==='内部機能'?'internal':''}">${escape(f.status)}</span></small><div class="feature-detail">${escape(f.scope)}</div></span><button data-feature="${escape(f.id)}">対応を見る ›</button></div>`).join('');
}
function featureJump(id){
  const f=features.find(x=>x.id===id);
  if(!f)return;
  $('drawer-wrap').close();
  // The feature guide must not start the conversation tab's automatic sync.
  if(current()&&f.target!=='conversation')setTab(f.target||'overview');
  const entry=f.current_control
    ?`<p><strong>CASE DESKの操作場所</strong><br>${escape(f.current_control)}</p>`
    :passiveMail?'':`<button class="action quiet" data-legacy ${current()?'':'disabled'}>既存の業務操作を開く ↗</button>`;
  openInfo(f.id+' '+f.name,entry+`<p>${escape(f.status)} / ${escape(f.scope)}</p><p class="hint">既存source：${escape(f.source)}<br>既存経路：${escape(f.api)}<br>機能実証：${escape(f.validation)}</p>`);
}
function openInfo(title,html){
  resetPrivacy();$('modal-title').textContent=title;$('modal-content').innerHTML=html;
  if(!$('modal-wrap').open)$('modal-wrap').showModal();
  $('modal-close-top').focus();
}
function signOut(callAuth=true){
  ++authEpoch;++selectionEpoch;++listEpoch;
  session=null;cases=[];selected=null;caseLoad=null;listError=null;attentionError=null;
  manualIntake.close();$('drawer-wrap').close();$('manual-intake-status').textContent='';
  for(const controller of replyRequests)controller.abort();replyRequests.clear();
  for(const controller of mailSyncRequests)controller.abort();mailSyncRequests.clear();
  abortRequests();caseMailSync?.clear();bodyView.clear();clearDetail();replyState?.clearAuth();
  $('modal-content').replaceChildren();$('modal-title').textContent='';
  resetCaseFilters();updateFilters();renderList();render();
  $('workspace').hidden=true;$('login-screen').hidden=false;$('sign-out').hidden=true;
  $('login-form').reset();$('login-status').textContent=callAuth?'ログアウト処理中…':'セッションまたは管理者権限を確認できません。再認証してください。';
  if(callAuth)workspaceAuth.logout().then(()=>{
    if(!session)$('login-status').textContent='ログアウトしました。';
  }).catch(()=>{
    if(!session)$('login-status').textContent='ログアウトを完了できませんでした。通信状態を確認して再実行してください。';
  });
}
async function showWorkspace(next,epoch,authSignal){
  if(epoch!==authEpoch||!next?.access_token)return;
  if(authSignal!==lastAuthSignal&&lastAuthSignal?.userId!==next.user?.id){signOut(false);return;}
  session=next;
  $('login-screen').hidden=true;$('workspace').hidden=false;$('sign-out').hidden=false;
  await refresh();
}

const extra=document.createElement('div');extra.className='search-extra';extra.innerHTML='<select id="type-filter" aria-label="案件種別"><option value="">すべての種別</option></select><select id="status-filter" aria-label="案件状態"><option value="">すべての状態</option></select><select id="year-filter" aria-label="開催年"><option value="">すべての年</option></select><select id="step-filter" aria-label="工程"><option value="">すべての工程</option></select>';
$('advanced-filters').append(extra);
const filterIds=['order','filter','type-filter','status-filter','year-filter','step-filter'];
function updateFilterSummary(){
  const labels=filterIds.filter(id=>$(id).value!==({order:'event',filter:'active'}[id]||'')).map(id=>$(id).selectedOptions[0]?.textContent||'');
  $('filter-summary').textContent=labels.length?'適用中: '+labels.join(' / '):'表示対象: 進行中';
}
function toggleFilters(open){$('advanced-filters').hidden=!open;$('toggle-filters').setAttribute('aria-expanded',String(open));$('toggle-filters').textContent=open?'詳細条件 ▲':'詳細条件 ▼';}
$('toggle-filters').onclick=()=>toggleFilters($('advanced-filters').hidden);
function resetCaseFilters(){for(const id of filterIds)$(id).value=({order:'event',filter:'active'}[id]||'');$('search').value='';}
const reset=document.createElement('button');reset.className='lightbtn';reset.textContent='条件をリセット';reset.onclick=()=>{resetCaseFilters();renderList();};
const close=document.createElement('button');close.className='lightbtn';close.textContent='詳細条件を閉じる ▲';close.onclick=()=>{toggleFilters(false);$('toggle-filters').focus();};
$('advanced-filters').append(reset,close);
for(const id of filterIds){const label=document.createElement('label');label.textContent=({order:'並び順',filter:'表示対象','type-filter':'案件種別','status-filter':'案件状態','year-filter':'開催年','step-filter':'工程'})[id];$(id).before(label);label.append($(id));}
const featureStatus=document.createElement('select');featureStatus.id='feature-status';featureStatus.setAttribute('aria-label','機能対応区分');featureStatus.append(new Option('全対応区分',''));for(const s of ['新UIから利用可能','現時点で無効','認証・ACL未解決','内部機能'])featureStatus.append(new Option(s,s));document.querySelector('.drawer-filters').append(featureStatus);
fetch('/pa-ui/features.json',{cache:'no-store'}).then(r=>r.json()).then(data=>{features=data;$('feature-count').textContent=data.length;options($('feature-place'),[...new Set(data.map(f=>f.place))].sort().map(p=>[p,p]),'全配置');}).catch(()=>{$('feature-count').textContent='未取得';});
$('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.currentTarget,submit=form.querySelector('button'),data=new FormData(form);submit.disabled=true;$('login-status').textContent='既存Auth・管理者ACLを確認中…';
  const epoch=++authEpoch,authSignal=lastAuthSignal;
  try{
    const authenticated=await workspaceAuth.login(String(data.get('email')),String(data.get('password')));
    if(epoch!==authEpoch)return;
    form.reset();await showWorkspace(authenticated,epoch,authSignal);
  }catch{if(epoch===authEpoch){$('login-status').textContent='ログインできません。既存管理者認証・閲覧権限を確認してください。';form.elements.password.value='';}}
  finally{submit.disabled=false;}
});
document.addEventListener('click',e=>{
  if(e.target.closest('[data-action="case-basics"]')){openCaseBasics();return;}
  if(e.target.closest('[data-intake-recheck]')){void refreshIntakeDelivery(selected);return;}
  if(e.target.closest('[data-intake-reply]')){openIntakeComposer();return;}
  const historyHtml=e.target.closest('[data-history-mail-html]');
  if(historyHtml){void openHistoryMailHtml(historyHtml);return;}
  const intakeLink=e.target.closest('[data-action="link-intake-follow-up"]');
  if(intakeLink){if(!intakeLink.disabled)void linkIntakeFollowUp();return;}
  const reply=e.target.closest('[data-reply-message],[data-reply-latest]');
  if(reply&&!reply.disabled&&!passiveMail){
    const rows=replyableMessages(),row=reply.dataset.replyMessage?rows.find(r=>r.gmail_message_id===reply.dataset.replyMessage):rows[0];
    if(row){void replyState.open(row).catch(()=>{});$('reply-composer-host')?.scrollIntoView({block:'start'});}return;
  }
  if(e.target.closest('[data-legacy]')){openLegacy();return;}
  const c=e.target.closest('[data-case]');if(c){selectCase(c.dataset.case);return;}
  const t=e.target.closest('[data-tab]');if(t){setTab(t.dataset.tab);return;}
  const feature=e.target.closest('[data-feature]');if(feature){featureJump(feature.dataset.feature);return;}
  const a=e.target.closest('[data-action]');if(a&&!a.disabled){if(a.dataset.action==='mail-sync'){void syncSelectedMail();return;}if(a.dataset.action==='mail-live'){checkLiveMail();return;}if(a.dataset.action==='mail-link'){threadLink.show();return;}if(a.dataset.action==='commercial-actions'){void openDeskCommercial();return;}setTab(a.dataset.action);return;}
  const top=e.target.closest('[data-top]');if(top)setTab(top.dataset.top==='files'?'documents':top.dataset.top==='inbox'?'conversation':'overview');
});
for(const id of ['search','order','filter','type-filter','status-filter','year-filter','step-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{resetPrivacy();renderList();});
$('refresh-cases').onclick=refresh;$('sign-out').onclick=signOut;$('open-schedule').onclick=()=>setTab('schedule');$('open-portal').onclick=()=>resetPrivacy();
$('open-case-calendar').onclick=()=>{if(session&&!listError)caseCalendar.open(cases,eventDate(current()||{}));};
$('new-case').onclick=()=>{
  const ownerId=session?.user?.id;
  if(passiveMail||!ownerId)return;
  $('manual-intake-status').textContent='';
  const stillCurrent=()=>session?.user?.id===ownerId;
  manualIntake.open({ownerId,stillCurrent,
    request:async input=>{
      const {requestManualIntake}=await import('./integration.mjs');
      return requestManualIntake(input);
    },
    onSaved:async row=>{
      if(!stillCurrent())return;
      const status=$('manual-intake-status');
      status.textContent='問い合わせを登録しました。 '+row.inquiry_number;
      const epoch=listEpoch+1;
      await refresh({openCaseId:row.id});
      if(stillCurrent()&&listEpoch===epoch&&!cases.some(c=>c.id===row.id)){
        status.textContent+=' 案件一覧を再取得してください。';
      }
    }
  });
};
$('open-more').onclick=()=>openInfo('その他の管理機能',`<div class="inlinebtns"><button class="action quiet" id="more-features">103機能の対応状況</button></div>`+
  (passiveMail?'':button('既存の業務操作を開く','','quiet',true)+'<p class="hint">更新・送信・発行は既存画面で内容を確認して操作してください。</p>'));
document.addEventListener('click',e=>{if(e.target.closest('#more-features')){closeInfo();openDrawer();}});
$('features-trigger').onclick=openDrawer;$('feature-search').oninput=renderFeatures;$('feature-place').onchange=renderFeatures;$('feature-status').onchange=renderFeatures;
$('drawer-close').onclick=()=>$('drawer-wrap').close();
function closeInfo(){threadLink?.reset();$('modal-wrap').close();resetPrivacy();}
$('modal-close').onclick=closeInfo;$('modal-close-top').onclick=closeInfo;
$('modal-wrap').addEventListener('cancel',event=>{event.preventDefault();closeInfo();});
window.addEventListener('pagehide',()=>signOut(false));
threadLink=createThreadLink({readOnly:passiveMail,read:api,open:openInfo,close:closeInfo,candidates:()=>getRows('mailCandidates'),current:()=>current()?{id:selected,name:current().event_name||current().inquiry_number,epoch:selectionEpoch}:null,
  refresh:async()=>{const epoch=selectionEpoch,id=selected;await loadSurface('links','/data/case/'+id+'/links',epoch);if(epoch===selectionEpoch&&id===selected)await checkLiveMail();},
  write:async (input,beginDispatch)=>{
    if(passiveMail)throw new ReadFailure('mail_readonly',403);
    const owner=session?.user?.id;
    if(!owner||input.action!=='manual_link')throw new ReadFailure('login_required',401);
    const sameContext=()=>owner===session?.user?.id&&input.inquiry_id===selected&&tab==='conversation';
    if(!sameContext())throw new ReadFailure('case_changed',409);
    const epoch=authEpoch,fresh=await workspaceAuth.current().catch(()=>null);
    if(!acceptActiveSession(fresh,epoch))throw new ReadFailure('login_required',401);
    if(!sameContext()||!beginDispatch())throw new ReadFailure('case_changed',409);
    const response=await fetch('/api/pa-gmail',{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+fresh.access_token,'Content-Type':'application/json'},body:JSON.stringify(input)});
    const data=await response.json();if(!response.ok||data.ok!==true)throw new ReadFailure(data.code||'write_outcome_unknown',response.status);return data.result;
  }});
// The regular authenticated reply API is the only write transport here.
async function authenticatedMailRequest(input,isCurrent,{track=requests,timeout=25000,endpoint='/api/pa-gmail'}={}){
  if(passiveMail)throw Error('mail_readonly');
  const owner=session?.user?.id;
  if(!owner||input.inquiry_id!==selected||!isCurrent())throw Error('login_required');
  const epoch=authEpoch,fresh=await workspaceAuth.restore().catch(()=>null);
  if(!acceptActiveSession(fresh,epoch))throw Error('login_required');
  if(input.inquiry_id!==selected||!isCurrent())throw Error('case_changed');
  const controller=new AbortController();track.add(controller);
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+fresh.access_token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});
    const data=await response.json();
    if(epoch===authEpoch&&session?.access_token===fresh.access_token&&requiresReauthentication(data.code,response.status))signOut(false);
    if(!response.ok||data.ok!==true&&!(endpoint==='/api/pa-mail'&&data.delivery))throw Error(data.code||'reply_request_failed');
    return data;
  }finally{clearTimeout(timer);track.delete(controller);}
}
const replyRequest=(input,isCurrent)=>authenticatedMailRequest(input,isCurrent,{track:replyRequests,timeout:input.action==='send_reply'?65000:25000});
let attemptStorage;
try{attemptStorage=sessionStorage;}catch{attemptStorage={getItem(){throw Error('send_lock_unavailable');},setItem(){throw Error('send_lock_unavailable');}};}
const intakeAttempts=createAttemptStore(attemptStorage,'paui-intake-follow-up-attempts-v1');
replyState=createReplyState({request:replyRequest,attempts:createAttemptStore(attemptStorage),changed:renderMailSyncStatus,
  readSent:async receipt=>{
    const id=receipt.caseId,epoch=authEpoch;if(!session?.user?.id)throw Error('login_required');
    if(caseLoad?.id===id)await caseLoad.promise;
    // Finish a pre-existing auto-import before the authoritative read. A send
    // pending for this case prevents new PAUI090 flights until verification ends.
    if(caseMailSync.get(id).promise)await caseMailSync.get(id).promise;
    if(epoch!==authEpoch)throw Error('login_required');
    const fresh=await workspaceAuth.restore().catch(()=>null);
    if(!acceptActiveSession(fresh,epoch))throw Error('login_required');
    const [messages,links]=await Promise.all([api('/data/mail/'+id,{track:replyRequests}),api('/data/case/'+id+'/links',{track:replyRequests})]);
    if(epoch!==authEpoch)throw Error('login_required');return {messages,links};
  },
  applySent:(id,value,receipt)=>{if(id!==selected)return;detail.messages={state:'ready',value:value.messages};detail.liveMail=null;bodyView.clear();render();
    requestAnimationFrame(()=>{if(id!==selected||tab!=='conversation'||replyState.get().phase!=='sent'||replyState.get().receipt?.messageId!==receipt.messageId)return;
      $('reply-composer-host')?.querySelector('[data-reply-notice]')?.scrollIntoView({block:'start'});
      central.querySelector('[data-message="'+receipt.messageId+'"]')?.scrollIntoView({block:'nearest'});
    });
  }
});
replyComposer=createReplyComposer({state:replyState,readHistory:async id=>{
  if(id!==selected)throw Error('case_changed');
  const [mail,audit]=await Promise.all([api('/data/mail-live/'+id),api('/data/case/'+id+'/audit')]);
  return {messages:mail.messages.filter(m=>m.direction==='outbound'),audit,status:mail.status};
}});
caseMailSync=createCaseMailSync({read:api,canDispatch:id=>Boolean(session?.user?.id&&id===selected&&tab==='conversation'),
  write:(input,isCurrent)=>authenticatedMailRequest(input,isCurrent,{track:mailSyncRequests,timeout:65000}),
  changed:id=>{if(id===selected&&tab==='conversation')renderMailSyncStatus();},
  apply:(id,result)=>{
    cases=cases.map(c=>c.id===id?{...c,attention:result.attention,attentionLoaded:true}:c);
    if(id!==selected)return;
    detail.messages={state:'ready',value:result.messages};detail.liveMail=null;bodyView.clear();renderList();render();
  }});
setInterval(()=>{if(session&&session.expires_at*1000<=Date.now())replyState.invalidateAuth();replyState.expire();},1000);
render();

workspaceAuth.subscribe?.((event,value)=>{
  if(event==='SIGNED_OUT'){signOut(false);return;}
  if(event!=='SIGNED_IN'&&event!=='TOKEN_REFRESHED')return;
  lastAuthSignal={userId:value?.user?.id};
  if(!session)return;
  if(event==='TOKEN_REFRESHED')acceptActiveSession(value,authEpoch);
  if(event==='SIGNED_IN'&&value?.user?.id!==session.user?.id)signOut(false);
});
window.addEventListener('focus',async()=>{
  if(!session)return;
  const epoch=authEpoch,restored=await workspaceAuth.restore().catch(()=>null);
  acceptActiveSession(restored,epoch);
});
async function restoreWorkspace(){
  const epoch=authEpoch,authSignal=lastAuthSignal;
  try{
    const restored=await workspaceAuth.restore();
    await showWorkspace(restored,epoch,authSignal);
  }catch{
    if(epoch===authEpoch)$('login-status').textContent='既存セッションを確認できません。管理者でログインしてください。';
  }
}
window.addEventListener('pageshow',event=>{if(event.persisted)void restoreWorkspace();});
void restoreWorkspace();
