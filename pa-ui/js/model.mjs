export const STATUS = Object.freeze({new:'新規問い合わせ',new_inquiry:'新規問い合わせ',follow_up_pending:'フォロー待ち',waiting_customer_reply:'顧客回答待ち',hearing:'ヒアリング中',rough_estimate:'概算見積中',customer_intent_confirmed:'依頼意思確認済',schedule_coordination:'日程・人員調整中',reviewing:'内容確認中',second_form_not_issued:'日程フォーム未発行',second_form_issued:'日程フォーム発行済',customer_responded:'顧客回答済',schedule_unconfirmed:'日程未確定',schedule_adjusting:'日程調整中',needs_confirmation:'確認事項あり',declined:'見送り',schedule_confirmed:'日程確保完了',schedule_unavailable:'日程確保不可',on_hold:'保留',cancelled:'取消',closed:'対応終了',formal_order_confirmed:'正式受注済',owner_payment_completed:'入金確認済みで完了'});
export const STEPS=['問い合わせ受付','ヒアリング','概算提示','依頼意思確認','日程・人員調整','正式見積','発注確認','予約確定','事前準備','最終確認','本番実施','請求','入金確認','完了'];
export const escape = x => String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// PAUI-009 completion authority: explicit saved close/terminal records only.
// Event dates, event completion, payment balance and settlement never close a case.
const TERMINAL_CASE_STATUSES=new Set(['closed','cancelled','declined','schedule_unavailable']);
export function isClosedCase(c){return TERMINAL_CASE_STATUSES.has(c.status)||Boolean(c.progress?.closed_at);}
export function displayStatus(c){
  const p=c.progress||{};
  if(c.status==='closed'&&p.close_reason==='payment_received')return 'owner_payment_completed';
  const terminal=['closed','cancelled','declined','schedule_unavailable'].includes(c.status);
  if(c.case_type==='PA_EVENT'&&!c.deleted_at&&!terminal&&!p.closed_at&&(p.formal_contract_id||p.booking_confirmed_on&&p.estimate_approved_on)&&c.status!=='on_hold'&&!p.is_on_hold)return 'formal_order_confirmed';
  return c.status;
}
export function statusText(c){return STATUS[displayStatus(c)]||'状態未定義';}
export function statusColor(c){const s=displayStatus(c);return /cancelled|declined|unavailable/.test(s)?'red':/confirmed|completed/.test(s)?'green':/hold|confirmation/.test(s)?'amber':'blue';}
export function eventDate(c){return c.progress?.confirmed_event_date||c.event_date||null;}
export function sortCases(items,order='event'){
  return [...items].sort((a,b)=>{
    if(order==='received')return String(b.received_at||'').localeCompare(String(a.received_at||''))||String(a.id).localeCompare(String(b.id));
    return String(eventDate(a)||'9999-99-99').localeCompare(String(eventDate(b)||'9999-99-99'))||String(a.received_at||'').localeCompare(String(b.received_at||''))||String(a.id).localeCompare(String(b.id));
  });
}
export function attention(c){
  if(!c.attentionLoaded)return {known:false,label:'新着状態未取得',needsReview:null};
  if(!c.attention)return {known:false,label:'新着状態未登録',needsReview:null};
  const state=c.attention.attention_state;
  if(state==='new_customer_reply')return {known:true,label:'顧客返信・未確認',needsReview:true};
  if(state==='waiting_customer')return {known:true,label:'顧客回答待ち',needsReview:false};
  if(state==='none')return {known:true,label:'保存済み新着なし',needsReview:false};
  return {known:false,label:'新着状態未定義',needsReview:null};
}
export function reviewCounts(items){
  return {needsReview:items.filter(c=>attention(c).needsReview===true).length,unknown:items.filter(c=>!attention(c).known).length};
}
export function filterCases(items,{term='',review='active',type='',status='',year='',step=''}={}){
  const q=term.toLocaleLowerCase('ja').trim();
  return items.filter(c=>(!q||[c.event_name,c.organization_name,c.customer_name,c.contact_name,c.venue,c.inquiry_number,c.case_type].join(' ').toLocaleLowerCase('ja').includes(q))
    &&(review!=='active'||!isClosedCase(c))
    &&(review!=='completed'||isClosedCase(c))
    &&(review!=='unread'||attention(c).needsReview===true)
    &&(review!=='action'||!isClosedCase(c)&&(attention(c).needsReview===true||['needs_confirmation','on_hold','follow_up_pending'].includes(c.status)||c.progress?.is_on_hold))
    &&(!type||c.case_type===type)&&(!status||displayStatus(c)===status)&&(!year||String(eventDate(c)||'').startsWith(year))&&(!step||String(c.progress?.current_step||'')===step));
}
export function scheduleState(token,now=Date.now()){
  if(!token)return '保存済みURLなし';
  if(token.revoked_at)return '失効';
  if(token.expires_at&&Date.parse(token.expires_at)<=now)return '期限切れ';
  if(token.answered_at)return '回答済み';
  return '有効（保存済み状態）';
}
export function scheduleResponseLabel(row){return ({agree:'条件に同意し、日程調整を依頼',decline:'条件に同意せず、日程調整を依頼しない',question:'ARA-TECHへ確認したい'})[row.decision]||row.schedule_availability||row.availability||row.decision||row.status||'保存済み回答';}
export function documentChange(item,versions=[]){
  // Missing review evidence is never projected as unread NEW.
  // Updates use recorded revision facts, independent of selection/seen state.
  if(item.is_new===true)return 'NEW';
  if(versions.length>1||/^v?(?:[2-9]|[1-9]\d+)/i.test(String(item.version_label||'')))return '更新あり';
  if(versions.length===1)return '初版・確認状態未取得';
  return '確認状態未取得';
}
export function flattenMaterials(model){
  return (model.cards||[]).map(card=>{
    const current=(card.versions||[]).find(v=>v.id===card.current_version_id);
    return {key:'version:'+String(current?.id||card.id),asset_kind:'version',asset_id:current?.id||null,title:card.title||current?.display_filename||'名称未設定',filename:current?.display_filename||card.title||'資料',mime_type:current?.mime_type||'',owner_kind:card.owner_kind,category:card.category,version_label:current?.version_label||'版数未提供',updated_at:current?.source_created_at||current?.created_at||null,versions:card.versions||[],current,change:current?documentChange(current,card.versions):'原本未登録',source:'portal'};
  }).concat((model.photos||[]).map(p=>({key:'photo:'+p.id,asset_kind:'photo',asset_id:p.id,title:p.caption||p.display_filename,filename:p.display_filename,mime_type:p.mime_type,owner_kind:p.owner_kind,version_label:'版数未提供',updated_at:p.source_created_at||p.created_at,versions:[],current:p,change:'確認状態未取得',source:'portal'})));
}
export function commercialMaterials(snapshot){
  return (snapshot.documents||[]).map(d=>({key:'document:'+d.id,asset_kind:'document',asset_id:d.id,title:d.original_filename,filename:d.original_filename,mime_type:d.mime_type,owner_kind:'administrator',version_label:(snapshot.estimates||[]).find(e=>e.document_id===d.id)?.revision_number??'版数未提供',updated_at:d.created_at,versions:[],current:d,change:'確認状態未取得',source:'commercial'}));
}
export function publicScope(owner){return ({organizer:'主催者',ara_tech:'ARA-TECH',shared:'共有',performer:'出演者',administrator:'管理者'})[owner]||'未取得';}
