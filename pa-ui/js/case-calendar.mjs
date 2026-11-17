import {statusText} from './model.mjs';

const weekdays=['日','月','火','水','木','金','土'];
const cancelled=new Set(['cancelled','declined','schedule_unavailable']);
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});
const yyyyMmDd=date=>date.toISOString().slice(0,10);
const parseDate=value=>{
  if(!/^\d{4}-\d{2}-\d{2}$/u.test(value||''))return null;
  const date=new Date(value+'T00:00:00Z');
  return Number.isFinite(+date)&&yyyyMmDd(date)===value?date:null;
};

export function jstDate(now=new Date()){
  const parts=Object.fromEntries(dateFormat.formatToParts(now).map(({type,value})=>[type,value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}

export function caseCalendar(cases,month){
  const first=parseDate(month+'-01');
  if(!first)throw Error('invalid_calendar_month');
  const end=new Date(+first);
  end.setUTCMonth(end.getUTCMonth()+1);
  const start=new Date(+first);
  start.setUTCDate(start.getUTCDate()-start.getUTCDay());
  const entries=new Map();
  let undated=0;
  for(const item of cases){
    if(item.deleted_at)continue;
    const confirmed=parseDate(item.progress?.confirmed_event_date);
    const date=confirmed||parseDate(item.event_date);
    if(!date){undated++;continue;}
    if(date<first||date>=end)continue;
    const day=yyyyMmDd(date);
    const booked=Boolean(confirmed)&&!cancelled.has(item.status);
    const label=cancelled.has(item.status)?statusText(item):booked?'確保日':'開催希望日';
    const rows=entries.get(day)||[];
    rows.push({item,label});
    entries.set(day,rows);
  }
  const days=[];
  while(start<end||start.getUTCDay()!==0){
    const date=yyyyMmDd(start);
    days.push({date,day:start.getUTCDate(),inMonth:start>=first&&start<end});
    start.setUTCDate(start.getUTCDate()+1);
  }
  return {days,entries,undated};
}

export function createCaseCalendar({displayText,onSelect}){
  let dialog;
  function close(){
    if(!dialog)return;
    const target=dialog;dialog=null;target.close();target.remove();
  }
  function open(cases,initialDate){
    close();
    const today=jstDate();
    let selectedDay=parseDate(initialDate)?initialDate:today;
    let month=selectedDay.slice(0,7);
    const target=document.createElement('dialog');
    dialog=target;
    dialog.className='case-calendar-dialog';
    dialog.dataset.externalMoneyGuard='';
    dialog.setAttribute('aria-label','案件カレンダー');
    dialog.addEventListener('close',()=>{if(dialog===target)close();});
    const make=(tag,text,root)=>{
      const node=document.createElement(tag);
      if(text)node.textContent=text;
      root.append(node);return node;
    };
    const button=(text,root,click)=>{
      const node=make('button',text,root);node.type='button';node.className='lightbtn';
      node.addEventListener('click',click);return node;
    };
    make('h3','案件カレンダー',target);
    make('p','保存済みの開催希望日と確保日',target);
    const controls=make('div','',target);controls.className='calendar-controls';
    const shift=offset=>{
      const work=parseDate(month+'-01');
      work.setUTCMonth(work.getUTCMonth()+offset);
      month=yyyyMmDd(work).slice(0,7);selectedDay=month===today.slice(0,7)?today:month+'-01';
      render();
    };
    button('前月',controls,()=>shift(-1));
    const currentMonth=make('strong','',controls);
    button('翌月',controls,()=>shift(1));
    button('今月',controls,()=>{month=today.slice(0,7);selectedDay=today;render();});
    button('閉じる',controls,close);
    const grid=make('div','',target);grid.className='calendar-month';
    const picked=make('h4','',target);picked.setAttribute('aria-live','polite');
    const list=make('div','',target);list.className='calendar-cases';
    const undated=make('p','',target);
    const render=()=>{
      const view=caseCalendar(cases,month);
      currentMonth.textContent=Number(month.slice(0,4))+'年 '+Number(month.slice(-2))+'月';
      grid.replaceChildren();
      for(const weekday of weekdays)make('span',weekday,grid).className='calendar-weekday';
      for(const entry of view.days){
        if(!entry.inMonth){make('span','',grid);continue;}
        const count=view.entries.get(entry.date)?.length||0;
        const day=button(String(entry.day),grid,()=>{selectedDay=entry.date;render();grid.querySelector('[aria-pressed="true"]')?.focus();});
        day.setAttribute('aria-label',entry.date+' '+count+'件');
        day.setAttribute('aria-pressed',String(entry.date===selectedDay));
        if(entry.date===today)day.setAttribute('aria-current','date');
        if(count)make('small',count+'件',day);
      }
      picked.textContent=selectedDay;
      list.replaceChildren();
      const rows=view.entries.get(selectedDay)||[];
      for(const {item,label} of rows){
        const action=button('',list,()=>{close();onSelect(item.id);});
        make('strong',displayText(item.event_name||item.inquiry_number||'イベント名未設定'),action);
        make('small',label+' / '+statusText(item),action);
      }
      if(!rows.length)make('p','この日の保存済み案件はありません。',list);
      undated.textContent=view.undated?'開催日未定 '+view.undated+'件（案件一覧で確認できます）':'';
      undated.hidden=!view.undated;
    };
    render();
    document.body.append(target);target.showModal();
  }
  return {open,close};
}
