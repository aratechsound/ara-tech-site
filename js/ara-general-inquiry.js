const form=document.getElementById('contact-form'),message=document.querySelector('[data-fs-error]');
let enabled=false,key=crypto.randomUUID();
const extra=document.getElementById('general-case-fields');extra.querySelectorAll('input,select').forEach(field=>field.disabled=true);
async function initialize(){
 let config={};try{const r=await fetch('/api/pa-inquiry?general_config=1');config=await r.json();enabled=config.enabled===true;}catch{}
 if(!enabled){
  window.formspree=window.formspree||function(){(window.formspree.q=window.formspree.q||[]).push(arguments);};
  window.formspree('initForm',{formElement:'#contact-form',formId:'mojqjwnr',onSuccess:()=>location.assign('thanks.html?sent=1')});
  const s=document.createElement('script');s.src='https://unpkg.com/@formspree/ajax@1';document.head.append(s);return;
 }
 form.action='/api/pa-inquiry';
 extra.hidden=false;extra.querySelectorAll('input,select').forEach(field=>field.disabled=false);
 if(config.spam_adapter==='turnstile'){const widget=document.createElement('div');widget.className='cf-turnstile';widget.dataset.sitekey=config.captcha_site_key;widget.dataset.action='general-inquiry';form.append(widget);const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js';document.head.append(script);}
 form.addEventListener('submit',async e=>{
  e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;message.style.display='block';message.textContent='受付を保存しています…';
  const value=id=>document.getElementById(id).value;
  const input={form_kind:'general',submission_key:key,case_type:value('case-type'),inquiry_category:value('inquiry-type'),customer_name:value('name'),email:value('email'),phone:value('tel'),subject:value('subject'),body:value('message'),organization_name:value('organization'),venue:value('location'),desired_period:value('desired-period'),website:value('website'),captcha_token:form.querySelector('[name="cf-turnstile-response"]')?.value||''};
  try{const r=await fetch(form.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok||!data.ok)throw Error(data.code||'受付失敗');message.textContent=`受付を保存しました。受付番号：${data.inquiry_number}`;form.dataset.inquiryNumber=data.inquiry_number;key=crypto.randomUUID();form.reset();}
  catch(error){message.textContent=`受付を確認できませんでした（${error.message}）。再試行では同じ受付識別子を使用します。`;}
  finally{button.disabled=false;}
 });
}
const preset=new URLSearchParams(location.search).get('case_type');if(preset&&document.querySelector(`#case-type option[value="${CSS.escape(preset)}"]`))document.getElementById('case-type').value=preset;
form.querySelector('[type=submit]').disabled=true;
initialize().finally(()=>{form.querySelector('[type=submit]').disabled=false;});
