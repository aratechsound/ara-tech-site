const fields = [
  {key:'customer_name',label:'お客様名・担当者名',max:160,required:true},
  {key:'organization_name',label:'団体・会社名',max:200},
  {key:'phone',label:'電話',max:60,type:'tel'},
  {key:'event_name',label:'イベント名',max:240},
  {key:'venue',label:'会場',max:300}
];
const allowlist = new Map(fields.map(field=>[field.key,field]));
const caseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function saveCaseBasics(client,{id,revision,changes,stillCurrent}){
  const entries=Object.entries(changes);
  if(!caseIdPattern.test(id)||!Number.isSafeInteger(revision)||revision<1||!entries.length||
    entries.some(([key,value])=>{
      const field=allowlist.get(key);
      return !field||(value===null?field.required:typeof value!=='string'||!value.trim()||value.length>field.max);
    }))throw Error('invalid_case_basics');
  if(!stillCurrent())throw Error('case_changed');
  const {data,error}=await client.from('pa_inquiries').update(changes)
    .eq('id',id).eq('revision',revision).is('deleted_at',null).select('id,revision').maybeSingle();
  if(error)throw Error('case_basics_save_unknown');
  if(!data)throw Error('case_basics_conflict');
  if(data.id!==id||data.revision!==revision+1)throw Error('case_basics_save_unknown');
  return data;
}

export function createCaseBasicsEditor(){
  let active;
  function close(){
    if(!active)return;
    const {dialog}=active;
    active=null;
    dialog.close();
    dialog.remove();
  }
  return {
    close,
    open({inquiry,stillCurrent,save,readback}){
      if(!stillCurrent())return;
      close();
      const dialog=document.createElement('dialog');
      const heading=document.createElement('h3');
      const form=document.createElement('form');
      const inputs=document.createElement('fieldset');
      const intro=document.createElement('p');
      const status=document.createElement('p');
      const actions=document.createElement('div');
      const cancel=document.createElement('button');
      const submit=document.createElement('button');
      const original={};
      let busy=false, locked=false;
      dialog.className='case-basics-dialog';
      dialog.setAttribute('aria-label','案件の基本情報を編集');
      // The form accepts only non-financial case fields.
      dialog.dataset.externalMoneyGuard='';
      heading.textContent='案件の基本情報を編集';
      intro.textContent=inquiry.inquiry_number||'';
      status.setAttribute('role','status');
      for(const field of fields){
        const label=document.createElement('label');
        const input=document.createElement('input');
        label.textContent=field.label;
        if(field.type)input.type=field.type;
        input.name=field.key;
        input.maxLength=field.max;
        input.required=Boolean(field.required);
        input.value=original[field.key]=inquiry[field.key]??'';
        label.append(input);
        inputs.append(label);
      }
      actions.className='inlinebtns';
      cancel.type='button';cancel.className='lightbtn';cancel.textContent='閉じる';
      submit.type='submit';submit.className='action blue';submit.textContent='基本情報を保存';
      actions.append(cancel,submit);form.append(inputs,status,actions);
      dialog.append(heading,intro,form);
      cancel.addEventListener('click',()=>{if(!busy)close();});
      dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
      dialog.addEventListener('close',()=>{if(active?.dialog===dialog)close();});
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        if(busy||locked||!stillCurrent())return;
        const changes=Object.fromEntries(fields.flatMap(({key})=>{
          const value=form.elements[key].value.trim();
          return value===original[key].trim()?[]:[[key,value||null]];
        }));
        if(!Object.keys(changes).length){status.textContent='変更はありません。';return;}
        if(changes.customer_name===null){status.textContent='お客様名・担当者名を入力してください。';return;}
        busy=true;
        inputs.disabled=submit.disabled=cancel.disabled=true;
        status.textContent='保存を確認しています…';
        try{
          const result=await save({id:inquiry.id,revision:inquiry.revision,changes});
          if(active?.dialog!==dialog||!stillCurrent())return;
          await readback(result,changes);
          if(active?.dialog===dialog)close();
        }catch(error){
          if(active?.dialog===dialog){
            locked=true;
            status.textContent=error.message==='case_basics_conflict'
              ?'別の操作で案件が更新されました。案件一覧を再取得してから編集してください。'
              :'保存結果を確認できません。案件一覧を再取得して保存内容を確認してください。';
          }
        }finally{
          busy=false;
          inputs.disabled=submit.disabled=locked;
          cancel.disabled=false;
        }
      });
      active={dialog};
      document.body.append(dialog);
      dialog.showModal();
    }
  };
}
