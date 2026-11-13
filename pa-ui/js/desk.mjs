import {workspaceAuth, readUrl, legacyUrl} from './integration.mjs';
import {requiresReauthentication} from './auth-session.mjs';
import {privateText,privateMoney,resetPrivacy} from './pa-workspace-privacy.mjs';
import {createGallery,previewError} from './gallery.mjs';
import {createMailBodyView} from './mail-body-view.mjs';
import {createCaseNameView} from './case-name-view.mjs';
import {createMailAttachmentCarousel} from './mail-carousel.mjs';
import {createThreadLink} from './manual-thread-link.mjs';
import {createReplyState,createAttemptStore} from './reply-state.mjs';
import {createReplyComposer} from './reply-composer.mjs';
import {createCaseMailSync} from './case-mail-sync.mjs';
import {savedExcerpt,mailAttachments,messageAttention} from './mail-model.mjs';
import {conversationTimeline,customerInbound,deliveryDate,deliveryLabel,deliveryOutcome,timelineDate} from './conversation-timeline.mjs';
import {escape,STATUS,STEPS,statusText,statusColor,displayStatus,eventDate,sortCases,filterCases,attention,reviewCounts,scheduleState,scheduleResponseLabel,flattenMaterials,commercialMaterials,isClosedCase} from './model.mjs';

const $=id=>document.getElementById(id),central=$('detail-card');
const tx=value=>escape(privateText(String(value??'未提供')));
const addresses=v=>Array.isArray(v)?v.join(', '):String(v||'未取得');
const date=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未提供';return new Date(value).toLocaleString('ja-JP');};
const shortDate=value=>{if(!value||!Number.isFinite(Date.parse(value)))return '未定';return new Date(value).toLocaleDateString('ja-JP',{month:'2-digit',day:'2-digit'});};
const flag=(type,text)=>`<span class="pill ${escape(type)}">${tx(text)}</span>`;
const button=(text,act,style='',legacy=false)=>`<button class="action ${style}" ${legacy?'data-legacy title="既存の業務操作画面で確認"':'data-action="'+escape(act)+'"'}>${escape(text)}${legacy?' ↗':''}</button>`;
const moneyBar=label=>`<div class="money-bar"><button class="lightbtn" data-money-toggle aria-pressed="false">${escape(label||'この画面の金額を表示')}</button><small>30秒・画面切替・非アクティブで再非表示</small></div>`;
let session=null,cases=[],selected=null,tab='overview',selectionEpoch=0,listEpoch=0,detail={},gallery=null,features=[],listError=null,attentionError=null;
const requests=new Set(),mailSyncRequests=new Set(),replyRequests=new Set();let threadLink=null,replyState=null,replyComposer=null,caseMailSync=null,caseLoad=null,mailViewEpoch=0;
// Explicit passive mail viewing for audits: no mail POST or auto-import.
const passiveMail=new URL(location.href).searchParams.get('mail-view')==='readonly';
class ReadFailure extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}
function failText(error){return error.status===403?'403 / 認証・ACL未解決':error.status===401?'認証・ACLまたは既存商務参照が未解決':error.code==='incomplete_result'?'一覧を完全に取得できませんでした':'読取に失敗しました';}
function errorBlock(error,label=''){
  return `<div class="read-error" role="status">${escape(label)} ${escape(failText(error))}<small>取得不能を「なし」「未入金」「確認済み」と扱いません。再取得は明示操作です。</small></div>`;
}
function abortRequests(){for(const controller of requests)controller.abort();requests.clear();}
async function api(url,{blob=false,track=requests}={}){
  if(!session)throw new ReadFailure('login_required',401);
  if(session.expires_at&&session.expires_at*1000<=Date.now()){
    try{session=await workspaceAuth.current();}catch{signOut(false);throw new ReadFailure('login_required',401);}
  }
  const controller=new AbortController();track.add(controller);
  let timer=setTimeout(()=>controller.abort(),25000);
  try{
    const response=await fetch(readUrl(url),{method:'GET',cache:'no-store',headers:{authorization:'Bearer '+session.access_token},signal:controller.signal});
    if(!response.ok){let data;try{data=await response.json();}catch{}const code=data?.code||'read_unavailable';if(requiresReauthentication(code,response.status))signOut(false);throw new ReadFailure(code,response.status);}
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
function rowsHtml(rows,{title,body,time,kind}={}){
  if(!rows.length)return '<div class="empty-state">保存済み記録なし</div>';
  return '<div class="rows">'+rows.map(row=>`<article class="record"><div class="record-head"><strong>${tx(title?.(row)||'保存済み記録')}</strong><span class="record-date">${escape(date(time?.(row)))}</span></div>${kind?'<div class="stage-info">'+tx(kind(row))+'</div>':''}${body?'<div class="record-body">'+tx(body(row))+'</div>':''}</article>`).join('')+'</div>';
}
function fact(label,value){return `<div class="fact"><span>${escape(label)}</span><b>${tx(value||'未提供')}</b></div>`;}
function pair(label,value){return `<div class="label-pair"><span>${escape(label)}</span><b>${tx(value||'未提供')}</b></div>`;}
const bodyView=createMailBodyView({request:(id,row)=>api(row.read_route==='live'?'/data/mail-live-body/'+id+'/'+encodeURIComponent(row.gmail_thread_id)+'/'+encodeURIComponent(row.gmail_message_id):'/data/mail-body/'+id+'/'+encodeURIComponent(row.gmail_message_id)),isAuthenticated:()=>!!session});
const caseNames=createCaseNameView();
let mailGalleries=[];
function disposePreviews(){replyComposer?.detach();bodyView.detach();gallery?.dispose();gallery=null;for(const g of mailGalleries)g.dispose();mailGalleries=[];}
function clearDetail(){replyState?.setCase(null);threadLink?.reset();$('modal-wrap').classList.remove('open');resetPrivacy();disposePreviews();detail={};central.replaceChildren();$('inspector').replaceChildren();}
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
  if(c){portal.href='/pa/cases/'+encodeURIComponent(c.id)+'/portal';portal.removeAttribute('aria-disabled');portal.title='既存の案件別管理者ポータルを新しいタブで開く';}
  else{portal.removeAttribute('href');portal.setAttribute('aria-disabled','true');}
  document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.disabled=!c;b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
  renderCounts();
}
function renderInspector(){
  const c=current();if(!c){$('inspector').replaceChildren();return;}
  const commercial=detail.commercial;
  const state=commercial?.state==='ready'?commercial.value:null;
  $('inspector').innerHTML=`<section class="sidesection"><h3 class="sidehead">業務の進行状態</h3>${pair('見積',state?state.estimates?.length?state.estimates.length+'版':'保存済み記録なし':'未取得')}${pair('正式受注',statusText(c))}${pair('請求',state?state.billings?.length?state.billings.length+'記録':'保存済み記録なし':'未取得')}${pair('入金',detail.payments?.state==='ready'?getRows('payments').length+'記録':'未取得')}</section><section class="sidesection"><h3 class="sidehead">保存済み新着状態</h3>${pair('顧客返信',attention(c).label)}<p class="hint">メール未読件数は提供されていません。選択・閲覧では確認状態を変更しません。</p></section><div class="notice">配送結果UNKNOWNは安全停止。結果確認と業務操作は既存画面で確認してください。</div>`;
}
function overview(c){
  const p=c.progress||{},a=attention(c);
  const next=p.next_action||p.next_action_memo||c.next_action||p.memo||'保存済みの進行状況を確認';
  const step=Number(p.current_step);
  return `<div class="brief ${a.needsReview===true?'warn':''}"><div><span class="kicker">次に必要な対応</span><strong>${tx(next)}</strong><small>${escape(a.label)}</small></div>${button('やり取りを確認','conversation','blue')}</div><div class="group"><h2 class="sectiontitle">案件の基本情報 <small>開催日・会場は上部に表示</small></h2><div class="facts">${fact('本番時間',p.confirmed_event_time||c.event_time)}${fact('顧客',c.organization_name||c.customer_name||c.contact_name)}${fact('案件種別',c.case_type)}${fact('担当',p.assigned_to||p.owner_name||c.assigned_to)}${fact('連絡先',c.email)}${fact('電話',c.phone)}</div><div class="stage-info">${tx(c.request_summary||'依頼概要未提供')}</div><div class="workflow">${STEPS.map((s,i)=>`<span class="${step===i+1?'current':step>i+1?'done':''}">${i+1} ${escape(s)}</span>`).join('')}</div><div class="stage-info">工程 ${Number.isInteger(step)&&step>0&&step<=14?step+' / 14':'未取得'}${p.is_on_hold?' / 保留':''}</div></div><div class="group"><h2 class="sectiontitle">最近の動き <button class="lightbtn" data-action="history">履歴を表示 ›</button></h2>${readBlock('audit','監査履歴',rows=>rowsHtml(rows.slice(0,4),{title:r=>r.action,time:r=>r.occurred_at}))}</div>${attentionError?errorBlock(attentionError,'新着状態'):''}`;
}
function syncStatusHtml(){
  if(passiveMail)return '<strong data-mail-sync-state="readonly">メール閲覧モード：保存済み履歴を表示しています。自動取込・メール送信は停止中です。</strong>';
  const state=caseMailSync.get(selected),labels={idle:'保存済みメールを読み込み後、この案件を同期します。',syncing:'この案件の最新メールを同期中…',success:'同期完了：関連付け済みスレッドの最新メールを反映しました。',unlinked:'関連付け済みスレッドがありません。顧客メールを関連付けてください。',error:'同期失敗：最新は未確認です。保存済みメールを保持しています。'};
  return `<strong data-mail-sync-state="${escape(state.phase)}">${escape(labels[state.phase])}</strong><p>最終成功：<time data-mail-sync-success>${escape(state.lastSuccess?date(state.lastSuccess):'未記録')}</time></p><button type="button" class="action quiet" data-action="mail-sync" ${state.promise||replyState?.pending(selected)?'disabled':''}>この案件のメールを再取得</button>`;
}
function renderMailSyncStatus(){const host=$('case-mail-sync');if(host&&current()&&caseMailSync)host.innerHTML=syncStatusHtml();}
async function syncSelectedMail(){
  const id=selected,epoch=selectionEpoch;if(passiveMail||!id||tab!=='conversation'||!session||replyState.pending(id))return;
  if(caseLoad?.id===id&&caseLoad.epoch===epoch)await caseLoad.promise;
  if(id!==selected||epoch!==selectionEpoch||tab!=='conversation'||!session||replyState.pending(id))return;
  return caseMailSync.run(id);
}
function persistCaseView(){const url=new URL(location.href);url.searchParams.set('case',selected);if(tab==='conversation')url.searchParams.set('tab','conversation');else url.searchParams.delete('tab');window.history.replaceState(null,'',url);}
function conversation(c){
  const live=detail.liveMail,candidates=detail.mailCandidates;
  const labels={no_thread_links:'承認済みスレッドなし / 未紐付けメールは未確認',partial_unknown:'Gmail取得・帰属照合が一部失敗 / 最新は未確認',index_gap:'索引未更新あり / 承認済みスレッドから表示',linked_threads_current:'承認済みスレッドの索引に欠落なし'};
  const status=live?.state==='ready'?labels[live.value.status]||'取得状態UNKNOWN':live?.state==='loading'?'Gmailを読取確認中…':live?.state==='error'?'Gmail取得失敗 / 最新は未確認':'保存済みメール（最新照合は上の同期状態を確認）';
  return `<div class="toolbar">${flag('purple','メール・やり取り')}${flag(attention(c).needsReview===true?'red':'blue',attention(c).label)}${button('確認済みにする','mark-read','quiet',true)}</div><h2 class="sectiontitle">メール <small>閲覧で既読にしません</small></h2><div class="group" role="status" id="case-mail-sync">${syncStatusHtml()}</div><div class="group"><strong>${escape(status)}</strong><p class="hint">${passiveMail?'保存済みメールの閲覧モードです。':'やり取りを開くと、この案件に関連付け済みのスレッドを取り込みます。'}別スレッドは「顧客メールを関連付け」から確認できます。同期ではGmailを既読・確認済みにはしません。</p><button class="action quiet" data-action="mail-live" ${live?.state==='loading'?'disabled':''}>取込せず原本を確認</button><button class="action quiet" data-action="mail-link">顧客メールを関連付け</button>${live?.state==='ready'?'<small>確認 '+escape(date(live.value.checked_at))+' / DB保存なし</small>':''}${live?.state==='error'?errorBlock(live.error,'Gmail'):''}</div>${candidates?.state==='ready'?'<p class="hint">顧客メール候補 '+(candidates.value.candidates||[]).length+'スレッド / 同じ顧客アドレスの案件 '+candidates.value.matching_case_count+'件</p>':candidates?.state==='error'?errorBlock(candidates.error,'顧客メール候補'):'<p class="hint">顧客メール候補を確認中…</p>'}<div id="reply-composer-host"></div>${renderConversationTimeline(c)}`;
}

function conversationEntries(inquiry) {
  return conversationTimeline(inquiry, getRows('messages') || [], getRows('deliveries') || []);
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
  return `<article class="mail-row no-attachments" data-timeline-kind="form"><div class="mail-text">
    <div class="mail-heading"><strong>お問い合わせ受付</strong><time>${escape(timelineDate(entry.at))}</time></div>
    <p class="mail-address">申込者 ${escape(inquiry.contact_name || inquiry.customer_name || '未取得')} / ${escape(inquiry.email || '未取得')}<br>受付先 ARA-TECH</p>
    <dl class="timeline-form">${fields.filter(([, value]) => value).map(([name, value]) =>
      `<div><dt>${escape(name)}</dt><dd>${tx(value)}</dd></div>`).join('')}</dl></div></article>`;
}

function deliveryEntry(entry) {
  const row = entry.deliveries[0];
  const label = deliveryLabel(row);
  const outcome = deliveryOutcome(row);
  const heading = `${escape(label)}・${escape(outcome)} <time>${escape(timelineDate(entry.at))}</time>`;
  const content = `<div class="mail-address">差出人 ARA-TECH<br>宛先 ${escape(row.recipient || '未取得')}</div>
    <strong class="mail-subject">${escape(row.subject || '件名未取得')}</strong>
    ${row.body ? '<p class="timeline-body">' + tx(row.body) + '</p>' : '<p class="hint">配送記録の件名と結果を表示</p>'}
    <p class="hint">添付情報未取得</p>${deliveryAttempts(entry.deliveries)}`;
  const inner = label === '内部通知'
    ? `<details><summary>${heading}</summary>${content}</details>`
    : `<div class="mail-heading">${heading}</div>${content}`;
  return `<article class="mail-row no-attachments sent" data-timeline-kind="delivery"><div class="mail-text">${inner}</div></article>`;
}

function renderConversationTimeline(inquiry) {
  const entries = conversationEntries(inquiry);
  const inbound = entries.filter(customerInbound).map(entry => entry.message);
  const newest = inbound.find(message => messageAttention(message, inquiry.attention, inbound));
  const status = detail.messages?.state === 'ready'
    ? (inbound.length ? '' : '<p class="hint" data-customer-mail-empty>確認できた顧客メールはありません。</p>')
    : readBlock('messages', 'メール索引', () => '');
  const deliveries = readBlock('deliveries', '配送記録', () => '');
  return status + deliveries + '<div class="mail-list" aria-label="やり取りの時系列">' +
    entries.map(entry => {
      if (entry.kind === 'form') return formEntry(inquiry, entry);
      if (entry.kind === 'delivery') return deliveryEntry(entry);
      return renderTimelineMail(entry, entry.message === newest);
    }).join('') + '</div>';
}

function renderTimelineMail(entry, isNew) {
  const r = entry.message;
  const inbound = customerInbound(entry);
  const dir = inbound ? 'received' : r.direction === 'outbound' || entry.deliveries.length ? 'sent' : 'unknown';
  const delivery = entry.deliveries[0];
  const label = delivery ? deliveryLabel(delivery) + '・' + deliveryOutcome(delivery)
    : inbound ? 'お客様からのメール' : dir === 'sent' ? 'ARA-TECHからの送信' : '方向未取得';
  const body = savedExcerpt(r);
  const atts = mailAttachments(r);
  return `<article class="mail-row ${dir} ${atts.length?'has-attachments':'no-attachments'}" data-message="${escape(r.gmail_message_id)}" style="--attachment-slots:${Math.min(atts.length,4)}"><div class="mail-layout"><div class="mail-text"><div class="mail-heading"><span class="mail-direction ${dir}">${label}</span>${isNew?'<span class="tiny new">NEW・要確認</span>':''}${r.index_state==='not_indexed'?'<span class="tiny warning">索引未保存・確認状態未取得</span>':''}<time>${escape(timelineDate(entry.at))}</time><span class="mail-attachment-count">添付 ${Array.isArray(r.attachment_metadata)?atts.length+'件':'未取得'}</span></div><div class="mail-address" title="${escape('差出人 '+(r.from_address||'未取得')+' / 宛先 '+addresses(r.to_addresses)+(r.cc_addresses?.length?' / CC '+addresses(r.cc_addresses):''))}">差出人 ${escape(r.from_address||'未取得')}<br>宛先 ${escape(addresses(r.to_addresses))}${r.cc_addresses?.length?'<br>CC '+escape(addresses(r.cc_addresses)):''}</div><strong class="mail-subject">${escape(r.subject||'件名未提供')}</strong><p class="mail-excerpt ${body?'':'unavailable'}">${escape(body||'表示時に本文を取得します…')}</p>${'<button class="lightbtn body-read" data-body-read="'+escape(r.gmail_message_id)+'">全文を表示</button>'}${inbound&&detail.deliveries?.state==='ready'?'<button type="button" class="action quiet mail-reply-button" data-reply-message="'+escape(r.gmail_message_id)+'" '+(r.index_state==='not_indexed'?'disabled title="索引未登録のため返信元を確定できません"':'')+'>返信</button>':''}</div>${atts.length?'<aside class="mail-attachments" aria-label="このメールの添付資料"><div class="mail-attachments-title"><strong>添付 '+atts.length+'件</strong>'+(atts.length>4?'<span class="carousel-arrows"><button type="button" class="carousel-arrow" data-carousel-left aria-label="添付を左へ" title="続きの添付を表示">‹</button><button type="button" class="carousel-arrow" data-carousel-right aria-label="添付を右へ" title="先頭の添付へ戻る">›</button></span>':'')+'</div><div class="attachment-strip" data-attachments="'+escape(r.gmail_message_id)+'"></div></aside>':''}</div>${deliveryAttempts(entry.deliveries)}</article>`;
}
function estimate(){
  return moneyBar()+`<h2 class="sectiontitle">見積・正式受注</h2>`+readBlock('commercial','商務・原本',s=>{
    const estimates=s.estimates||[],offers=s.offers||[];
    return `<div class="tablewrap"><table class="table"><thead><tr><th>見積版 / 発行</th><th>金額</th><th>送達</th></tr></thead><tbody>${estimates.map(e=>`<tr><td>版 ${tx(e.revision_number)} / ${tx(date(e.issued_at))}</td><td>${escape(privateMoney(e.amount_minor,e.currency||'JPY'))}</td><td>${tx(e.delivery?.state||'未取得')}</td></tr>`).join('')||'<tr><td colspan="3">保存済み見積なし</td></tr>'}</tbody></table></div><div class="group"><h2 class="sectiontitle">正式確認の履歴</h2>${rowsHtml(offers,{title:o=>'版 '+o.version+' / '+(o.state||'unknown'),body:o=>'有効期限 '+date(o.expires_at)+(o.confirmed_at?' / 同意 '+date(o.confirmed_at):''),time:o=>o.issued_at})}</div>`;
  })+`<div class="group"><h2 class="sectiontitle">Gmail送信済み見積（過去履歴・正式登録未照合）</h2><p class="hint">期限切れを含む過去資料です。有効性は未確認。現行見積への登録・有効化は行いません。</p>${readBlock('sentEstimates','Gmail送信履歴',s=>rowsHtml(s.messages||[],{title:r=>r.subject,time:r=>r.sent_at,body:r=>'宛先 '+addresses(r.to_addresses)})+(s.unknown?.length?'<div class="read-error">紐付け不明 '+s.unknown.length+'スレッド / 自動確定しません</div>':''))}<div id="sent-estimate-grid" class="material-grid"></div></div>`+`<div class="inlinebtns" style="margin-top:12px">${button('見積登録・送信','issue-estimate','quiet',true)}${button('正式受注発行','issue-contract','quiet',true)}${button('再送・失効','resend','quiet',true)}</div><p class="hint">商務取得不能時は「契約なし」「未送信」と判定しません。</p>`;
}
function invoice(){
  return moneyBar()+`<h2 class="sectiontitle">請求状態</h2>`+readBlock('commercial','請求',s=>rowsHtml(s.billings||[],{title:b=>b.invoice_policy==='no_separate_invoice'?'請求書を別途発行しない':b.invoice_delivery_state||b.state||'請求記録',body:b=>'期限 '+(b.due_date||'未提供')+' / 支払予定 '+(b.customer_planned_payment_on||'未提供'),time:b=>b.created_at}))+`<div class="group"><h2 class="sectiontitle">保存済み入金記録</h2>`+readBlock('payments','入金記録',rows=>rows.length?'<div class="rows">'+rows.map(p=>`<article class="record">${pair('入金日',date(p.confirmed_at))}<div class="label-pair"><span>金額</span><b>${escape(privateMoney(p.amount,p.currency||'JPY'))}</b></div>${pair('支払方法',p.payment_method||'未提供')}</article>`).join('')+'</div>':'<div class="empty-state">取得成功 / 保存済み入金記録なし（未入金の判定ではありません）</div>')+`</div><div class="inlinebtns" style="margin-top:12px">${button('請求発行・入金更新','billing-write','quiet',true)}${button('案件完了','close-case','quiet',true)}</div>`;
}
function schedule(c){
  const p=c.progress||{};
  return `<div class="toolbar">${button('‹ 概要に戻る','overview','quiet')}${flag('amber','日程調整')}</div><div class="schedule-hero"><div><div class="kicker" style="color:var(--amber)">SCHEDULE COORDINATION</div><strong>${escape(statusText(c))}</strong></div></div><div class="facts">${fact('確保日',p.confirmed_event_date)}${fact('確保時間',p.confirmed_event_time)}${fact('予約確定',p.booking_confirmed_on)}${fact('確定状況',p.schedule_status||c.status)}</div><div class="group"><h2 class="sectiontitle">URL・期限・失効状態</h2>${readBlock('tokens','日程URL状態',rows=>{const latest=rows[0];return latest?pair('URL状態',scheduleState(latest))+pair('発行',date(latest.issued_at))+pair('期限',date(latest.expires_at))+pair('回答',date(latest.answered_at))+`<p class="hint">既存GETは秘密のURL tokenを返しません。URL再表示・発行・失効は無効です。</p>`:'<div class="empty-state">取得成功 / 保存済み日程URL記録なし</div>';})}</div><div class="group"><h2 class="sectiontitle">顧客回答</h2>${readBlock('responses','日程回答',rows=>rowsHtml(rows,{title:scheduleResponseLabel,body:r=>[r.respondent_name?'回答者 '+r.respondent_name:null,r.organization?'団体 '+r.organization:null,r.question_details?'確認事項 '+r.question_details:null,r.authority?'条件同意の権限 '+({yes:'ある',no:'ない',unknown:'分からない'}[r.authority]||r.authority):null,r.confirmation_name?'確認者 '+r.confirmation_name:null,r.terms_version?'規約版 '+r.terms_version:null,r.event_date,r.event_time,r.venue,r.request_summary,r.additional_notes,r.notes].filter(Boolean).join(' / '),time:r=>r.submitted_at||r.responded_at||r.created_at}))}</div><div class="group"><h2 class="sectiontitle">日程案内・確定通知</h2>${readBlock('deliveries','案内記録',rows=>rowsHtml(rows.filter(r=>/schedule|日程/i.test(r.message_type||'')),{title:r=>r.message_type,body:r=>/unknown/.test(r.status+' '+r.error_summary)?'UNKNOWN / 再送停止':r.status,time:r=>r.sent_at||r.requested_at}))}</div><div class="inlinebtns" style="margin-top:12px">${button('リンク発行・失効','schedule-link','quiet',true)}${button('案内・確定送信','schedule-send','quiet',true)}</div>`;
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
function documents(){
  return `<div class="files-controls"><input id="material-search" class="search" type="search" placeholder="資料名で検索" aria-label="資料名で検索"><span class="file-count" id="file-count"></span></div><p class="hint" style="margin:0 0 10px">PDF・画像は通常表示。原本の閲覧権限は取得時に検証します。</p>${detail.materials?.state==='error'?errorBlock(detail.materials.error,'資料ポータルの索引'):detail.materials?.state!=='ready'?'<div class="load-state">資料索引を取得中…</div>':''}${detail.commercial?.state==='error'?errorBlock(detail.commercial.error,'商務原本の索引'):detail.commercial?.state!=='ready'?'<div class="load-state">商務原本の索引を取得中…</div>':''}<div id="material-grid" class="material-grid"></div><p class="hint">未取得・権限拒否・原本未登録を区別。公開区分が未提供の場合は所有者から推定しません。</p>`;
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
  gallery?.dispose();gallery=createGallery({isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='documents',requestBlob:item=>api(item.asset_kind==='document'?'/data/document/'+id+'/'+item.asset_id:'/data/material/'+id+'/'+item.asset_kind+'/'+item.asset_id,{blob:true})});
  const items=materialItems(),q=($('material-search')?.value||'').toLocaleLowerCase('ja');
  const filtered=items.filter(d=>(d.title+' '+d.filename).toLocaleLowerCase('ja').includes(q));
  $('file-count').textContent='取得済み '+filtered.length+'資料'+(detail.materials?.state==='error'||detail.commercial?.state==='error'?' / 一部未取得':'');
  gallery.mount($('material-grid'),filtered);
  $('material-search').oninput=()=>{resetPrivacy();renderGallery();};
}
function openLegacy(){if(current())window.open(legacyUrl(selected), '_blank', 'noopener,noreferrer');}
function render(){
  resetPrivacy();disposePreviews();renderHeader();renderInspector();
  const c=current();if(!c){central.innerHTML='<div class="empty-state">案件を選択すると、保存済みの実案件情報を表示します。</div>';return;}
  const html=({overview,conversation,estimate,invoice,documents,history,schedule}[tab]||overview)(c);
  central.innerHTML=(html.includes('PRIVATE_MONEY_')&&!html.includes('data-money-toggle')?moneyBar():'')+html;
  central.insertAdjacentHTML('beforeend','<div class="inlinebtns"><button class="action quiet" data-legacy>既存の業務操作を開く ↗</button></div>');
  if(tab==='documents')renderGallery();
  if(tab==='estimate'&&!detail.sentEstimates)loadSurface('sentEstimates','/data/sent-estimates/'+selected,selectionEpoch);
  if(tab==='conversation'){renderMailPreviews();replyComposer.mount($('reply-composer-host'));}
  if(tab==='estimate'&&detail.sentEstimates?.state==='ready'){
    const id=selected,epoch=selectionEpoch,items=detail.sentEstimates.value.messages.flatMap(mailAttachments);
    gallery=createGallery({isCurrent:()=>selected===id&&selectionEpoch===epoch&&tab==='estimate',requestBlob:item=>api('/data/sent-estimate-attachment/'+id+'/'+encodeURIComponent(item.message_id)+'/'+encodeURIComponent(item.asset_id),{blob:true})});
    gallery.mount($('sent-estimate-grid'),items,{compact:true,showSource:true});
  }
}
async function loadSurface(name,url,epoch){
  detail[name]={state:'loading'};
  try{const value=await api(url);if(epoch!==selectionEpoch)return;detail[name]={state:'ready',value};}
  catch(error){if(epoch!==selectionEpoch)return;detail[name]={state:'error',error};}
  if(epoch===selectionEpoch)render();
}
function discoverMail(){if(current()&&detail.mailCandidates?.state!=='loading')void loadSurface('mailCandidates','/data/mail-candidates/'+selected,selectionEpoch);}
async function checkLiveMail(){
  if(!current()||detail.liveMail?.state==='loading'||replyState.pending(selected))return;
  discoverMail();
  const id=selected,epoch=selectionEpoch,viewEpoch=mailViewEpoch;detail.liveMail={state:'loading'};render();
  try{const value=await api('/data/mail-live/'+id);if(epoch!==selectionEpoch||id!==selected||viewEpoch!==mailViewEpoch)return;
    if(!value||!Array.isArray(value.messages)||value.messages.some(m=>m.inquiry_id!==id))throw new ReadFailure('mail_binding_mismatch',403);
    disposePreviews();bodyView.clear();detail.liveMail={state:'ready',value};detail.messages={state:'ready',value:value.messages};
  }catch(error){if(epoch!==selectionEpoch||id!==selected)return;detail.liveMail={state:'error',error};}
  render();
}
async function selectCase(id,{restoreTab=false}={}){
  if(!cases.some(c=>c.id===id))return;
  ++selectionEpoch;abortRequests();clearDetail();selected=id;replyState.setCase(id);tab=restoreTab&&new URL(location.href).searchParams.get('tab')==='conversation'?'conversation':'overview';persistCaseView();const epoch=selectionEpoch;
  renderList();render();
  // Read surfaces first. Restored conversation view then runs only its linked-case sync.
  const promise=Promise.all(['tokens','responses','audit','deliveries','payments','links'].map(name=>loadSurface(name,'/data/case/'+id+'/'+name,epoch)).concat([loadSurface('messages','/data/mail/'+id,epoch),loadSurface('commercial','/data/commercial/'+id,epoch),loadSurface('materials','/data/materials/'+id,epoch)]));
  caseLoad={id,epoch,promise};await promise;if(epoch===selectionEpoch){await replyState.resumeSent();if(tab==='conversation')void syncSelectedMail();}
}
async function refresh(){
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
    updateFilters();renderList();render();const requested=new URL(location.href).searchParams.get('case');if(requested&&cases.some(c=>c.id===requested))await selectCase(requested,{restoreTab:true});
  }catch(error){if(epoch!==listEpoch)return;cases=[];listError=error;renderList();render();}
  finally{if(epoch===listEpoch)$('refresh-cases').disabled=false;}
}
function setTab(name){
  if(!['overview','conversation','estimate','invoice','documents','history','schedule'].includes(name)||!current())return;
  const changed=tab!==name;resetPrivacy();tab=name;persistCaseView();render();central.scrollTop=0;
  if(name==='conversation'&&changed)void syncSelectedMail();
  if(name==='conversation'&&!detail.mailCandidates)discoverMail();
  document.querySelectorAll('[data-top]').forEach(b=>b.classList.toggle('active',b.dataset.top==='files'?name==='documents':b.dataset.top==='inbox'?name==='conversation':!['documents','conversation'].includes(name)));
}
function openDrawer(){resetPrivacy();$('drawer-wrap').classList.add('open');$('feature-search').value='';renderFeatures();$('drawer-close').focus();}
function renderFeatures(){
  const q=$('feature-search').value.toLocaleLowerCase('ja'),place=$('feature-place').value,status=$('feature-status').value;
  const shown=features.filter(f=>(!q||(f.id+' '+f.name+' '+f.scope).toLocaleLowerCase('ja').includes(q))&&(!place||f.place===place)&&(!status||f.status===status));
  $('feature-summary').textContent=`表示 ${shown.length}件 / 全 ${features.length}件`;
  $('feature-list').innerHTML=shown.map(f=>`<div class="feature"><span class="fid">${escape(f.id)}</span><span><strong>${escape(f.name)}</strong><small>${escape(f.place)} / <span class="features-status ${f.status==='新UIから利用可能'?'available':f.status==='認証・ACL未解決'?'acl':f.status==='内部機能'?'internal':''}">${escape(f.status)}</span></small><div class="feature-detail">${escape(f.scope)}</div></span><button data-feature="${escape(f.id)}">対応を見る ›</button></div>`).join('');
}
function featureJump(id){const f=features.find(x=>x.id===id);if(!f)return;$('drawer-wrap').classList.remove('open');if(current())setTab(f.target||'overview');if(['PAUI-C-004','PAUI-C-005'].includes(id)&&current()){const row=replyableMessages()[0];if(row)void replyState.open(row).catch(()=>{});return;}openInfo(f.id+' '+f.name,`<button class="action quiet" data-legacy ${current()?'':'disabled'}>既存の業務操作を開く ↗</button><p>${escape(f.status)} / ${escape(f.scope)}</p><p class="hint">既存source：${escape(f.source)}<br>既存経路：${escape(f.api)}<br>機能実証：${escape(f.validation)}</p>`);}
function openInfo(title,html){resetPrivacy();$('modal-title').textContent=title;$('modal-content').innerHTML=html;$('modal-wrap').classList.add('open');$('modal-close-top').focus();}
function signOut(callAuth=true){for(const c of replyRequests)c.abort();replyRequests.clear();caseMailSync?.clear();for(const c of mailSyncRequests)c.abort();mailSyncRequests.clear();bodyView.clear();++selectionEpoch;++listEpoch;abortRequests();clearDetail();replyState?.clearAuth();session=null;cases=[];selected=null;renderList();render();$('workspace').hidden=true;$('login-screen').hidden=false;$('sign-out').hidden=true;$('login-form').reset();$('login-status').textContent=callAuth?'ログアウト処理中…':'セッションまたは管理者権限を確認できません。再認証してください。';if(callAuth)workspaceAuth.logout().then(()=>{$('login-status').textContent='ログアウトしました。';}).catch(()=>{$('login-status').textContent='ログアウトを完了できませんでした。通信状態を確認して再実行してください。';});}

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
document.addEventListener('click',e=>{
  const reply=e.target.closest('[data-reply-message],[data-reply-latest]');
  if(reply&&!reply.disabled&&!passiveMail){
    const rows=replyableMessages(),row=reply.dataset.replyMessage?rows.find(r=>r.gmail_message_id===reply.dataset.replyMessage):rows[0];
    if(row){void replyState.open(row).catch(()=>{});$('reply-composer-host')?.scrollIntoView({block:'start'});}return;
  }
  if(e.target.closest('[data-legacy]')){openLegacy();return;}
  const c=e.target.closest('[data-case]');if(c){selectCase(c.dataset.case);return;}
  const t=e.target.closest('[data-tab]');if(t){setTab(t.dataset.tab);return;}
  const feature=e.target.closest('[data-feature]');if(feature){featureJump(feature.dataset.feature);return;}
  const a=e.target.closest('[data-action]');if(a&&!a.disabled){if(a.dataset.action==='mail-sync'){void syncSelectedMail();return;}if(a.dataset.action==='mail-live'){checkLiveMail();return;}if(a.dataset.action==='mail-link'){threadLink.show();return;}setTab(a.dataset.action);return;}
  const top=e.target.closest('[data-top]');if(top)setTab(top.dataset.top==='files'?'documents':top.dataset.top==='inbox'?'conversation':'overview');
});
for(const id of ['search','order','filter','type-filter','status-filter','year-filter','step-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{resetPrivacy();renderList();});
$('refresh-cases').onclick=refresh;$('sign-out').onclick=signOut;$('open-schedule').onclick=()=>setTab('schedule');$('open-portal').onclick=()=>resetPrivacy();
$('new-case').disabled=false;$('new-case').title='既存の登録画面を開く';$('new-case').onclick=()=>window.open('/pa-admin-legacy.html','_blank','noopener,noreferrer');
$('open-more').onclick=()=>openInfo('その他の管理機能',`<div class="inlinebtns"><button class="action quiet" id="more-features">103機能の対応状況</button></div><button class="action quiet" data-legacy>既存の業務操作を開く ↗</button><p class="hint">更新・送信・発行は既存画面で内容を確認して操作してください。</p>`);
document.addEventListener('click',e=>{if(e.target.closest('#more-features')){$('modal-wrap').classList.remove('open');openDrawer();}});
$('features-trigger').onclick=openDrawer;$('feature-search').oninput=renderFeatures;$('feature-place').onchange=renderFeatures;$('feature-status').onchange=renderFeatures;
$('drawer-close').onclick=()=>{$('drawer-wrap').classList.remove('open');$('features-trigger').focus();};
function closeInfo(){threadLink?.reset();$('modal-wrap').classList.remove('open');resetPrivacy();}
$('modal-close').onclick=closeInfo;$('modal-close-top').onclick=closeInfo;
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('drawer-wrap').classList.remove('open');closeInfo();}});
window.addEventListener('pagehide',()=>{for(const c of replyRequests)c.abort();replyRequests.clear();replyState.clearAuth();caseMailSync.clear();for(const c of mailSyncRequests)c.abort();mailSyncRequests.clear();bodyView.clear();session=null;abortRequests();clearDetail();});
threadLink=createThreadLink({read:api,open:openInfo,candidates:()=>getRows('mailCandidates'),current:()=>current()?{id:selected,name:current().event_name||current().inquiry_number,epoch:selectionEpoch}:null,
  refresh:async()=>{const epoch=selectionEpoch,id=selected;await loadSurface('links','/data/case/'+id+'/links',epoch);if(epoch===selectionEpoch&&id===selected)await checkLiveMail();},
  write:async input=>{
    if(!session||input.action!=='manual_link'||input.inquiry_id!==selected)throw new ReadFailure('login_required',401);
    session=await workspaceAuth.current();
    if(input.inquiry_id!==selected||!session)throw new ReadFailure('case_changed',409);
    const response=await fetch('/api/pa-gmail',{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+session.access_token,'Content-Type':'application/json'},body:JSON.stringify(input)});
    const data=await response.json();if(!response.ok||data.ok!==true)throw new ReadFailure(data.code||'write_outcome_unknown',response.status);return data.result;
  }});
// The regular authenticated reply API is the only write transport here.
async function authenticatedMailRequest(input,isCurrent,{track=requests,timeout=25000}={}){
  if(passiveMail)throw Error('mail_readonly');
  const owner=session?.user?.id;
  if(!owner||input.inquiry_id!==selected||!isCurrent())throw Error('login_required');
  let fresh;
  try{fresh=await workspaceAuth.restore();if(!fresh||fresh.user.id!==owner)throw Error('login_required');}
  catch{signOut(false);throw Error('login_required');}
  if(input.inquiry_id!==selected||!isCurrent())throw Error('case_changed');
  session=fresh;
  const controller=new AbortController();track.add(controller);
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch('/api/pa-gmail',{method:'POST',cache:'no-store',headers:{authorization:'Bearer '+fresh.access_token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});
    const data=await response.json();
    if(requiresReauthentication(data.code,response.status))signOut(false);
    if(!response.ok||data.ok!==true)throw Error(data.code||'reply_request_failed');
    return data;
  }finally{clearTimeout(timer);track.delete(controller);}
}
const replyRequest=(input,isCurrent)=>authenticatedMailRequest(input,isCurrent,{track:replyRequests,timeout:input.action==='send_reply'?65000:25000});
let attemptStorage;
try{attemptStorage=sessionStorage;}catch{attemptStorage={getItem(){throw Error('send_lock_unavailable');},setItem(){throw Error('send_lock_unavailable');}};}
replyState=createReplyState({request:replyRequest,attempts:createAttemptStore(attemptStorage),changed:renderMailSyncStatus,
  readSent:async receipt=>{
    const id=receipt.caseId,owner=session?.user?.id;if(!owner)throw Error('login_required');
    if(caseLoad?.id===id)await caseLoad.promise;
    // Finish a pre-existing auto-import before the authoritative read. A send
    // pending for this case prevents new PAUI090 flights until verification ends.
    if(caseMailSync.get(id).promise)await caseMailSync.get(id).promise;
    const fresh=await workspaceAuth.restore();if(!fresh||fresh.user.id!==owner||session?.user?.id!==owner)throw Error('login_required');session=fresh;
    const [messages,links]=await Promise.all([api('/data/mail/'+id,{track:replyRequests}),api('/data/case/'+id+'/links',{track:replyRequests})]);
    if(session?.user?.id!==owner)throw Error('login_required');return {messages,links};
  },
  applySent:(id,value,receipt)=>{if(id!==selected)return;mailViewEpoch++;detail.messages={state:'ready',value:value.messages};detail.liveMail=null;bodyView.clear();render();
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

workspaceAuth.subscribe?.((event,value)=>{if(event==='TOKEN_REFRESHED'&&session){if(value?.user?.id!==session.user.id){signOut(false);return;}session=value;}if(event==='SIGNED_OUT')signOut(false);});
window.addEventListener('focus',async()=>{if(!session)return;const epoch=listEpoch;try{const restored=await workspaceAuth.restore();if(epoch!==listEpoch||!session)return;if(!restored)signOut(false);else session=restored;}catch{if(epoch===listEpoch&&session)signOut(false);}});
workspaceAuth.restore().then(async restored=>{if(!restored)return;session=restored;$('login-screen').hidden=true;$('workspace').hidden=false;$('sign-out').hidden=false;await refresh();}).catch(()=>{$('login-status').textContent='既存セッションを確認できません。管理者でログインしてください。';});
