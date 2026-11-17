const caseTypes = {
  PA_EVENT: 'PA・イベント音響',
  AUDIO_INSTALL: '音響設備施工',
  AV_INSTALL: 'AV設備施工',
  LIGHTING_INSTALL: '照明設備施工',
  VIDEO_INSTALL: '映像設備施工',
  EQUIPMENT_RENTAL: '機材レンタル',
  OTHER: 'その他'
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lengths = {customer_name:160, email:320, organization_name:200, phone:60,
  event_name:240, venue:300, event_time:120, request_summary:5000};
const rowFields = 'id,inquiry_number,created_by,submission_source,deleted_at';

export async function manualIntakeRequest(client,{id,ownerId,values,stillCurrent}){
  if(!uuid.test(id)||!stillCurrent())throw Error('manual_intake_unavailable');
  if(values){
    const fields=Object.fromEntries(Object.entries(lengths).map(([name,limit])=>{
      const value=String(values[name]??'').trim();
      if(value.length>limit)throw Error('invalid_manual_intake');
      return [name,value||null];
    }));
    const {case_type,event_date,received_at}=values;
    const receivedTime=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(received_at)
      ?new Date(received_at+':00+09:00'):null;
    if(!Object.hasOwn(caseTypes,case_type)||!fields.customer_name||!fields.email||
      !/^[^\s@]+@[^\s@]+$/u.test(fields.email)||
      !Number.isFinite(receivedTime?.valueOf())||
      (event_date&&!/^\d{4}-\d{2}-\d{2}$/u.test(event_date)))throw Error('invalid_manual_intake');
    const {error}=await client.from('pa_inquiries').insert({
      ...fields,id,case_type,event_date:event_date||null,received_at:receivedTime.toISOString(),
      submission_source:'manual',status:'new_inquiry'
    }).abortSignal(AbortSignal.timeout(25000));
    if(error)throw Error('manual_intake_write_unverified');
    return;
  }
  const {data,error}=await client.from('pa_inquiries').select(rowFields).eq('id',id)
    .abortSignal(AbortSignal.timeout(25000)).maybeSingle();
  if(error||data&&(data.id!==id||data.created_by!==ownerId||
    data.submission_source!=='manual'||data.deleted_at||!data.inquiry_number)){
    throw Error('manual_intake_read_unverified');
  }
  return data;
}

export function createManualIntake(){
  let active;
  function close(){
    if(!active)return;
    const dialog=active;
    active=null;
    dialog.close();
    dialog.remove();
  }
  return {close,open({ownerId,stillCurrent,request,onSaved}){
    if(!stillCurrent()||active)return;
    const storageKey='pa-desk-manual-intake:'+ownerId;
    const dialog=document.createElement('dialog');
    active=dialog;
    dialog.className='case-basics-dialog manual-intake-dialog';
    dialog.setAttribute('aria-labelledby','manual-intake-heading');
    dialog.innerHTML=`
      <h3 id="manual-intake-heading">問い合わせを手入力</h3>
      <p>電話・口頭・紹介などで受けた問い合わせを登録します。</p>
      <form>
        <fieldset>
          <label>受付日時（JST）<input name="received_at" type="datetime-local" required></label>
          <label>案件種別<select name="case_type" required><option value="">選択してください</option></select></label>
          <label>お客様名・担当者名<input name="customer_name" required></label>
          <label>メールアドレス<input name="email" type="email" required></label>
          <label>団体・会社名<input name="organization_name"></label>
          <label>電話<input name="phone" type="tel"></label>
          <label>イベント名<input name="event_name"></label>
          <label>開催希望日<input name="event_date" type="date"></label>
          <label>開催希望時間<input name="event_time"></label>
          <label>会場<input name="venue"></label>
          <label>依頼概要<textarea name="request_summary" rows="3"></textarea></label>
        </fieldset>
        <p role="status" aria-live="polite"></p>
        <div class="inlinebtns">
          <button type="button" class="lightbtn" data-close>閉じる</button>
          <button type="button" class="action quiet" data-check hidden>登録結果を確認</button>
          <button type="submit" class="action blue">問い合わせを登録</button>
        </div>
      </form>`;
    const form=dialog.querySelector('form'),fields=form.querySelector('fieldset');
    const submit=form.querySelector('[type="submit"]'),check=form.querySelector('[data-check]');
    const cancel=form.querySelector('[data-close]'),status=form.querySelector('[role="status"]');
    form.elements.received_at.value=new Date(Date.now()+9*60*60*1000).toISOString().slice(0,16);
    for(const [value,label] of Object.entries(caseTypes))form.elements.case_type.add(new Option(label,value));
    for(const [name,limit] of Object.entries(lengths))form.elements[name].maxLength=limit;
    let id=null,busy=false,locked=false,unavailable=false;
    const live=()=>active===dialog&&stillCurrent();
    function update(){
      fields.disabled=submit.disabled=busy||locked||unavailable;
      cancel.disabled=busy;
      check.hidden=!id||unavailable;
      check.disabled=busy;
      submit.textContent=id?'同じ受付として登録を再試行':'問い合わせを登録';
    }
    try{
      id=sessionStorage.getItem(storageKey);
      if(id&&!uuid.test(id))throw Error('invalid_pending_id');
      if(id){
        locked=true;
        status.textContent='前回の登録結果を確認してください。';
      }
    }catch{
      unavailable=true;
      status.textContent='このタブで登録結果を安全に保持できません。';
    }
    update();
    cancel.addEventListener('click',close);
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.addEventListener('close',()=>{if(active===dialog)close();});
    async function verify(){
      try{
        const row=await request({id,ownerId,stillCurrent:live});
        if(!live())return;
        if(row){
          sessionStorage.removeItem(storageKey);
          close();
          onSaved(row);
          return;
        }
        locked=false;
        status.textContent='登録を確認できませんでした。再試行する場合は、同じ問い合わせの内容で登録してください。';
      }catch{
        if(live()){
          locked=true;
          status.textContent='登録結果を確認できません。通信状態を確認してから「登録結果を確認」を押してください。';
        }
      }
    }
    async function run(values){
      if(busy||unavailable||!live()||values&&locked)return;
      if(!id){
        try{
          id=crypto.randomUUID();
          sessionStorage.setItem(storageKey,id);
        }catch{
          unavailable=true;
          status.textContent='このタブで登録結果を安全に保持できません。';
          update();
          return;
        }
      }
      busy=true;
      status.textContent=values?'登録しています…':'登録結果を確認しています…';
      update();
      try{
        if(values){
          try{await request({id,ownerId,values,stillCurrent:live});}
          catch(error){
            if(error.message==='invalid_manual_intake'){
              if(live())status.textContent='入力内容を確認してください。';
              return;
            }
          }
        }
        if(live())await verify();
      }finally{
        busy=false;
        if(live())update();
      }
    }
    check.addEventListener('click',()=>void run());
    form.addEventListener('submit',event=>{
      event.preventDefault();
      void run(Object.fromEntries(new FormData(form)));
    });
    document.body.append(dialog);
    dialog.showModal();
  }};
}
