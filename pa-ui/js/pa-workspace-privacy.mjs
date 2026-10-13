// Amounts stay in memory. Hidden DOM, attributes and storage contain no amount.
import {protectMoneyText} from './money-text.mjs';
let serial=0, timer=null, scope=null;
const tokens=new Map(), values=new WeakMap(), inputs=new Map(), frames=new Map();
const tokenPattern=/\[\[PRIVATE_MONEY_\d+\]\]/g;
const container=node=>node.closest('dialog') || node.closest('[data-workspace-tab]') || document.getElementById('detail-card');
const visible=node=>!!node.getClientRects().length&&!node.closest('[hidden],.hidden');
export function privateMoney(value,currency='JPY') {
 if(value==null)return '未設定';
 const t=`[[PRIVATE_MONEY_${++serial}]]`;
 tokens.set(t,new Intl.NumberFormat('ja-JP',{style:'currency',currency,maximumFractionDigits:currency==='JPY'?0:2}).format(Number(value)));return t;
}
export function privateText(text='') {return protectMoneyText(text,v=>{const t=`[[PRIVATE_MONEY_${++serial}]]`;tokens.set(t,v);return t;});}
export function setPrivateAmount(input,value) {inputs.set(input,String(value??''));input.value='';input.readOnly=true;input.placeholder='金額非表示';input.dataset.privateAmount='true';}
export function readPrivateAmount(input) {return inputs.has(input)?inputs.get(input):input.value;}
export function privateFrame(frame,kind,value) {frames.set(frame,{kind,value});frame.removeAttribute('src');frame.removeAttribute('srcdoc');frame.title='明示表示時のみ原本プレビュー';frame.hidden=true;}
function renderTokens(root=document.body) {
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const pending=[];let n;
 while(n=walker.nextNode())if(n.parentElement?.tagName!=='SCRIPT' && /\[\[PRIVATE_MONEY_\d+\]\]/.test(n.data))pending.push(n);
 for(const n of pending){const frag=document.createDocumentFragment();let p=0;
  for(const m of n.data.matchAll(tokenPattern)){frag.append(n.data.slice(p,m.index));const span=document.createElement('span');span.className='private-money';values.set(span,tokens.get(m[0])||'未設定');span.textContent=scope&&container(span)===scope?values.get(span):'金額非表示';frag.append(span);p=m.index+m[0].length;}frag.append(n.data.slice(p));n.replaceWith(frag);
 }
 for(const e of root.querySelectorAll?.('[title],[aria-label]')||[])for(const a of ['title','aria-label'])if(e.hasAttribute(a)&&/PRIVATE_MONEY/.test(e.getAttribute(a)))e.setAttribute(a,'金額非表示');
 for(const span of root.querySelectorAll?.('.private-money')||[])span.textContent=scope&&container(span)===scope&&visible(span)?values.get(span):'金額非表示';
 for(const [input,value] of inputs)if(input.isConnected){const shown=scope&&container(input)===scope&&visible(input);input.value=shown?value:'';input.readOnly=!shown;}
}
export function resetPrivacy(){document.dispatchEvent(new Event('privacy-reset'));clearTimeout(timer);timer=null;scope=null;for(const span of document.querySelectorAll('.private-money'))span.textContent='金額非表示';for(const input of inputs.keys()){input.value='';input.readOnly=true;}for(const [frame]of frames){frame.removeAttribute('src');frame.removeAttribute('srcdoc');frame.hidden=true;}document.querySelectorAll('[data-money-toggle],#workspace-reveal').forEach(b=>b.setAttribute('aria-pressed','false'));}
export function revealPrivacy(target){resetPrivacy();scope=target;renderTokens();for(const [frame,v]of frames)if(frame.isConnected&&container(frame)===scope){frame[v.kind]=v.value;frame.hidden=false;}document.querySelectorAll('[data-money-toggle],#workspace-reveal').forEach(b=>{if(container(b)===scope||b.id==='workspace-reveal')b.setAttribute('aria-pressed','true');});document.dispatchEvent(new CustomEvent('privacy-reveal',{detail:{scope}}));timer=setTimeout(resetPrivacy,30000);}
document.addEventListener('input',e=>{if(inputs.has(e.target))inputs.set(e.target,e.target.value);});
document.addEventListener('click',e=>{const b=e.target.closest('[data-money-toggle],#workspace-reveal');if(b){const target=b.closest('dialog')||document.querySelector('[data-workspace-tab]:not([hidden])')||document.getElementById('detail-card');if(scope===target)resetPrivacy();else revealPrivacy(target);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)resetPrivacy();});window.addEventListener('blur',resetPrivacy);window.addEventListener('pagehide',resetPrivacy);document.addEventListener('close',resetPrivacy,true);
const observer=new MutationObserver(records=>{observer.disconnect();for(const r of records)if(r.type==='childList')for(const n of r.addedNodes)if(n.nodeType===1){if(n.tagName==='DIALOG'&&!n.dataset.externalMoneyGuard){resetPrivacy();if(!n.querySelector('[data-money-toggle]')){const b=document.createElement('button');b.type='button';b.dataset.moneyToggle='true';b.textContent='この操作画面の金額を表示';n.prepend(b);}}renderTokens(n);}else if(n.nodeType===3&&n.parentElement)renderTokens(n.parentElement);observer.observe(document.body,{childList:true,subtree:true});});
observer.observe(document.body,{childList:true,subtree:true});
