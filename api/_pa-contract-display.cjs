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
function postAcceptanceTerms(s,bank){
 const heading='\n\n支払条件\n',start=s.terms_text.indexOf(heading);
 const tail=['\n\nその他のご確認事項\n','\n\nご依頼にあたっての確認事項\n'].map(v=>s.terms_text.indexOf(v,start+heading.length)).find(v=>v>=0);
 if(start<0||tail===undefined)throw Error('receipt_payment_unreadable');
 const standard=s.payment_summary==='イベント終了後14日以内。期限日が金融機関休業日の場合は翌営業日。';
 // Custom/historical agreements retain their persisted payment facts; never replace them with new defaults.
 const agreed=String(s.payment_terms||'').split('\n\n').filter(p=>!p.startsWith('行政機関、法人、団体等で所定の会計手続きにより')&&!p.startsWith('請求書は原則としてPDF')).join('\n\n');
 const payment=[s.payment_due_date?`お支払期限：${japaneseDate(s.payment_due_date)}`:'',standard?'お支払方法：銀行振込\n振込手数料：お客様負担':agreed].filter(Boolean).join('\n');
 const transfer=bank?`お振込先\n銀行名：${bank.bank}\n支店名：${bank.branch}\n預金種別：${bank.type}\n口座番号：${bank.number}\n口座名義：${bank.holder}`:'お振込先：最終見積書をご確認ください。';
 return s.terms_text.slice(0,start)+'\n\nお支払いについて\n'+payment+'\n\n'+transfer+s.terms_text.slice(tail);
}
module.exports={honorific,japaneseDate,amount,receiptBody,postAcceptanceTerms};
