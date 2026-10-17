import {createGallery} from './gallery.mjs';
import {privateText} from './pa-workspace-privacy.mjs';
const shaPattern=/^[a-f0-9]{64}$/u;
export const quoteSourceKey=(caseId,item)=>JSON.stringify([caseId,item.asset_kind,item.asset_id,item.message_id||'',item.gmail_thread_id||'',item.part_id||'']);
// Index SHA is an expectation, never proof of the bytes just read.
export function groupQuoteHistory(items,proofs,caseId){
 const groups=new Map(),result=[];
 for(const item of items){
  if(item.case_id&&item.case_id!==caseId)continue;
  const proof=proofs.get(quoteSourceKey(caseId,item));const verified=proof?.verified===true&&proof.case_id===caseId&&shaPattern.test(proof.sha256||'')&&(!item.sha256||item.sha256===proof.sha256);
  const key=verified?caseId+':'+proof.sha256:'unverified:'+item.key;
  let group=groups.get(key);if(!group){group={key:'quote-history:'+key,origins:[],verified_sha256:verified?proof.sha256:null};groups.set(key,group);result.push(group);}group.origins.push(item);
 }
 return result.map(group=>{const registered=group.origins.filter(i=>i.source==='commercial');const representative=registered.find(i=>/[一-龠ぁ-んァ-ヶ]/u.test(i.filename||''))||registered[0]||group.origins[0];return {...representative,...group,representative,title:representative.filename,original_state:group.verified_sha256?'PDF実バイトSHA256一致・表示統合（正式採用とは別）':'原本一致未確認・個別表示'};});
}
const el=(tag,text='')=>{const n=document.createElement(tag);n.textContent=privateText(String(text));return n;};
export function createQuoteHistory({caseId,assets,isCurrent,previewScope,monitor,onAdopt,registrationActions}){
 const proofs=new Map(),failures=new Set();let active=true,host=null,items=[],gallery=null,checking=false,version=0,unsubscribe=null;
 const safe=()=>active&&isCurrent();
 const candidate=item=>{const found=(monitor?.getFull(caseId)?.candidates||[]).filter(c=>c.evidence?.quote.sha256===item.verified_sha256&&c.decision?.event_kind!=='excluded');return found.length===1&&!found[0].stale&&!(found[0].origins?.length>1)&&found[0].evidence.approval?.status==='verified'&&found[0].evidence.approval.exact_quote_reference&&found[0].evidence.approval.linked?found[0]:null;};
 async function verify(item,blob){
  if(!safe()||item.case_id&&item.case_id!==caseId)throw Error('case_changed');
  if(blob.type!=='application/pdf'||blob.size>8*1024*1024||blob.size<5)throw Error('asset_identity_mismatch');
  const data=await blob.arrayBuffer();const magic=String.fromCharCode(...new Uint8Array(data,0,5));if(magic!=='%PDF-')throw Error('asset_identity_mismatch');
  const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');if(!safe())throw Error('case_changed');
  if(item.sha256&&item.sha256!==sha)throw Error('asset_identity_mismatch');
  const key=quoteSourceKey(caseId,item),changed=!proofs.has(key);proofs.set(key,{case_id:caseId,sha256:sha,verified:true});return changed;
 }
 const proxy={...assets,async record(item,options){const original=item.representative||item;const record=await assets.record(original,options);try{if(await verify(original,record.blob)&&safe())queueMicrotask(()=>{if(safe()&&host)render();});return record;}catch(e){assets.release(record);throw e;}}};
 function render(){
  if(!safe()||!host)return;const groups=groupQuoteHistory(items,proofs,caseId);gallery?.dispose();
  gallery=createGallery({assets:proxy,previewScope,isCurrent:safe,previewActions:(item,controls)=>{const download=el('button','PDFをダウンロード');download.onclick=async()=>{download.disabled=true;let record;try{record=await proxy.record(item,{fresh:true});if(!safe()){assets.release(record);return;}const a=el('a');a.href=record.url;a.download=item.filename;document.body.append(a);a.click();a.remove();controls.closest('dialog')?.addEventListener('close',()=>assets.release(record),{once:true});}catch{if(record)assets.release(record);if(safe())download.textContent='原本取得未完了・再確認してください';}finally{download.disabled=false;}};controls.append(download);registrationActions?.(item,controls);const c=candidate(item);if(c){const b=el('button','この見積を正式採用');b.onclick=()=>onAdopt(c);controls.append(b);}}});
  const grid=el('div');grid.className='quote-history-cards';host.classList.add('quote-history');host.replaceChildren(grid);gallery.mount(grid,groups,{compact:true});
  for(const [index,card]of [...host.querySelectorAll('.material-card')].entries()){
   const group=groups[index],details=el('details'),summary=el('summary','登録・送信履歴 '+group.origins.length+'出典');details.append(summary);
   for(const origin of group.origins){
    const row=el('section');row.append(el('p',origin.source==='commercial'?'正式登録原本・revision '+origin.version_label:'Gmail送信記録'));
    const values=[['原本ファイル名',origin.filename],['登録日時',origin.updated_at],['送信日時',origin.source_at],['宛先',origin.source_address],['DB document ID',origin.asset_kind==='document'?origin.asset_id:null],['Gmail message',origin.message_id],['thread',origin.gmail_thread_id],['MIME part',origin.part_id],['添付ID',origin.asset_kind==='mail'?origin.asset_id:null],['PDF SHA256',group.verified_sha256||'未確認']];
    for(const [label,value]of values)if(value)row.append(el('p',label+'：'+value));
    for(const p of origin.source_records||[])row.append(el('p','同一メールの索引出典：'+JSON.stringify(p)));
    const view=el('button','この出典のPDF原本を確認');view.onclick=()=>gallery?.openPreview({...origin,verified_sha256:group.verified_sha256});row.append(view);
    if(origin.gmail_thread_id&&/^[a-f0-9]+$/iu.test(origin.gmail_thread_id)){const a=el('a','Gmail送信原本への参照');a.href='https://mail.google.com/mail/u/0/#all/'+origin.gmail_thread_id;a.target='_blank';a.rel='noopener noreferrer';row.append(a);}details.append(row);
   }
   card.querySelector('.material-meta').append(details);
  }
  const message=el('p',failures.size?'原本照合の一部が未完了です。未確認のPDFは統合していません。':'同じPDFは1カード、各送信・登録履歴は保持しています。');message.setAttribute('role','status');host.prepend(message);const b=el('button','未確認の原本を照合（最大3件）');b.className='lightbtn';b.disabled=checking;b.onclick=()=>check(true);host.prepend(b);
 }
 async function check(retry=false){
  if(checking||!safe()||!host)return;checking=true;const ticket=version;render();
  if(retry)failures.clear();
  try{let count=0;for(const item of items){if(count>=3)break;const key=quoteSourceKey(caseId,item);if(!item.asset_id||proofs.has(key)||failures.has(key))continue;++count;let record;
    try{record=await assets.record(item);await verify(item,record.blob);}catch{failures.add(key);}if(!safe()||ticket!==version)return;
   }if(safe()&&ticket===version)render();
  }finally{checking=false;if(safe()&&host)render();}
 }
 return {mount(target,next){host=target;items=next.map(item=>({...item,case_id:item.case_id||caseId}));++version;render();unsubscribe?.();unsubscribe=monitor?.subscribe(caseId,()=>{if(safe()&&host)render();});void check();},unmount(){++version;unsubscribe?.();unsubscribe=null;gallery?.dispose();gallery=null;host=null;},dispose(){active=false;++version;unsubscribe?.();gallery?.dispose();proofs.clear();failures.clear();items=[];host=null;}};
}
