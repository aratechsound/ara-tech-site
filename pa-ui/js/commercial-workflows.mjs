import {downloadFilename} from './original-download.mjs';
import {resolveOrderDocuments,resolveMonitoredOrderDocuments} from './order-documents.mjs';
import {openCandidateDecision} from './quote-monitor.mjs';
import {openQuoteAdoption} from './quote-adoption.mjs';
import {createPrivateAssets} from './private-assets.mjs';
import {mountChangeEvidenceSummary,openChangeEvidence} from './change-evidence.mjs';
import {selectConfirmationContext,confirmationDisplayState,effectiveDeliveryState} from '../../js/pa-confirmation-display.mjs';
import {privateText,privateMoney,privateFrame,setPrivateAmount,readPrivateAmount,resetPrivacy} from './pa-workspace-privacy.mjs';

const el=(tag,text='',className='')=>{const n=document.createElement(tag);n.className=className;n.textContent=privateText(String(text));return n;};
const button=(label,action)=>{const b=el('button',label,'lightbtn');b.type='button';b.addEventListener('click',()=>Promise.resolve(action()).catch(()=>{}));return b;};
const field=(label,input)=>{const n=el('label',label);input.setAttribute('aria-label',label);n.append(input);return n;};
const TAX={tax_included:'税込',tax_excluded:'税別',tax_exempt:'非課税'};
const CODES={invalid_origin:'このテスト環境の操作許可はありません。',not_authorized:'Owner認証を確認できません。',case_changed:'案件または認証が切り替わりました。',stale_estimate_preview:'案件・見積版・配送内容が変わりました。再取得してください。',stale_confirmation_preview:'正式確認の内容が変わりました。再取得してください。',estimate_send_not_ready:'現在の見積配送は送信準備の対象ではありません。',delivery_outcome_unresolved:'配送結果が不明または処理中です。再送・再発行せず履歴を確認してください。',contract_already_accepted:'承諾済み契約を保護しています。',confirmation_already_active:'発行済みの正式確認を保護しています。',document_identity_mismatch:'案件・見積版とPDF原本の対応を確認できません。',commercial_state_changed:'商務正本が変わっています。再取得してください。',invalid_estimate:'見積金額・PDF・税区分を確認してください。',rate_limited:'操作上限です。時間を置いて明示的に再取得してください。'};
const explain=e=>CODES[e.message]||'正規処理を確認できません。成功と扱わず、再送せず状態を再取得してください。';
const ALLOWED=new Set(['original_index','sent_quote_preview','sent_quote_adopt','sent_quote_status','reply_document_review','reply_document_adopt','quote_monitor_document','change_evidence_contract_pdf','change_evidence_candidates','change_evidence_preview','change_evidence_append','change_evidence_document','change_evidence_mail_pdf','snapshot','document','composer_preview','issue_estimate','estimate_send_preview','confirmation_preview','confirmation_receipt_preview','confirmation_send_preview','confirmation_send_receipt_preview','issue_confirmation','issue_direct_confirmation_and_send','dispatch_outbox']);

export function commercialProjection(data){
  if(!data?.state||!Array.isArray(data.estimates)||!Array.isArray(data.offers)||!Array.isArray(data.outbox)||!Array.isArray(data.documents))throw Error('incomplete_commercial_snapshot');
  const current=data.estimates.find(e=>e.id===data.state.current_estimate_revision_id)||null;
  if(data.state.current_estimate_revision_id&&!current)throw Error('incomplete_commercial_snapshot');
  const confirmation=selectConfirmationContext(data),display=confirmationDisplayState(confirmation);
  const unresolved=data.outbox.some(j=>['unknown','processing'].includes(j.state)||j.delivery_state==='unknown_after_provider_start');
  const protectedOffer=Boolean(confirmation.accepted||confirmation.active||data.offers.some(o=>o.state==='unknown'));
  const estimateJob=current?data.outbox.find(j=>j.job_kind==='estimate'&&j.aggregate_id===current.id&&j.state==='queued'):null;
  return {current,confirmation,display,unresolved,protectedOffer,estimateJob,
    canRegister:!protectedOffer&&!unresolved&&data.state.estimate_change_state==='ready',
    canEstimateSend:!!estimateJob&&!protectedOffer&&!unresolved&&data.state.estimate_change_state==='ready'};
}

export function createCommercialWorkflows({getCase,getSession,onAuthFailure=()=>{},fetchImpl=fetch,onChanged=async()=>{},quoteMonitor=null}){
  let root=null,caseId=null,epoch=0,snapshot=null,loading=null,error=null,busy=false,dirty=false,mutations=0,documents=null,documentAssets=null,evidenceRead=null,evidenceAuthority=null,simpleAdoption=false,quickAdopt=null;
  const dialogs=new Set(),controllers=new Set();
  const valid=(id,version)=>caseId===id&&getCase()?.id===id&&epoch===version;
  function clear(){documents?.dispose();documents=null;documentAssets?.clear();documentAssets=null;evidenceRead=null;++epoch;for(const c of controllers)c.abort();controllers.clear();for(const d of dialogs){if(d.open)d.close();d.remove();}dialogs.clear();root=null;caseId=null;snapshot=null;loading=null;error=null;dirty=false;busy=false;resetPrivacy();}
  async function request(action,input={},binary=false){
    if(!ALLOWED.has(action)||input.case_id&&input.case_id!==caseId)throw Error('case_changed');
    const id=caseId,version=epoch,auth=await getSession();
    if(!auth?.access_token||!valid(id,version))throw Error('case_changed');
    const controller=new AbortController();controllers.add(controller);
    const mutation=['sent_quote_adopt','reply_document_adopt','change_evidence_append','issue_estimate','issue_confirmation','issue_direct_confirmation_and_send','dispatch_outbox'].includes(action);if(mutation)++mutations;
    try{
      const r=await fetchImpl('/api/pa-mail?surface=commercial',{method:'POST',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json'},body:JSON.stringify({...input,action,case_id:id})});
      if(!valid(id,version))throw Error('case_changed');
      if(binary&&r.ok){const blob=await r.blob(),name=r.headers.get('Content-Disposition'),digest=r.headers.get('X-PA-Original-SHA256');if(name)blob.originalFilename=downloadFilename(name);if(digest)blob.originalSha256=digest;return blob;}
      const p=await r.json();if(!r.ok||!p.ok){const e=Error(p.code||'commercial_request_failed');if([401,403].includes(r.status)&&p.code!=='invalid_origin')onAuthFailure();throw e;}
      return p.result;
    }finally{controllers.delete(controller);if(mutation)--mutations;}
  }
  function track(d){d.classList.add('case-commercial-dialog');dialogs.add(d);d.addEventListener('close',()=>{dialogs.delete(d);resetPrivacy();},{once:true});}
  function dialog(title){const d=el('dialog');d.setAttribute('aria-label',title);d.append(el('h2',title));track(d);document.body.append(d);return d;}
  function stateText(d,text){const s=d.querySelector('[data-commercial-status]');if(s)s.textContent=privateText(text);}
  async function beforeLeave(){
    if(busy||mutations){for(const d of dialogs)stateText(d,'処理中です。結果を確認してから移動してください。');return false;}
    if(!dirty)return true;
    return new Promise(resolve=>{const d=dialog('見積下書きの確認');d.append(el('p','案件・画面を切り替えると入力中の見積は失われます。'),button('入力へ戻る',()=>{d.close();d.remove();resolve(false);}),button('下書きを破棄して移動',()=>{dirty=false;d.close();d.remove();resolve(true);}));d.addEventListener('cancel',e=>{e.preventDefault();d.close();d.remove();resolve(false);},{once:true});d.showModal();});
  }
  async function load(){
    if(loading)return loading;
    const id=caseId,version=epoch;error=null;
    loading=(async()=>{try{const value=await request('snapshot');commercialProjection(value);if(value.state.inquiry_id!==id)throw Error('case_changed');if(valid(id,version))snapshot=value;}
      catch(e){if(valid(id,version)){snapshot=null;error=e;}}
      finally{if(valid(id,version)){loading=null;render();}}})();return loading;
  }
  function facts(d,rows){const list=el('dl','','commercial-facts');for(const [label,value]of rows)list.append(el('dt',label),el('dd',value??'未提供'));d.append(list);}
  function original(d,pdf,title){const frame=el('iframe');frame.title=title;frame.referrerPolicy='no-referrer';frame.setAttribute('sandbox','');privateFrame(frame,'src',pdf);d.append(frame);}
  function showPdf(d,blob,title,parent=d){const url=URL.createObjectURL(blob);original(parent,url,title);const release=()=>URL.revokeObjectURL(url);d.addEventListener('close',release,{once:true});return release;}
  function stop(d){const exit=async()=>{if(busy||mutations)return;if(dirty&&!await beforeLeave())return;dirty=false;d.close();d.remove();};d.append(button('閉じる',exit));d.addEventListener('cancel',e=>{e.preventDefault();exit();});}
  function status(d){const s=el('p');s.dataset.commercialStatus='';s.setAttribute('role','status');d.append(s);return s;}
  async function register(after=false){
    if(!snapshot)return;const projection=commercialProjection(snapshot);if(!projection.canRegister)return;
    const id=caseId,version=epoch,state=snapshot.state,current=projection.current;
    const d=dialog('見積を作成・登録する');facts(d,[['対象案件',getCase().event_name||getCase().inquiry_number],['見積版',current?'現在 第'+current.revision_number+'版。上書きせず新しい版を登録します。':'未登録から新規登録'],['処理','登録と見積単独の配送待ち準備。メールは送りません。']]);
    const file=el('input');file.type='file';file.accept='application/pdf,.pdf';
    const amount=el('input');amount.type='number';amount.min='1';amount.step='1';setPrivateAmount(amount,'');
    const tax=el('select');for(const [v,t]of Object.entries(TAX))tax.append(new Option(t,v));
    const conditions=el('textarea');conditions.maxLength=5000;
    const body=el('textarea');body.value='御見積書を添付いたします。内容をご確認ください。';body.maxLength=15000;
    const cc=el('input');cc.type='text';cc.placeholder='元メールの参加者のみ。カンマ区切り';
    d.append(field('見積PDF原本',file),field('見積金額（円・選択税区分に対応）',amount),field('税区分',tax),field('見積条件',conditions),field('見積のみ送る場合の案内本文',body),field('CC（任意）',cc));
    const review=el('section'),s=status(d);let payload=null,prepared=null,releasePdf=()=>{},draftVersion=0;
    const invalidate=()=>{++draftVersion;dirty=true;payload=null;prepared=null;releasePdf();review.replaceChildren();};for(const x of [file,amount,tax,conditions,body,cc])x.addEventListener('input',invalidate);
    const inspect=button('登録内容を確認（まだ登録しない）',async()=>{
      if(busy||!valid(id,version))return;busy=true;inspect.disabled=true;payload=null;prepared=null;releasePdf();review.replaceChildren();
      try{
        const draft=draftVersion,f=file.files?.[0],value=Number(readPrivateAmount(amount)),taxValue=tax.value,termsValue=conditions.value,bodyValue=body.value,ccValue=cc.value;
        if(!f||!Number.isSafeInteger(value)||value<1||f.size>5500000||!bodyValue.trim())throw Error('invalid_estimate');
        const bytes=new Uint8Array(await f.arrayBuffer());let raw='';for(let o=0;o<bytes.length;o+=32768)raw+=String.fromCharCode(...bytes.subarray(o,o+32768));
        const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
        const email=await request('composer_preview',{content_only:true,body:bodyValue,cc_addresses:ccValue.split(',').map(v=>v.trim()).filter(Boolean)});
        if(!valid(id,version)||!d.open)return;
        if(draftVersion!==draft){s.textContent='入力が変わりました。登録内容をもう一度確認してください。';return;}
        payload={expected_revision:state.revision,expected_current:state.current_estimate_revision_id||null,operation_id:crypto.randomUUID(),document_id:crypto.randomUUID(),filename:f.name,content_base64:window.btoa(raw),sha256:sha,amount_minor:value,currency:'JPY',tax_basis:taxValue,conditions:{notes:termsValue,source:'case_desk_owner_registration'},source_kind:'managed_send',source_sent_at:null,body:bodyValue,cc_addresses:email.cc_addresses||[],confirmation_mode:'LEGACY'};
        prepared={email,filename:f.name,sha};review.replaceChildren();facts(review,[['案件',getCase().event_name||getCase().inquiry_number],['登録PDF',f.name],['原本SHA256',sha],['金額',privateMoney(value)],['税区分',TAX[taxValue]],['To',email.recipient],['CC',(email.cc_addresses||[]).join(', ')||'なし'],['Gmail thread',email.gmail_thread_id],['件名',email.subject],['見積条件',termsValue||'追加条件なし']]);review.append(el('pre',email.body));releasePdf=showPdf(d,new Blob([bytes],{type:'application/pdf'}),'登録前の見積PDF原本',review);
        const check=el('input');check.type='checkbox';const commit=button('見積を登録する（メールは送信しない）',async()=>{
          if(busy||!check.checked||!payload||!prepared||!valid(id,version))return;busy=true;commit.disabled=true;inspect.disabled=true;
          try{const result=await request('issue_estimate',payload);if(!valid(id,version))return;dirty=false;payload=null;prepared=null;d.close();d.remove();snapshot=null;await load();await onChanged(id);if(after&&snapshot)await confirmation();return result;}
          catch(e){s.textContent=explain(e);payload=null;prepared=null;commit.disabled=true;}
          finally{busy=false;inspect.disabled=false;}
        });commit.disabled=true;check.addEventListener('change',()=>{commit.disabled=!check.checked;});review.append(field('対象案件・PDF・金額・税区分・条件と新しい版の登録を確認しました',check),commit);s.textContent='未登録です。確認後の登録ボタンで初めて正規見積と配送待ちを準備します。';
      }catch(e){s.textContent=explain(e);}finally{busy=false;inspect.disabled=false;}
    });d.append(inspect,review);stop(d);d.showModal();
  }
  async function estimateSend(){
    if(!snapshot)return;const p=commercialProjection(snapshot);if(!p.canEstimateSend)return;
    const id=caseId,version=epoch,d=dialog('見積だけを顧客に送る・送信前確認'),s=status(d);stop(d);d.showModal();
    try{
      const model=await request('estimate_send_preview',{job_id:p.estimateJob.id,estimate_revision_id:p.current.id});const blob=await request('document',{document_id:model.document.id},true);if(!valid(id,version)||!d.open)return;
      facts(d,[['案件',getCase().event_name||getCase().inquiry_number],['To',model.recipient],['CC',model.cc_addresses.join(', ')||'なし'],['Gmail thread',model.gmail_thread_id],['見積revision','第'+model.estimate.revision_number+'版'],['金額',privateMoney(model.estimate.amount_minor)],['税区分',TAX[model.estimate.tax_basis]||'未提供'],['PDF原本',model.document.filename],['SHA256',model.document.sha256],['件名',model.subject],['配送区分','見積のみ／既存outbox '+model.delivery_state],['authority fingerprint',model.fingerprint]]);d.append(el('pre',model.body));showPdf(d,blob,'現行見積PDF原本');
      const check=el('input');check.type='checkbox';const send=button('見積だけの最終送信確認へ',async()=>{
        if(busy||!check.checked||!valid(id,version))return;
        const final=dialog('見積のみ送信の最終確認');final.append(el('p','見積PDF原本を固定済み宛先へ送ります。正式受注確認は発行しません。'),button('送信せず戻る',()=>{final.close();final.remove();}),button('見積だけを送信する',async()=>{
          if(busy||!valid(id,version))return;busy=true;send.disabled=true;check.disabled=true;final.close();final.remove();
          try{await request('dispatch_outbox',{job_id:model.job_id,estimate_revision_id:model.estimate.id,expected_revision:model.expected_revision,preview_fingerprint:model.fingerprint});if(valid(id,version)){d.close();d.remove();snapshot=null;await load();await onChanged(id);}}
          catch(e){s.textContent=explain(e);send.disabled=true;}
          finally{busy=false;}
        }));final.showModal();
      });send.disabled=true;check.addEventListener('change',()=>{send.disabled=!check.checked;});d.append(field('宛先・本文・PDF・見積版・配送区分を確認しました',check),send);
    }catch(e){s.textContent=explain(e);}
  }
  async function confirmation(){
    if(!snapshot)return;const p=commercialProjection(snapshot);
    if(!p.current)return register(true);
    if(p.unresolved||p.confirmation.accepted)return;
    const active=p.confirmation.active,job=p.confirmation.delivery;
    if(active&&(!job||job.state!=='queued'))return;
    const id=caseId,version=epoch,authority=snapshot;
    const {openConfirmationPreviewForContext}=await import('../../js/pa-commercial-admin.js');
    if(!valid(id,version)||snapshot!==authority)return;
    const context={getCurrentCase:getCase,commercialRequest:request,refreshCommercial:async()=>{snapshot=null;await load();await onChanged(caseId);},trackDialog:track,
      previewElement:(tag,css,text)=>el(tag,text??'',css),formatMoney:privateMoney,
      prepareFrame:(frame,kind,value)=>{frame.referrerPolicy='no-referrer';if(kind==='srcdoc')frame.setAttribute('sandbox','');privateFrame(frame,kind,value);}};
    return openConfirmationPreviewForContext(context,active?{offer_id:active.id,outbox_id:job.id,version:active.version}:null);
  }
  function render(){
    if(!root?.isConnected)return;root.replaceChildren();const title=el('h2','見積・正式受注確認の業務操作');root.append(title);
    if(!snapshot){root.append(el('p',error?'商務正本を取得できません。見積・契約の有無は未確認です。':'商務正本を確認中…'));if(error)root.append(el('p',explain(error)),button('商務正本を再取得',load));return;}
    const p=commercialProjection(snapshot),state=p.confirmation;
    facts(root,[['正規見積',p.current?'現在 第'+p.current.revision_number+'版／'+(p.current.delivery?effectiveDeliveryState(p.current.delivery):'送信証拠なし'):'登録済み見積なし'],['正式確認',p.display.label],['保護',p.unresolved?'配送結果不明・処理中のため再送・再発行停止':state.accepted?'承諾済み契約を保護':state.active?'既存の発行済み確認を保護':'商務正本に基づく操作']]);
    const a=button('見積を作成・登録する',()=>register());a.disabled=!p.canRegister;
    const b=button('見積だけを顧客に送る・準備',estimateSend);b.disabled=!p.canEstimateSend;
    const c=button(p.current?'正式受注確認＋見積PDF・準備':'見積を登録して正式受注確認へ',confirmation);
    c.disabled=p.unresolved||!!state.accepted||!!state.active&&(!state.delivery||state.delivery.state!=='queued');
    const actions=el('div','','inlinebtns');actions.append(a,b,c,button('商務正本を再取得',async()=>{snapshot=null;await load();}));root.append(actions,el('p','見積登録・見積のみ送信・正式受注確認＋見積は別の操作です。プレビューを開いても発行・送信しません。'));
    if(p.current&&!p.estimateJob)root.append(el('p','この見積版に見積単独の送信待ち記録はありません。既存の送信済み・履歴を再送せず保護します。未送信の正規見積から正式受注確認を直接準備できます。'));
    const evidenceCase=caseId,evidenceEpoch=epoch;
    const openEvidence=candidate=>openChangeEvidence({request,dialog,stop,status,facts,showPdf,valid:()=>valid(evidenceCase,evidenceEpoch),getCase,setDirty:v=>{dirty=v;},setBusy:v=>{busy=v;},onChanged:async()=>{evidenceRead=null;snapshot=null;if(quoteMonitor)await quoteMonitor.check(evidenceCase).catch(()=>{});await load();},initialCandidate:candidate,quoteMonitor});
    quickAdopt=candidate=>openQuoteAdoption({candidate,request,dialog,valid:()=>valid(evidenceCase,evidenceEpoch),setBusy:v=>{busy=v;},onChanged:async()=>{evidenceRead=null;snapshot=null;await load();},details:openEvidence});
    if(documents){
      documentAssets ||= createPrivateAssets({requestBlob:item=>request(item.source_ref.action,item.source_ref.payload,true),authorize:async()=>{const auth=await getSession();if(!auth?.access_token||!valid(evidenceCase,evidenceEpoch))throw Error('case_changed');},isCurrent:()=>valid(evidenceCase,evidenceEpoch)});
      const accepted=snapshot.offers.filter(o=>o.state==='accepted'&&Number.isFinite(Date.parse(o.confirmed_at))),authority=JSON.stringify(accepted.map(o=>[o.id,o.confirmed_at]));
      if(evidenceAuthority!==authority){evidenceAuthority=authority;evidenceRead=null;}
      documents.connect({request,assets:documentAssets,openEvidence,adoptEvidence:simpleAdoption?quickAdopt:null,monitor:quoteMonitor,caseId:evidenceCase,onDecision:(candidate,kind)=>openCandidateDecision({candidate,kind,caseId:evidenceCase,monitor:quoteMonitor,dialog,stop,status,valid:()=>valid(evidenceCase,evidenceEpoch),setDirty:v=>{dirty=v;},setBusy:v=>{busy=v;}}),resolve:()=>evidenceRead ||= accepted.length?(quoteMonitor?resolveMonitoredOrderDocuments(request,evidenceCase):resolveOrderDocuments(request,evidenceCase)):Promise.resolve({state:{history:[]},original:null,notice:'正式受注の確定日時は未特定です。登録見積と履歴から確認してください。'})});
    }else mountChangeEvidenceSummary(root,snapshot,openEvidence);
    const history=el('details');history.append(el('summary','商務正本の配送・確認履歴'));for(const o of snapshot.offers)history.append(el('p','正式確認 #'+o.version+'／'+o.state+'／保存期限 '+(o.expires_at||'未提供')));for(const j of snapshot.outbox)history.append(el('p',j.job_kind+'／'+effectiveDeliveryState(j)+'／'+(j.finished_at||j.created_at||'日時未提供')));root.append(history);
  }
  function mount(host,documentView=null){const id=getCase()?.id;if(!id)return;if(caseId!==id){clear();caseId=id;}root=host;documents=documentView;render();if(!snapshot&&!loading&&!error)load();}
  return {mount,beforeLeave,clear,async originalIndex(id){if(!id||getCase()?.id!==id)throw Error('case_changed');if(caseId!==id){clear();caseId=id;}const value=await request('original_index');if(value?.case_id!==id||!value.read_projection)throw Error('incomplete_commercial_snapshot');return value;},async downloadOriginal(input){const id=getCase()?.id;if(!id||input.case_id!==id||Boolean(input.document_id)===Boolean(input.contract_id))throw Error('case_changed');if(caseId!==id){clear();caseId=id;}return request(input.document_id?'document':'change_evidence_contract_pdf',input,true);},async replyDocument(action,input){if(!['reply_document_review','reply_document_adopt','sent_quote_preview','sent_quote_adopt','sent_quote_status'].includes(action))throw Error('case_changed');const id=getCase()?.id;if(!id)throw Error('case_changed');if(caseId!==id){clear();caseId=id;}return request(action,input);},setSimpleAdoption(value){simpleAdoption=value===true;},adoptQuote(candidate){if(simpleAdoption&&quickAdopt)return quickAdopt(candidate);},setQuoteMonitor(value){quoteMonitor=value;evidenceRead=null;},refresh:async()=>{snapshot=null;error=null;await load();}};
}

// Case-scoped read projections must survive disposal of tab-specific write forms.
export function createCommercialProjectionRead({getCase,getSession,onAuthFailure=()=>{},fetchImpl=fetch}){
 let epoch=0;const controllers=new Set();
 return {clear(){++epoch;for(const c of controllers)c.abort();controllers.clear();},async read(action,id){
  if(!['original_index','billing_index'].includes(action)||getCase()?.id!==id)throw Error('case_changed');
  const g=epoch,auth=await getSession();if(!auth?.access_token||g!==epoch||getCase()?.id!==id)throw Error('case_changed');
  const c=new AbortController();controllers.add(c);const timer=setTimeout(()=>c.abort(),25000);
  try{const r=await fetchImpl('/api/pa-mail?surface=commercial',{method:'POST',cache:'no-store',redirect:'error',signal:c.signal,headers:{Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json'},body:JSON.stringify({action,case_id:id})});
   if(g!==epoch||getCase()?.id!==id)throw Error('case_changed');
   const p=await r.json();if(!r.ok||p.ok!==true){const e=Error(p.code||'commercial_request_failed');e.code=e.message;e.status=r.status;if(r.status===401||r.status===403&&p.code!=='invalid_origin')onAuthFailure();throw e;}
   if(p.result?.case_id!==id||p.result.read_projection!==true||!Array.isArray(p.result.billings))throw Error('incomplete_commercial_snapshot');return p.result;
  }finally{clearTimeout(timer);controllers.delete(c);}
 }};
}
