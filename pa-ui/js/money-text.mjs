// Pure text protection shared by the existing DOM privacy module and its tests.
const number='[\\d,]+(?:\\.\\d+)?(?:[万億兆])?';
const range=number+'(?:\\s*[-〜～–]\\s*'+number+')?';
const pattern=new RegExp('[¥￥$€£]\\s*'+range+'(?:円)?|'+range+'\\s*(?:円|JPY|USD|EUR|GBP)(?![A-Za-z])|(?:JPY|USD|EUR|GBP)\\s*'+range,'giu');
const labelled=new RegExp('((?:金額|料金|代金|費用|予算|価格|見積額|請求額)\\s*[:：]?\\s*)('+range+')','giu');
export function protectMoneyText(value,tokenFor){return String(value??'').replace(pattern,tokenFor).replace(labelled,(_all,label,amount)=>label+tokenFor(amount));}
