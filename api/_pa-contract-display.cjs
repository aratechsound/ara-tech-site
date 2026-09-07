// Presentation only: never normalize or replace persisted snapshot values.
const honorific=name=>{const value=String(name||'').trim();return /(?:様|御中|殿|先生|各位)$/.test(value)?value:`${value} 様`;};
function japaneseDate(value,weekday=true){
 const date=new Date(`${value}T00:00:00Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(+date)||date.toISOString().slice(0,10)!==value)return String(value||'');
 return `${date.getUTCFullYear()}年${date.getUTCMonth()+1}月${date.getUTCDate()}日${weekday?'（'+'日月火水木金土'[date.getUTCDay()]+'）':''}`;
}
const amount=value=>`${Number(value).toLocaleString('ja-JP')}円（税込）`;
function receiptBody(s){
 return `${honorific(s.customer_name)}\n\nお世話になっております。\nARA-TECHの荒殿です。\n\n${japaneseDate(s.event_date,false)}開催の\n「${s.event_name}」につきまして、\n正式なご依頼を承りました。\n\n契約控えPDFを添付しておりますので、\n内容をご確認のうえ保管をお願いいたします。\n\n開催日：${japaneseDate(s.event_date)}\nご依頼金額：${amount(s.amount)}\n${s.payment_due_date?'お支払期限：'+japaneseDate(s.payment_due_date):'お支払条件：'+s.payment_terms}\n\n今後、出演者資料や進行内容等につきましては、\n決まり次第お送りいただければ大丈夫です。\n\n引き続きよろしくお願いいたします。\n\nARA-TECH\n荒殿 竜一`;
}
module.exports={honorific,japaneseDate,amount,receiptBody};
