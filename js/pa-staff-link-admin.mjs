import {createLocaleController,languagePicker,eventInstant,instantToLocal,localToInstant} from './portal-i18n.mjs';
export function initStaffLinkManagement(portalRequest){
 const button=document.createElement('button');button.type='button';button.className='edit-mode-toggle';document.querySelector('.portal-tools').append(button);
 let dialog,issuedLink=null;
 const locale=createLocaleController(()=>{button.textContent=locale.t('manage');if(dialog?.open)open(issuedLink).catch(()=>{});});button.textContent=locale.t('manage');
 const run=(grade,action,extra={})=>portalRequest(`staff_link_${action}`,{grade,...extra});
 async function open(issued=null){
  const statuses=await Promise.all(['GENERAL','TECHNICAL'].map(g=>run(g,'status')));
  dialog?.remove();dialog=document.createElement('dialog');dialog.className='staff-manager';issuedLink=issued;
  const currentDialog=dialog;
  dialog.addEventListener('close',()=>{currentDialog.querySelector('[data-issued-url]')?.remove();if(dialog===currentDialog)issuedLink=null;});
  const header=document.createElement('div');header.className='staff-actions';const h=document.createElement('h2');h.textContent=locale.t('manage');const close=document.createElement('button');close.textContent=locale.t('close');close.addEventListener('click',()=>dialog.close());header.append(h,languagePicker(locale),close);dialog.append(header);
  const notice=document.createElement('p');notice.textContent=locale.t('content');dialog.append(notice);const error=document.createElement('p');error.setAttribute('role','status');dialog.append(error);
  const control=(label,type,value='')=>{const wrap=document.createElement('label'),input=document.createElement('input');wrap.textContent=locale.t(label);input.type=type;input.value=value;wrap.append(input);return{wrap,input};};
  const cfg=document.createElement('form');const timezone=control('timezone','text',statuses[0].timezone),end=control('end','datetime-local',instantToLocal(statuses[0].event_end_at,statuses[0].timezone));const hint=document.createElement('p');hint.textContent=`${locale.t('hint')} ${locale.t('localTime')}`;const save=document.createElement('button');save.textContent=locale.t('settings');cfg.append(timezone.wrap,end.wrap,hint,save);cfg.addEventListener('submit',async e=>{e.preventDefault();try{await run('GENERAL','settings',{timezone:timezone.input.value,event_end_at:localToInstant(end.input.value,timezone.input.value)});await open();}catch{error.textContent=locale.t('error');}});dialog.append(cfg);
  for(const status of statuses){
   const section=document.createElement('section'),title=document.createElement('h3'),state=document.createElement('p');title.textContent=locale.t(status.grade);state.textContent=`${locale.t(status.active?'active':'inactive')} · ${locale.t('expiry')}: ${eventInstant(status.expires_at,locale.locale,status.timezone)}`;const expiry=control('expiry','datetime-local',instantToLocal(status.expires_at || status.default_expires_at,status.timezone));const actions=document.createElement('div');actions.className='staff-actions';
   for(const action of status.exists?['rotate','revoke','expiry']:['create']){
    const b=document.createElement('button');b.type='button';b.textContent=locale.t(action==='expiry'?'saveExpiry':action);b.addEventListener('click',async()=>{if(action==='rotate'&&!confirm(locale.t('confirmRotate')))return;if(action==='revoke'&&!confirm(locale.t('confirmRevoke')))return;b.disabled=true;try{const r=await run(status.grade,action,{expires_at:action==='revoke'?null:localToInstant(expiry.input.value,status.timezone)});await open(['create','rotate'].includes(action)?{grade:status.grade,share_url:r.share_url}:null);}catch{error.textContent=locale.t('error');b.disabled=false;}});actions.append(b);
   }
   section.append(title,state,expiry.wrap,actions);
   if(status.active&&issued?.grade===status.grade&&issued.share_url){
    const url=new URL(issued.share_url,location.origin).href,wrap=document.createElement('div'),code=document.createElement('code'),message=document.createElement('p');wrap.setAttribute('data-issued-url','');code.textContent=url;message.textContent=locale.t('issuedNotice');const copy=document.createElement('button');copy.type='button';copy.textContent=locale.t('copy');copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(url);copy.textContent=locale.t('copied');}catch{error.textContent=locale.t('error');}});wrap.append(message,code,copy);section.append(wrap);
   }else if(status.active){const hold=document.createElement('p');hold.textContent=locale.t('activeNotice');section.append(hold);}
   dialog.append(section);
  }
  document.body.append(dialog);dialog.showModal();
 }
 button.addEventListener('click',()=>open().catch(()=>alert(locale.t('error'))));
}
