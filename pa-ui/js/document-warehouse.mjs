import {mailAttachments} from './mail-model.mjs';

const text=v=>Array.isArray(v)?v.join('、'):String(v??'');
const present=v=>v!==undefined&&v!==null&&text(v)!=='';
// Saved inquiry values only; no excerpt, generated summary or mail-body fallback.
export function inquiryFields(c){
  const f=c.first_form_data||{};
  return [['希望業務',c.requested_services??f.requested_services],['依頼内容（受付保存値）',c.request_summary],['開催概要（フォーム原文）',f.event_overview],['見積り・準備情報（フォーム原文）',f.estimate_notes],['質問・連絡事項（フォーム原文）',f.questions],['備考（受付保存値）',c.notes],['追加備考（受付保存値）',c.additional_notes]]
    .filter(([,v])=>present(v)).map(([label,v])=>({label,value:text(v)}));
}
export function documentKind(d){
  // Filename classification is a search aid, never contract or identity evidence.
  const s=String(d.filename||'');
  if(/正式受注|正式.*確認|contract|契約/iu.test(s))return '正式受注確認書';
  if(/見積|estimate|quotation|quote/iu.test(s))return '見積書';
  if(/請求|invoice/iu.test(s))return '請求書';
  if(/領収|receipt/iu.test(s))return '領収書';
  if(/stage.?plot/iu.test(s))return 'Stage Plot';
  if(/タイム|timetable/iu.test(s))return 'タイムテーブル';
  if(/台本|シナリオ|scenario|script/iu.test(s))return '台本';
  if(/図|layout|plan/iu.test(s))return '図面・配置図';
  if(/^image\//.test(d.mime_type))return '写真・画像';
  return d.category||'その他';
}
const unknown='未確認';
export function warehouseItems({materials={},commercial={},messages=[],sentEstimates={},inquiry={}}={}){
  const items=[];
  for(const card of materials.cards||[]){
    const versions=card.versions||[];
    // Latest is determined from unique recorded timestamps, not v-label or current pointer.
    const stamps=versions.map(v=>Date.parse(v.created_at||''));
    const latest=stamps.length&&stamps.every(Number.isFinite)?Math.max(...stamps):null;
    const uniqueLatest=latest!==null&&stamps.filter(s=>s===latest).length===1;
    for(const v of versions)items.push({key:'version:'+v.id,asset_kind:'version',asset_id:v.id,title:v.display_filename||card.title,filename:v.display_filename||card.title||'資料',mime_type:v.mime_type||'',owner_kind:card.owner_kind,category:card.category,version_label:v.version_label||'未提供',updated_at:v.created_at,source_at:v.source_created_at,source_type:v.source_type,source_ref:v.source_ref,current:v,versions,source:'portal',source_label:({portal_upload:'資料ポータル',gmail_attachment:'Gmail登録資料',pa_attachment:'問い合わせ添付'})[v.source_type]||'資料ポータル',latest_state:uniqueLatest?(Date.parse(v.created_at)===latest?'最新登録版':'旧登録版'):unknown,portal_current:card.current_version_id===v.id?'ポータル現在版':card.current_version_id?'ポータル過去版':'現在版未指定',original_state:!card.current_version_id?'現在版未指定 / 保存版の原本は閲覧時に検証':card.current_version_id===v.id?'原本の索引あり / 閲覧時に検証':'保存版の原本は閲覧時に検証',valid_state:unknown});
    if(!card.current_version_id||!versions.some(v=>v.id===card.current_version_id))items.push({key:'card:'+card.id,asset_kind:'version',asset_id:null,title:card.title,filename:card.title||'資料',category:card.category,owner_kind:card.owner_kind,source:'portal',source_label:'資料ポータル',versions:[],version_label:'未提供',portal_current:'未指定・未取得',original_state:card.current_version_id?'現在版の索引未取得':'現在版未指定',valid_state:unknown,latest_state:unknown});
  }
  for(const p of materials.photos||[])items.push({key:'photo:'+p.id,asset_kind:'photo',asset_id:p.id,title:p.display_filename||p.caption,filename:p.display_filename||'画像',mime_type:p.mime_type,owner_kind:p.owner_kind,source:'portal',source_label:'資料ポータル',source_type:p.source_type,source_ref:p.source_ref,current:p,source_at:p.source_created_at,updated_at:p.created_at,original_state:'原本の索引あり / 閲覧時に検証',version_label:'未提供',latest_state:unknown,valid_state:unknown});
  const estimates=commercial.estimates||[],numbers=estimates.map(e=>Number(e.revision_number));
  const max=numbers.length&&numbers.every(Number.isFinite)?Math.max(...numbers):null;
  for(const d of commercial.documents||[]){
    const e=estimates.find(e=>e.document_id===d.id),isUnique=max!==null&&numbers.filter(n=>n===max).length===1;
    items.push({key:'document:'+d.id,asset_kind:'document',asset_id:d.id,title:d.original_filename,filename:d.original_filename||'商務資料',mime_type:d.mime_type,sha256:d.sha256,source:'commercial',source_label:'商務登録原本',owner_kind:'administrator',version_label:e?.revision_number??'未提供',issued_at:e?.issued_at,updated_at:d.created_at,latest_state:e&&isUnique?(Number(e.revision_number)===max?'最新発行版':'旧発行版'):unknown,valid_state:unknown,original_state:'原本SHAの索引あり / 閲覧時に検証'});
  }
  for(const e of estimates.filter(e=>!(commercial.documents||[]).some(d=>d.id===e.document_id)))items.push({key:'estimate-index:'+e.id,asset_id:null,filename:'見積書 発行版 '+e.revision_number,title:'見積書 発行版 '+e.revision_number,source:'commercial',source_label:'見積発行索引',version_label:e.revision_number,issued_at:e.issued_at,latest_state:max!==null&&numbers.filter(n=>n===max).length===1?(Number(e.revision_number)===max?'最新発行版':'旧発行版'):unknown,valid_state:unknown,original_state:e.document_id?'原本の索引未取得':'原本参照未提供'});
  for(const o of commercial.offers||[])items.push({key:'offer-index:'+o.id,asset_id:null,download_ref:{kind:'contract-receipt',id:o.id},filename:'正式受注確認 発行版 '+o.version,title:'正式受注確認 発行版 '+o.version,source:'commercial',source_label:'正式確認発行索引',version_label:o.version,issued_at:o.issued_at,latest_state:unknown,valid_state:unknown,original_state:'発行メタデータのみ / PDF・同意証跡との原本対応は未提供'});
  for(const row of messages)for(const a of mailAttachments(row))items.push({...a,key:'indexed:'+a.key,source:'gmail',source_label:row.direction==='outbound'?'Gmail送信添付':row.direction==='inbound'?'Gmail受信添付':'Gmail添付（方向未取得）',source_address:row.direction==='outbound'?text(row.to_addresses):row.from_address,read_route:'mail',original_state:a.asset_id?'メール添付索引あり / 閲覧時に検証':'添付識別子未提供',version_label:'未提供',latest_state:unknown,valid_state:unknown});
  for(const row of sentEstimates.messages||[])for(const a of mailAttachments(row))items.push({...a,source:'gmail',source_label:'Gmail送信済み見積',source_address:text(row.to_addresses),read_route:'sent-estimate',original_state:'送信済み履歴 / 正式登録未照合',version_label:'未提供',latest_state:unknown,valid_state:unknown});
  for(const [source,attachments]of [['問い合わせ添付',inquiry.attachments],['問い合わせフォーム添付',inquiry.first_form_data?.attachments]])for(const [index,a]of (Array.isArray(attachments)?attachments:[]).entries())items.push({key:'intake:'+source+':'+index,asset_id:a.gmail_message_id&&a.gmail_attachment_id?a.gmail_attachment_id:null,...(a.gmail_message_id&&a.gmail_attachment_id?{asset_kind:'mail',message_id:a.gmail_message_id,read_route:'mail'}:{}),filename:a.original_filename||a.filename||a.name||'問い合わせ資料',title:a.original_filename||a.filename||a.name||'問い合わせ資料',mime_type:a.mime_type,source:'intake',source_label:source,original_state:a.gmail_message_id&&a.gmail_attachment_id?'保存済みメール原本参照 / 閲覧時に案件・原本を検証':'メタデータのみ / 正規原本参照が未提供',version_label:'未提供',latest_state:unknown,valid_state:unknown});
  return mergeMailSources(items).map(item=>({...item,kind:documentKind(item),change:item.latest_state||unknown}));
}
// Reconcile the two read projections of a mail attachment, never independent
// portal versions, commercial revisions, contract evidence, or another message.
export function mergeMailSources(items){
  const result=[],mail=items.filter(i=>i.asset_kind==='mail'&&i.asset_id);
  const sameMessage=(a,b)=>!!a.case_id&&a.case_id===b.case_id&&!!a.message_id&&a.message_id===b.message_id&&!!a.gmail_thread_id&&a.gmail_thread_id===b.gmail_thread_id;
  function evidence(a,b){
    if(!sameMessage(a,b)||a.mime_type!==b.mime_type)return '';
    if(a.source_direction&&b.source_direction&&a.source_direction!==b.source_direction)return '';
    if(a.part_id&&b.part_id&&a.part_id!==b.part_id)return '';
    if(a.canonical_attachment_key&&b.canonical_attachment_key&&a.canonical_attachment_key!==b.canonical_attachment_key)return '';
    if(a.sha256&&b.sha256&&a.sha256!==b.sha256)return '';
    if(a.asset_id===b.asset_id)return '同一メール・添付ID';
    if(a.part_id&&a.part_id===b.part_id)return '同一メール・MIME part';
    if(/^gmail:message-part:v1:[a-f0-9]{64}$/.test(a.canonical_attachment_key||'')&&a.canonical_attachment_key===b.canonical_attachment_key)return '同一メール・canonical identity';
    return '';
  }
  const consumed=new Set();
  for(const item of items){
    if(consumed.has(item))continue;
    // A one-to-one match across projections is required. Ambiguous candidates
    // are all retained, including duplicate parts within either projection.
    const candidates=mail.filter(other=>other!==item&&other.read_route!==item.read_route&&evidence(item,other));
    const match=candidates.length===1?candidates[0]:null;
    const reverse=match?mail.filter(other=>other!==match&&other.read_route!==match.read_route&&evidence(match,other)):[];
    if(match&&reverse.length===1&&!consumed.has(match)){
      consumed.add(match);
      const primary=item.read_route==='mail'?item:match;
      const history=value=>({case_id:value.case_id,message_id:value.message_id,gmail_thread_id:value.gmail_thread_id,filename:value.filename,original_filename:value.original_filename,source_label:value.source_label,read_route:value.read_route,asset_id:value.asset_id,part_id:value.part_id,canonical_attachment_key:value.canonical_attachment_key,sha256:value.sha256,source_at:value.source_at,source_subject:value.source_subject,source_direction:value.source_direction,source_address:value.source_address,original_state:value.original_state});
      result.push({...primary,source_direction:primary.source_direction||item.source_direction||match.source_direction,sources:[...new Set([item.source_label,match.source_label])],source_records:[history(item),history(match)],display_identity:evidence(item,match)});
    }else result.push(item);
  }
  return result;
}
export function filterWarehouse(items,{term='',kind='',source='',from='',to=''}={}){
  const q=term.toLocaleLowerCase('ja');
  return items.filter(d=>(!q||[d.filename,d.source_label,...(d.sources||[]),d.source_address,d.version_label].join(' ').toLocaleLowerCase('ja').includes(q))&&(!kind||d.kind===kind)&&(!source||d.source===source)&&(!from||String(d.issued_at||d.source_at||d.updated_at||'').slice(0,10)>=from)&&(!to||String(d.issued_at||d.source_at||d.updated_at||'').slice(0,10)<=to&&!!(d.issued_at||d.source_at||d.updated_at)));
}
export function inquiryAttachmentItems(items){return items.filter(d=>d.source==='intake'||d.source_type==='pa_attachment');}
