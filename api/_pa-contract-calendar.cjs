// Cabinet Office published calendar, checked 2026-09-08.
// https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
// Bank closures additionally include weekends and December 31-January 3.
// Do not extrapolate unpublished equinoxes/one-off holidays: fail closed.
const CALENDAR_VERSION='JP-BANK-2026-2027-20260908';
const holidays={
 2026:'01-01 01-12 02-11 02-23 03-20 04-29 05-03 05-04 05-05 05-06 07-20 08-11 09-21 09-22 09-23 10-12 11-03 11-23',
 2027:'01-01 01-11 02-11 02-23 03-21 03-22 04-29 05-03 05-04 05-05 07-19 08-11 09-20 09-23 10-11 11-03 11-23'
};
function date(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('invalid_payment_date');
 const d=new Date(value+'T00:00:00Z');
 if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value)throw Error('invalid_payment_date');
 return d;
}
const iso=d=>d.toISOString().slice(0,10);
function nextBankDay(value){
 const d=date(value);
 for(let n=0;n<15;n++,d.setUTCDate(d.getUTCDate()+1)){
  const calendar=holidays[d.getUTCFullYear()];if(!calendar)throw Error('payment_calendar_unavailable');
  const md=iso(d).slice(5);
  if(![0,6].includes(d.getUTCDay())&&!calendar.split(' ').includes(md)&&!['12-31','01-01','01-02','01-03'].includes(md))return iso(d);
 }
 throw Error('payment_calendar_unavailable');
}
function paymentDeadline(eventDate,approvedDate=''){
 const event=date(eventDate);
 if(approvedDate){const d=date(approvedDate);if(d<event)throw Error('invalid_payment_date');return {payment_due_date:iso(d),payment_due_basis:'approved_exact_date'};}
 event.setUTCDate(event.getUTCDate()+14);
 const nominal=iso(event);
 return {payment_due_date:nextBankDay(nominal),payment_nominal_due_date:nominal,payment_due_basis:'event_plus_14_next_bank_day',payment_calendar_version:CALENDAR_VERSION};
}
function cancellationBands(eventDate){
 const d=date(eventDate),day=n=>iso(new Date(+d-n*86400000));
 return [{label:'31日前まで',rate:0,from:null,to:day(31)},{label:'30〜8日前',rate:30,from:day(30),to:day(8)},{label:'7〜2日前',rate:50,from:day(7),to:day(2)},{label:'前日・当日',rate:100,from:day(1),to:day(0)}];
}
module.exports={paymentDeadline,cancellationBands,nextBankDay,CALENDAR_VERSION};
