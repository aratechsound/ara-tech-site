const quoteSelection=q=>Object.fromEntries(['source','estimate_id','message_id','thread_id','attachment_id','part_id','sha256','amount_minor','tax_basis','issued_at'].filter(k=>q[k]!=null).map(k=>[k,q[k]]));

// Read-only projection of the existing evidence service. Nothing here saves,
// adopts, issues or sends. Ambiguous/partial detection never selects a winner.
export async function resolveOrderDocuments(request,caseId){
 let state=await request('change_evidence_candidates');
 if(state.case_id!==caseId)throw Error('change_evidence_mismatch');
 const contracts=[...state.contracts].filter(c=>Number.isFinite(Date.parse(c.confirmed_at))).sort((a,b)=>Date.parse(a.confirmed_at)-Date.parse(b.confirmed_at));
 const original=contracts[0]||null,adopted=state.current_agreement;
 if(adopted){
  const e=adopted.evidence;
  if(e?.case_id!==caseId||e.contract_id!==adopted.contract_id||!contracts.some(c=>c.id===e.contract_id)||!e.quote?.sha256)throw Error('change_evidence_mismatch');
  return {state,original,evidence:e,adopted,event_id:adopted.id,label:'Owner採用済み・現行合意見積'};
 }
 if(!original)return {state,original,notice:'正式受注の原本は未特定。登録・送信履歴から確認してください。'};
 state=await request('change_evidence_candidates',{detect:true});
 if(state.case_id!==caseId)throw Error('change_evidence_mismatch');
 const candidates=state.detected||[];
 if(state.detection_state==='incomplete'||state.detection_errors?.length||candidates.length!==1)return {state,original,notice:candidates.length>1?'変更見積候補が複数あります。証拠管理で手動選択してください。':'変更見積・承認証拠は未特定または取得未完了です。'};
 const candidate=candidates[0];
 if(candidate.contract_id!==original.id||!candidate.quote.sha256||!candidate.quote.amount_minor)return {state,original,notice:'候補の原本または金額が未確定です。証拠管理で確認してください。'};
 const payload={contract_id:original.id,quote:quoteSelection(candidate.quote),approval:{source:'gmail',...candidate.approval},owner_confirmed:false,owner_case_relation_confirmed:false,change_description:'',reason:''};
 const model=await request('change_evidence_preview',payload),e=model.evidence;
 if(e?.case_id!==caseId||e.contract_id!==original.id||e.quote?.sha256!==candidate.quote.sha256||e.approval?.message_id!==candidate.approval.message_id||e.approval.thread_id!==candidate.approval.thread_id||e.approval.status!=='verified'||!e.approval.exact_quote_reference||!e.approval.linked)return {state,original,notice:'候補と顧客承認の厳格な対応は未確認です。手動照合してください。'};
 return {state,original,evidence:e,payload,label:'送信済み・Owner未採用'};
}

// PAUI-053: initial authority is read without Gmail/PDF discovery. An adopted
// original is authoritative even while a later candidate is being inspected.
export async function resolveMonitoredOrderDocuments(request,caseId){
 const state=await request('change_evidence_candidates');
 if(state.case_id!==caseId)throw Error('change_evidence_mismatch');
 const original=[...(state.contracts||[])].filter(c=>Number.isFinite(Date.parse(c.confirmed_at))).sort((a,b)=>Date.parse(a.confirmed_at)-Date.parse(b.confirmed_at))[0]||null;
 const adopted=state.current_agreement;
 if(adopted){const e=adopted.evidence;if(e?.case_id!==caseId||e.contract_id!==adopted.contract_id||!state.contracts.some(c=>c.id===e.contract_id)||!e.quote?.sha256)throw Error('change_evidence_mismatch');return {state,original,evidence:e,adopted,event_id:adopted.id,label:'Owner採用済み・現行合意見積'};}
 return {state,original,notice:'現在の登録見積を表示。新しい変更候補は保存済み結果と差分から確認します。'};
}
